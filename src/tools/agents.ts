/** Spawning, delegating and following agents. Registered from `setup()` in `src/index.ts`. */
import { lastAssistantText, type SpawnedAgent } from "../orchestrator"
import { TEMPLATES, instantiateTemplate, listTemplates } from "../templates"
import { resolve } from "node:path"
import type { ToolEditor, ToolDeps } from "./deps"

export function registerAgentsTools(editor: ToolEditor, deps: ToolDeps): void {
  const { ctx, orchestrator, spawnAndDeliver, persistState } = deps

  editor.add({
    name: "spawn",
    description: "Delegate one task to a Nexus sub-agent. By default it runs in the background and returns immediately with the session id plus the model and complexity chosen for it — collect the outcome later with nexus.result(sessionID). Pass wait:true to block until it finishes and get the result inline, or just use nexus.delegate for that. Prefer this over the built-in subagent/task tool when the work should be tracked by Nexus: it routes the role to its configured model, charges it against this run's cost budget, records it in the execution history, and links the child session to this one. Returns the agent name, task preview and session id, plus model and complexity info (non-wait) or the agent's full result (wait:true).",
    input: {
      type: "object",
      properties: {
        role: { type: "string", description: "Agent role (architect, coder, reviewer, tester, explorer, documenter, designer). 'designer' decides UI/UX direction (layout, hierarchy, loading/empty/error states, copy) and writes a direction a coder implements — it never writes code itself." },
        task: { type: "string", description: "Task description" },
        model: { type: "string", description: "Model override (optional), as 'providerID/modelID' or 'providerID/modelID#variant' (e.g. 'anthropic/claude-sonnet-4-6#high'). The delimiter is a hash, not an at-sign. A bare model id is auto-completed against the configured models and throws if none matches." },
        wait: { type: "boolean", description: "Wait for completion (default: false)" },
        timeout: { type: "number", description: "Timeout in ms when waiting (default: 120000)" }
      },
      required: ["role", "task"],
      additionalProperties: false
    },
    options: { codemode: true },
    execute: async (input: unknown, toolCtx: any) => {
      const { role, task, model, wait, timeout } = input as { role: string; task: string; model?: string; wait?: boolean; timeout?: number }
      // Held OUTSIDE the try so the catch below can settle it. The agent is
      // in `orchestrator.agents` from the moment `spawnAgent` returns, and
      // this block marks it `working`; every exit that is not a deliberate
      // settle — a `session.wait` that rejects, a throw from any read, a
      // failing `storage.set` — used to leave it at `working` in
      // `getState().agents` for the rest of the process. A finished agent
      // that still claims to be working is a lie the page cannot see
      // through, so the failure path settles it rather than leaking it.
      let spawned: SpawnedAgent | null = null
      try {
        const agent = await spawnAndDeliver({ role, task, model }, toolCtx)
        spawned = agent

        agent.status = 'working'
        orchestrator.notifyStateChange()

        // If wait is requested, block until completion or timeout
        if (wait) {
          const waitTimeout = timeout || 120000
          const waitPromise = ctx.session.wait({ sessionID: agent.sessionID! })
          // A TIMEOUT and a REJECTED POLL arrive at the same `catch` and
          // mean opposite things, so they are tagged apart here rather than
          // conflated below. A timeout is our own deadline firing: the
          // session was never told to stop and may still be generating. A
          // rejection is `session.wait` itself dying — an aborted, evicted
          // or unknown session — and a dead poll is not a running session,
          // which is the distinction `executeTask` already draws when it
          // wraps the same call in a guard that cannot reject.
          const timeoutPromise = new Promise((_, reject) => {
            const expiry = new Error(`Timed out after ${waitTimeout}ms`)
            ;(expiry as Error & { nexusTimedOut?: boolean }).nexusTimedOut = true
            setTimeout(() => reject(expiry), waitTimeout)
          })

          try {
            await Promise.race([waitPromise, timeoutPromise])
          } catch (waitError: any) {
            // A TIMEOUT means the session may still be running, and
            // `working` is the honest status for it — left alone on
            // purpose. A REJECTED POLL means the wait itself died, and no
            // status here can be trusted to survive: this agent is not
            // working, and publishing it as though it were is the stuck-
            // `working` row from issue #100. What it settled AS depends on
            // whether the session produced anything, so the settle happens
            // at each exit below rather than here — one settle per outcome,
            // whichever is actually known.
            const pollDied = !(waitError as Error & { nexusTimedOut?: boolean })?.nexusTimedOut
            if (!pollDied) agent.status = 'working'
            orchestrator.notifyStateChange()

            // Try to get whatever results are available
            try {
              const messages = await ctx.session.context({ sessionID: agent.sessionID! })
              const partialText = lastAssistantText(messages)
              if (partialText) {
                if (pollDied) orchestrator.settleAgent(agent.id, 'completed')
                await persistState()
                const taskPreview = task.length > 80 ? task.substring(0, 77) + '...' : task
                return {
                  content: [
                    `${agent.name}`,
                    `📋 Task: ${taskPreview}`,
                    `⏱️ Status: ${waitError.message || 'timeout'}`,
                    `📎 Session: ${agent.sessionID}`,
                    `\n--- Partial Result ---`,
                    partialText
                  ].join('\n')
                }
              }
            } catch {
              // Context read also failed
            }

            if (pollDied) orchestrator.settleAgent(agent.id, 'failed')
            return {
              content: [
                `${agent.name}`,
                `📋 Task: ${task.length > 80 ? task.substring(0, 77) + '...' : task}`,
                `⏱️ Status: ${waitError.message || 'timeout'}`,
                `📎 Session: ${agent.sessionID}`,
                `💡 Use nexus.result(sessionID="${agent.sessionID}") to check later`
              ].join('\n')
            }
          }

          // Wait completed — get final results
          try {
            const messages = await ctx.session.context({ sessionID: agent.sessionID! })
            const result = lastAssistantText(messages) || 'Task completed (no output captured)'

            orchestrator.settleAgent(agent.id, 'completed')
            await persistState()

            const taskPreview = task.length > 80 ? task.substring(0, 77) + '...' : task
            return {
              content: [
                `${agent.name}`,
                `📋 Task: ${taskPreview}`,
                `✅ Status: completed`,
                `📎 Session: ${agent.sessionID}`,
                `\n--- Result ---`,
                typeof result === 'string' ? result : JSON.stringify(result)
              ].join('\n')
            }
          } catch {
            // Context read failed after successful wait
            orchestrator.settleAgent(agent.id, 'completed')
            await persistState()
            return {
              content: [
                `${agent.name}`,
                `✅ Status: completed`,
                `📎 Session: ${agent.sessionID}`,
                `⚠️ Could not read result output`
              ].join('\n')
            }
          }
        }

        // Non-wait: return spawn info with complexity analysis
        //
        // `working` is left in place deliberately, and is the one case where
        // that is honest rather than a leak: this tool has NOT been told the
        // session finished, and a non-wait spawn has no waiter to hear it.
        // The caller is pointed at `nexus.result()`, which is the surface
        // that reports the outcome. Inventing a terminal status here would
        // be a worse lie than a running row.
        const complexity = orchestrator.analyzeComplexity({
          id: `spawn-${Date.now()}`,
          name: task,
          description: task,
          files: { include: [] },
          dependencies: [],
          requiredRole: role,
          complexity: { overall: 0, factors: { fileCount: 0, codeLines: 0, dependencyDepth: 0, domainKnowledge: 0, riskLevel: 'low' } },
          priority: 'normal',
          status: 'running'
        })
        agent.complexity = complexity

        const modelSelection = orchestrator.selectModel(role, complexity)

        await persistState()
        const taskPreview = task.length > 80 ? task.substring(0, 77) + '...' : task
        const output = [
          `${agent.name}`,
          `📋 Task: ${taskPreview}`,
          `📊 Complexity: ${complexity.overall}/100 (${complexity.factors.riskLevel} risk)`,
          `🤖 Model reasoning: ${modelSelection.reasoning}`,
          `📎 Session: ${agent.sessionID}`,
          `💡 Use wait=true to wait for completion, or nexus.result() to fetch later`
        ].join('\n')
        return { content: output }
      } catch (error: any) {
        // The spawn itself never reached `spawned` on a spawn failure, and
        // there is then no agent in the map to settle. Once it HAS spawned,
        // this is a task that is over — by failure rather than by completion
        // — and leaving it at `working` is the bug this settles.
        if (spawned) orchestrator.settleAgent(spawned.id, 'failed')
        return { content: `Failed to spawn agent: ${error.message}` }
      }
    }
  })

  editor.add({
    name: "delegate",
    description: "Delegate one task to a Nexus sub-agent and BLOCK until it finishes, returning the agent's full output. This is exactly nexus.spawn with wait:true — the same role-to-model routing, cost budgeting, execution history and parent-session linking — so pick whichever reads better; use it when the result is a dependency of your next step, and nexus.spawn when it is not. Prefer both over the built-in subagent/task tool when the work should be tracked by Nexus. Returns the agent name, outcome (completed or timeout), session id, and the agent's full result text; on timeout the partial output is returned rather than discarded.",
    input: {
      type: "object",
      properties: {
        role: { type: "string", description: "Agent role (architect, coder, reviewer, tester, explorer, documenter, designer). 'designer' decides UI/UX direction (layout, hierarchy, loading/empty/error states, copy) and writes a direction a coder implements — it never writes code itself." },
        task: { type: "string", description: "Task description" },
        model: { type: "string", description: "Model override (optional), as 'providerID/modelID' or 'providerID/modelID#variant'. The delimiter is a hash, not an at-sign." },
        timeout: { type: "number", description: "Timeout in ms (default: 120000)" }
      },
      required: ["role", "task"],
      additionalProperties: false
    },
    options: { codemode: true },
    execute: async (input: unknown, toolCtx: any) => {
      const { role, task, model, timeout } = input as { role: string; task: string; model?: string; timeout?: number }
      // See the `spawn` tool's own note: the agent is in the map and marked
      // `working` before anything below can throw, and this catch is the
      // exit that used to leave it there. `session.wait` REJECTING is the
      // ordinary way in here — an aborted or gone session rejects rather
      // than timing out — and that is not a session still working, so it
      // must not keep reporting one.
      let spawned: SpawnedAgent | null = null
      try {
        const agent = await spawnAndDeliver({ role, task, model }, toolCtx)
        spawned = agent

        agent.status = 'working'
        orchestrator.notifyStateChange()

        const waitTimeout = timeout || 120000
        const waitPromise = ctx.session.wait({ sessionID: agent.sessionID! })
        const timeoutPromise = new Promise<'timeout'>((resolve) =>
          setTimeout(() => resolve('timeout'), waitTimeout)
        )

        const outcome = await Promise.race([waitPromise.then(() => 'completed' as const), timeoutPromise])

        // Get the result regardless of outcome
        try {
          const messages = await ctx.session.context({ sessionID: agent.sessionID! })
          const resultContent = lastAssistantText(messages) || (outcome === 'timeout' ? 'Timed out — agent may still be running' : 'Completed with no output')

          // `timeout` leaves the agent `working` and it is right to: the
          // session was never told to stop and is still spending. Only a
          // completed wait is an outcome, and it settles like every other.
          if (outcome === 'completed') orchestrator.settleAgent(agent.id, 'completed')
          else agent.status = 'working'
          orchestrator.notifyStateChange()
          await persistState()

          const statusIcon = outcome === 'timeout' ? '⏱️' : '✅'
          return {
            content: [
              `${agent.name}`,
              `📋 Task: ${task.length > 80 ? task.substring(0, 77) + '...' : task}`,
              `${statusIcon} Status: ${outcome}`,
              `📎 Session: ${agent.sessionID}`,
              `\n--- Result ---`,
              typeof resultContent === 'string' ? resultContent : JSON.stringify(resultContent)
            ].join('\n')
          }
        } catch {
          if (outcome === 'completed') orchestrator.settleAgent(agent.id, 'completed')
          else agent.status = 'working'
          orchestrator.notifyStateChange()
          return {
            content: [
              `${agent.name}`,
              `${outcome === 'timeout' ? '⏱️' : '✅'} Status: ${outcome}`,
              `📎 Session: ${agent.sessionID}`,
              `⚠️ Could not read result output`
            ].join('\n')
          }
        }
      } catch (error: any) {
        // See the `spawn` tool's catch. A rejected `session.wait` lands here
        // and the agent is not working any more.
        if (spawned) orchestrator.settleAgent(spawned.id, 'failed')
        return { content: `Delegate failed: ${error.message}` }
      }
    }
  })

  editor.add({
    name: "template",
    description: "List or instantiate task templates",
    input: {
      type: "object",
      properties: {
        name: { type: "string", description: "Template name to instantiate (or 'list' to show all)" },
        baseDir: { type: "string", description: "Base directory for file paths" }
      },
      additionalProperties: false
    },
    options: { codemode: true },
    execute: async (input: unknown) => {
      const { name, baseDir } = input as { name?: string; baseDir?: string }
      if (!name || name === 'list') {
        const templates = listTemplates()
        return { content: templates.map(t => `${t}: ${TEMPLATES[t].description}`).join('\n') }
      }
      try {
        const tasks = instantiateTemplate(name, baseDir || process.cwd())
        return { content: JSON.stringify(tasks, null, 2) }
      } catch (error: any) {
        return { content: `Error: ${error.message}` }
      }
    }
  })

  editor.add({
    name: "sessions",
    description: "List all active Nexus agent sessions",
    input: { type: "object", properties: {}, additionalProperties: false },
    options: { codemode: true },
    execute: async () => {
      const agents = orchestrator.getState().agents
      if (agents.length === 0) return { content: "No active agent sessions." }
      const lines = agents.map((a: any) => {
        const statusIcon = a.status === 'working' ? '🔄' : a.status === 'idle' ? '⏸️' : a.status === 'completed' ? '✅' : '❌'
        return `${statusIcon} ${a.name} (${a.role}) — Session: ${a.sessionID}`
      })
      return { content: `Active Sessions (${agents.length}):\n${lines.join('\n')}` }
    }
  })

  editor.add({
    name: "background",
    description: "Move running agents to background (detach from current session)",
    input: { type: "object", properties: {}, additionalProperties: false },
    options: { codemode: true },
    execute: async () => {
      // Nothing to do comes first: with no agents running, "No running
      // agents" is the truthful answer even on a build that lacks
      // `session.background`.
      const agents = orchestrator.getState().agents.filter((a: any) => a.status === 'working' || a.status === 'idle')
      if (agents.length === 0) return { content: "No running agents to move to background." }

      // `background` exists on the underlying client `SessionApi` but the
      // plugin context's `SessionDomain` is a `Pick` that omits it, so it
      // cannot be typed directly and is feature-detected through a narrow
      // structural lookup instead of assumed to be there.
      const background = (ctx.session as { background?: (input: { sessionID: string }) => Promise<void> }).background
      if (!background) {
        return { content: "This OpenCode version does not expose session.background on the plugin context — nothing was detached." }
      }

      let detached = 0
      for (const agent of agents) {
        if (!agent.sessionID) continue
        try {
          await background.call(ctx.session, { sessionID: agent.sessionID })
          detached++
        } catch {
          // Background may not be supported in all contexts
        }
      }
      return { content: `${detached} agent(s) moved to background. You can continue working while they run.` }
    }
  })

  editor.add({
    name: "result",
    description: "Get the result of a completed agent session",
    input: {
      type: "object",
      properties: {
        sessionID: { type: "string", description: "Session ID of the agent" }
      },
      required: ["sessionID"]
    },
    options: { codemode: true },
    execute: async (input: unknown) => {
      const { sessionID } = input as { sessionID: string }
      try {
        const messages = await ctx.session.context({ sessionID })
        const text = lastAssistantText(messages)
        if (text) {
          return { content: `Session ${sessionID} result:\n${text}` }
        }
        return { content: `Session ${sessionID} has no assistant messages yet.` }
      } catch (error: any) {
        return { content: `Failed to get result: ${error.message}` }
      }
    }
  })

  editor.add({
    name: "clarify",
    description: "Ask clarifying question before proceeding with ambiguous task",
    input: {
      type: "object",
      properties: {
        question: { type: "string", description: "The clarifying question to ask" },
        options: { type: "string", description: "Comma-separated options to present" },
        assumption: { type: "string", description: "Default assumption if no response" }
      },
      required: ["question"],
      additionalProperties: false
    },
    options: { codemode: true },
    execute: async (input: unknown) => {
      const { question, options, assumption } = input as { question: string; options?: string; assumption?: string }
      const optionList = options ? options.split(',').map(o => o.trim()) : []
      let response = `❓ ${question}`
      if (optionList.length > 0) {
        response += `\nOptions: ${optionList.map((o, i) => `${i+1}. ${o}`).join(', ')}`
      }
      if (assumption) {
        response += `\n💡 Default: ${assumption}`
      }
      return { content: response }
    }
  })
}
