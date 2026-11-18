import { Plugin, type Skill } from "@opencode/plugin"
import { NexusOrchestrator, lastAssistantText, type NexusModelCost, type SpawnedAgent } from "./orchestrator"
import { PRESETS } from "./config"
import { describeListResult, describeSearchResult, describeSetResult } from "./memory-recall"
import type { MemoryScope } from "./types"
import { TEMPLATES, instantiateTemplate, listTemplates } from "./templates"
import { GoalManager } from "./goal"
import { TeamManager } from "./team"
import { AstGrep } from "./astgrep"
import { keptModifiedWarning, loadNexusSkills, nexusSkillsDir, registerNexusSkills, retireInstalledSkills, type SkillRetireResult, type UnavailableSkill } from "./skills-install"
import { NexusRpc, runNexusCommand } from "./rpc"
import { applyBudgetGate } from "./permission-gate"
import { createCoalescingWriter, toStorageJson } from "./state-persister"
import { applyCompactionNote, buildCompactionNote } from "./compaction-note"
import { writeFileSync, mkdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { homedir } from "node:os"
import type { PerformanceScore } from "./performance"
import { renderCost, renderCostBasis, renderModelCostReport } from "./cost-report"
import { watchConfigFiles } from "./config-watch"
import { DASHBOARD_START_DESCRIPTION, DASHBOARD_STOP_DESCRIPTION, NOTIFICATIONS_TEST_DESCRIPTION, runNotificationsTest, runDashboardStart, runDashboardStop } from "./tools/dashboard-actions"
import { readNexusAgent, readNexusSubagents, buildGitFlowConventionSection } from "./agent-files"
import { clearPresetOverride } from "./tools/preset-actions"

/**
 * Report the skill setup, one line per outcome the user needs to know about.
 *
 * Extracted from `plugin.setup` so the message text and the silence on the
 * quiet outcomes are assertable against real results without booting the
 * plugin. Never throws: failing to report must not be a second way for skill
 * setup to fail.
 *
 * Two outcomes are reported:
 * - a shipped skill that could not be read. That is the feature failing
 *   silently otherwise, and `docs/COMPATIBILITY.md` claims skills are supported.
 * - a global copy from an earlier version that was kept because it was edited.
 *   It now overrides the shipped skill and no longer updates, which the user
 *   should hear once rather than discover.
 *
 * `removed` and `absent` are silent: removing an unmodified copy loses nothing,
 * and `absent` is the steady state after the first load of this version.
 */
export function reportSkillSetup(
  unavailable: readonly UnavailableSkill[],
  retired: readonly SkillRetireResult[],
): void {
  for (const { name, path, reason } of unavailable) {
    console.warn(`[nexus] Skill ${name} ${reason}; it was not registered (${path})`)
  }
  for (const { name, path, action } of retired) {
    if (action === 'kept-modified') console.warn(keptModifiedWarning(name, path))
  }
}

export default Plugin.define({
  id: "nexus",
  async setup(ctx) {
    // Held here rather than written here: the git convention section appended to
    // each file depends on the RESOLVED config and the detected git state, and
    // neither exists until the orchestrator has loaded `nexus.jsonc` and run
    // detection. The write happens below, after `initialize()`; the content does
    // not move with it.
    const subagents: Record<string, string> = {}

    // Auto-create nexus-orchestrator agent if it doesn't exist
    try {
      const agentDir = join(homedir(), '.config', 'opencode', 'agents')
      mkdirSync(agentDir, { recursive: true })

      // Create primary orchestrator agent — always update to latest version
      const orchestratorFile = join(agentDir, 'nexus-orchestrator.md')
      writeFileSync(orchestratorFile, readNexusAgent('nexus-orchestrator.md'), 'utf-8')

      // Create subagent files for Nexus roles — always update to latest version
      Object.assign(subagents, readNexusSubagents())
    } catch (error) {
      // Best-effort: an unwritable home must not stop the plugin loading. But
      // SILENTLY best-effort is what this used to be, and the two failures it
      // swallowed are not equally quiet.
      //
      // A WRITE failing leaves the agent files absent, which is visible — the
      // roles simply are not there. A READ failing means `readNexusSubagents`
      // threw the named missing path precisely so a broken publish would say
      // which file is absent, and that message used to die in this catch:
      // `subagents` stayed empty, the loop below installed zero role files, and
      // the failure surfaced much later as a wrong-agent spawn on
      // `nexus.spawn` — the exact late failure the throw exists to prevent.
      //
      // So the error is reported, not swallowed. One line, and it is the only
      // way that docstring's promise is kept.
      console.error('[nexus] could not install Nexus agent definitions:', error instanceof Error ? error.message : error)
    }

    const orchestrator = new NexusOrchestrator()
    const goalManager = new GoalManager()

    // Write the subagent files, now that `gitFlow` has resolved against the
    // loaded config and the checkout has been inspected.
    //
    // These files are rewritten on EVERY plugin load (documented in 2.9.0,
    // because a hand-edit is destroyed at the next start), which is what makes
    // this the durable place for a convention: there is nowhere else in the
    // system a convention could live and survive a restart.
    //
    // THE FRICTION THIS ACCEPTS, stated plainly: these files live in the user's
    // GLOBAL `~/.config/opencode/agents` and are therefore shared by every
    // project they run nexus in. Injecting repo-specific guidance into a shared
    // file is not project-scoped, and two projects open at once will overwrite
    // each other's copy. That is a real limitation, not a hypothetical.
    //
    // The choice is to CONDITION on the detected state rather than always
    // inject. Outside a work tree — and on a detached HEAD, which cannot hold a
    // branch at all — the files come out byte-identical to what 2.9.0 wrote, so
    // a user with no repository sees no change and the section never asserts a
    // repo-specific fact it cannot see. The costs are stated rather than
    // hidden: the convention is ABSENT in a repository whose state detection
    // failed, and two projects disagree about the shared file's contents.
    // Conditioning was chosen over an unconditional section because telling an
    // agent to work on a branch in a directory that has no branches is the kind
    // of confidently wrong instruction that costs a user an afternoon, and a
    // generic always-on section would have to be vague enough to be true in both
    // cases — which would make it too weak to be a convention at all.
    try {
      const gitState = orchestrator.getGitState()
      const gitFlowResolved = orchestrator.resolveGitFlow()
      const gitFlowSection = gitFlowResolved.active && gitState.isRepo && !gitState.detached
        ? buildGitFlowConventionSection(gitFlowResolved.config, gitState)
        : null

      const agentDir = join(homedir(), '.config', 'opencode', 'agents')
      for (const [filename, content] of Object.entries(subagents)) {
        // Appended, never spliced into the role prose: a convention that
        // rewrote the body would collide with the next release's version of that
        // body, and the section is by construction independent of which role
        // reads it.
        writeFileSync(join(agentDir, filename), gitFlowSection ? `${content}\n\n${gitFlowSection}` : content, 'utf-8')
      }
    } catch {
      // Best-effort, exactly as the primary agent file is. A convention layer
      // that can prevent the agent files from being written is a convention
      // layer that has broken something else to add guidance.
    }

    // The `nexus-*` design skills, registered with OpenCode rather than copied
    // into `~/.config/opencode/skills`. See `src/skills-install.ts` for why, and
    // for why a skill the user already has with the same id wins.
    //
    // Retiring the unmodified copies earlier versions installed comes first, so
    // those copies are gone before the transform asks whether a skill with the
    // same id exists. Both halves are best-effort: skills are guidance, and
    // failing to set them up must never stop the orchestrator starting.
    let shippedSkills: ReturnType<typeof loadNexusSkills>["skills"] = []
    try {
      const retired = retireInstalledSkills(nexusSkillsDir(), homedir())
      const loaded = loadNexusSkills(nexusSkillsDir())
      shippedSkills = loaded.skills
      reportSkillSetup(loaded.unavailable, retired)
    } catch (error: unknown) {
      console.warn(`[nexus] could not read the Nexus skills: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      await ctx.skill.transform((editor) => {
        registerNexusSkills(editor, shippedSkills, (skill) => ({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          path: skill.path,
          content: skill.content,
        }) as unknown as Skill.Info)
      })
    } catch (error: unknown) {
      console.warn(`[nexus] could not register the Nexus skills: ${error instanceof Error ? error.message : String(error)}`)
    }

    // The one writer of the persisted orchestrator snapshot. See
    // `src/state-persister.ts` for why every write goes through it, and why the
    // `nexus-sidebar-state` key this used to write as well is gone.
    const persistState = createCoalescingWriter(
      () => ctx.storage.set("orchestrator-state", toStorageJson(orchestrator.getState()) as any),
      (error) => console.warn(`[nexus] could not persist orchestrator state: ${error instanceof Error ? error.message : String(error)}`),
    )

    // Initialize orchestrator with OpenCode context for real session API access.
    // The state-change callback is already debounced by the orchestrator.
    await orchestrator.initialize(ctx, () => { void persistState() })

    await persistState()

    /**
     * Create a child session and make sure the task reaches it exactly once.
     * Shared by the `spawn` and `delegate` tools.
     *
     * The parent session is taken from the calling tool's own execution context:
     * it is what OpenCode links the child session to (parentID), and it is passed
     * explicitly rather than latched on the orchestrator, which would let
     * internal spawns reuse a foreign parent session. On the subagent-tool path
     * the tool itself delivers the task, so the manual `session.prompt` below
     * only runs on the `session.create` fallback.
     */
    const spawnAndDeliver = async (
      opts: { role: string; task: string; model?: string },
      toolCtx: any,
    ): Promise<SpawnedAgent> => {
      const agent = await orchestrator.spawnAgent({ role: opts.role, model: opts.model }, {
        toolContext: {
          sessionID: toolCtx?.sessionID || '',
          agent: toolCtx?.agent,
          messageID: toolCtx?.messageID,
          callID: toolCtx?.id,
          signal: toolCtx?.signal,
        },
        task: opts.task,
      })

      if (agent.spawnPath !== 'subagent-tool') {
        await ctx.session.prompt({
          sessionID: agent.sessionID!,
          // `agent.deliveredText`, NOT `opts.task`. This fallback re-delivers
          // the task itself, and `spawnAgent` composes any recollection block
          // into the text it delivers on the subagent-tool path. Sending
          // `opts.task` here sent the caller's original string and dropped the
          // block, so the degraded spawn — already the one flagged as
          // `lastDegradedSpawn` — was also the one spawn that recalled nothing.
          //
          // Falls back to `opts.task` so a caller that built its own agent
          // object cannot make this send `undefined`.
          text: agent.deliveredText ?? opts.task
        })
      }

      return agent
    }

    // Register tools
    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "nexus",
        description: "Adaptive multi-agent orchestration tools"
      })

      editor.add({
        name: "status",
        description: "Get orchestrator status, metrics, and the config files currently in effect (paths consulted, which existed, resolved role -> model map)",
        input: {
          type: "object",
          properties: {
            detailed: { type: "boolean", description: "Include detailed metrics" }
          },
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { detailed } = input as { detailed?: boolean }
          const status = orchestrator.getStatus(detailed)
          return { content: status }
        }
      })

      editor.add({
        name: "agents",
        description: "List all active agents",
        input: {
          type: "object",
          properties: {
            filter: { type: "string", description: "Filter by status" }
          },
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { filter } = input as { filter?: string }
          return { content: orchestrator.listAgents(filter) }
        }
      })

      editor.add({
        name: "costs",
        description: "Get cost report and budget status",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async () => {
          return { content: orchestrator.getCostReport() }
        }
      })

      editor.add({
        name: "notifications.test",
        description: NOTIFICATIONS_TEST_DESCRIPTION,
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async () => {
          return { content: await runNotificationsTest(orchestrator) }
        }
      })

      editor.add({
        name: "dashboard",
        description: "Get full orchestrator state for dashboard display",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async () => {
          const state = orchestrator.getState()
          return { content: JSON.stringify(state, null, 2) }
        }
      })

      editor.add({
        name: "queue",
        description: "Show current task queue with priorities",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async () => {
          const state = orchestrator.getState()
          const tasks = state.tasks || []
          return { content: JSON.stringify(tasks, null, 2) }
        }
      })

      editor.add({
        name: "config.save",
        description: "Save Nexus config to disk (project or global)",
        input: {
          type: "object",
          properties: {
            level: { type: "string", enum: ["project", "global"], description: "Config level to save" },
            basePath: { type: "string", description: "Project root (for project-level, defaults to cwd)" }
          },
          required: ["level"],
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { level, basePath } = input as { level: 'project' | 'global'; basePath?: string }
          orchestrator.configManager.saveConfig(level, basePath || process.cwd())
          const location = level === 'project'
            ? `${basePath || process.cwd()}/.opencode/nexus.jsonc`
            : '~/.config/opencode/nexus.jsonc'
          return { content: `Config saved to ${level} level at ${location}` }
        }
      })

      editor.add({
        name: "config.init",
        description: "Initialize default config files for project and/or global",
        input: {
          type: "object",
          properties: {
            level: { type: "string", enum: ["project", "global", "both"], description: "Which config to initialize" },
            basePath: { type: "string", description: "Project root" }
          },
          required: ["level"],
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { level, basePath } = input as { level: 'project' | 'global' | 'both'; basePath?: string }
          const path = basePath || process.cwd()
          const locations: string[] = []
          if (level === 'project' || level === 'both') {
            orchestrator.configManager.initProjectConfig(path)
            locations.push(`${path}/.opencode/nexus.jsonc`)
          }
          if (level === 'global' || level === 'both') {
            orchestrator.configManager.initGlobalConfig()
            locations.push('~/.config/opencode/nexus.jsonc')
          }
          return { content: `Config initialized at ${level} level(s): ${locations.join(', ')}` }
        }
      })

      editor.add({
        name: "preset",
        description: "Apply a session preset (model/budget selection), or clear it with mode 'clear' to hand control back to nexus.jsonc. A preset shadows the config file's models, so call mode 'clear' if the user edited nexus.jsonc but no model changed.",
        input: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["apply", "clear"],
              description: "'apply' (default) applies the named preset for this session. 'clear' drops the session preset override so nexus.jsonc is in control again — use it whenever edits to nexus.jsonc appear to have no effect."
            },
            name: {
              type: "string",
              description: "Preset name (minimal, balanced, enterprise, cost-optimized). Required for mode 'apply'; ignored by 'clear'."
            }
          },
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { mode, name } = input as { mode?: 'apply' | 'clear'; name?: string }

          if (mode === 'clear') return clearPresetOverride(orchestrator)

          if (!name) {
            // Do not silently do nothing: a missing name is a mistake, and the
            // fix is either a valid preset name or mode 'clear'.
            return { content: `Error: mode 'apply' needs a \`name\` (${orchestrator.configManager.listPresets().join(', ')}). To hand control back to nexus.jsonc instead, call preset with mode: 'clear'.` }
          }
          try {
            orchestrator.configManager.applyPreset(name)
            // A preset replaces the whole models level, so it now shadows
            // nexus.jsonc. Say that here, at the moment the user is told the
            // preset was applied — otherwise a later edit that does nothing is
            // the same silent surprise as a missing reload.
            return {
              content: `Applied preset: ${PRESETS[name]?.name || name}\n`
                + `⚠️ This preset now overrides the \`models\` section of nexus.jsonc. `
                + `Edits to models in the config file will NOT take effect until the preset is cleared. `
                + `Clear it with this tool (mode: 'clear'), or from the TUI (config manager), to hand control back to disk. `
                + `Budget and self-healing values from the file still apply.`,
            }
          } catch (error: any) {
            return { content: `Error: ${error.message}` }
          }
        }
      })

      editor.add({
        name: "dashboard.start",
        description: DASHBOARD_START_DESCRIPTION,
        input: {
          type: "object",
          properties: {
            port: { type: "number", description: "Port to listen on (default: 4747, or `dashboard.port` from nexus.jsonc). Must be free." },
            host: { type: "string", description: "Bind address (default: 127.0.0.1, or `dashboard.host` from nexus.jsonc)" }
          },
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { port, host } = input as { port?: number; host?: string }
          return { content: runDashboardStart(orchestrator, port, host) }
        }
      })

      editor.add({
        name: "dashboard.stop",
        description: DASHBOARD_STOP_DESCRIPTION,
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async () => {
          return { content: runDashboardStop(orchestrator) }
        }
      })

      editor.add({
        name: "model.costs",
        description: "Show real model pricing from OpenCode, or set custom costs. All prices are USD per 1K tokens.",
        input: {
          type: "object",
          properties: {
            model: { type: "string", description: "Model to show cost for, as 'provider/id', 'provider/id#variant', or a bare 'id' (optional, shows all if omitted). A '#variant' is priced as the underlying model: variants carry no price of their own, so effort changes token volume, not rate." },
            setInput: { type: "number", description: "Set input cost in USD per 1K tokens for a model (e.g. 0.003 for $3 per million tokens)" },
            setOutput: { type: "number", description: "Set output cost in USD per 1K tokens for a model (e.g. 0.015 for $15 per million tokens)" }
          },
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { model, setInput, setOutput } = input as { model?: string; setInput?: number; setOutput?: number }

          // Every price `modelCosts` holds is USD per 1K tokens.
          const per1k = (v: number) => `$${v}/1K tokens`

          // A tiered price list, rendered one line per row. `tiers` is ordered
          // untiered-base-first by `loadModelCosts` / `setModelCosts`, and a
          // context tier is labelled with the prompt size it applies ABOVE.
          const renderTiers = (cost: NexusModelCost): string =>
            cost.tiers
              .map(t => (t.threshold === undefined
                ? `base: in=${per1k(t.rates.input)}, out=${per1k(t.rates.output)}, cache_read=${per1k(t.rates.cacheRead)}, cache_write=${per1k(t.rates.cacheWrite)}`
                : `over ${t.threshold} prompt tokens: in=${per1k(t.rates.input)}, out=${per1k(t.rates.output)}, cache_read=${per1k(t.rates.cacheRead)}, cache_write=${per1k(t.rates.cacheWrite)}`))
              .join('\n            ')

          if (model && setInput !== undefined && setOutput !== undefined) {
            // Set custom cost
            orchestrator.setModelCosts({ [model]: { input: setInput, output: setOutput } })
            return { content: `Set ${model}: input=${per1k(setInput)}, output=${per1k(setOutput)}` }
          }

          if (model) {
            // Show specific model cost. `modelCosts` is keyed by
            // "providerID/id" but users type either that or a bare id, so
            // `getModelCost` resolves both.
            const cost = orchestrator.getModelCost(model)
            if (cost) {
              return { content: `${model} (real pricing, from OpenCode):\n            ${renderTiers(cost)}` }
            }
            // No real pricing. Source this from the forecaster so the number
            // carries the rate AND the table it came from: the old
            // `estimateModelCost` printed a bare `estimated $X/1K tokens` whose
            // X was not a price at all but the mean of a real rate and a
            // hand-tuned relative table entry. A number with no unit and no
            // provenance is the one output this tool must never produce.
            const { pricing, source } = orchestrator.forecaster.priceFor(model)
            const label = source === 'model-costs'
              ? 'real pricing'
              : source === 'fallback-table'
                ? 'ESTIMATE (fallback table, not provider pricing)'
                : 'ESTIMATE (unknown model — no table knows this rate)'
            return { content: `${model}: no real pricing data.\n            ${label}: in=${per1k(pricing.input)}, out=${per1k(pricing.output)}, cache_read=${per1k(pricing.cacheRead)}, cache_write=${per1k(pricing.cacheWrite)}` }
          }

          // Show all loaded costs, grouped by provider.
          //
          // Grouping and price text both come from `src/model-groups.ts`, the
          // same helpers the TUI picker uses, so the two surfaces cannot drift
          // apart. The display names come from the ORCHESTRATOR's catalogue
          // (`getProviderList`, loaded once at `initialize()`), not from a
          // `ctx.provider.list()` here: this tool used to run its own fetch on
          // every call, which meant the dashboard and this report were reading
          // two different snapshots of the same data and could print different
          // headings for the same models. One snapshot, one answer. The cost of
          // that is boot-time staleness, which is stated in `loadProviderNames`
          // and in the README.
          //
          // `renderTiers` is NOT used here: it prints four rates per tier and a
          // multi-line block per model, which is right for the single-model
          // report above and unreadable as a catalogue. The single-model branch
          // keeps it, and keeps its cache rates, so nothing this branch stops
          // showing is unreachable.
          return {
            content: renderModelCostReport(
              orchestrator.modelCosts,
              orchestrator.getProviderList(),
            )
          }
        }
      })

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
        name: "performance.scores",
        description: "Show agent performance scores by model and role",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async () => {
          const scores = orchestrator.performanceTracker.getScores()
          if (scores.length === 0) return { content: "No performance data yet. Scores build up as tasks are executed." }
          const lines = scores.map(s => `${s.role}/${s.model}: score=${s.overallScore.toFixed(1)} success=${(s.successRate*100).toFixed(0)}% ${renderCostBasis(s)} (${s.totalTasks} tasks)`)
          return { content: lines.join('\n') }
        }
      })

      editor.add({
        name: "performance.best",
        description: "Get best model for a specific role",
        input: {
          type: "object",
          properties: {
            role: { type: "string", description: "Agent role to find best model for" }
          },
          required: ["role"],
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { role } = input as { role: string }
          const best = orchestrator.performanceTracker.getBestModel(role)
          if (!best) return { content: `No performance data for role '${role}' yet.` }
          return { content: `Best for ${role}: ${best.model} (score: ${best.overallScore.toFixed(1)}, success: ${(best.successRate*100).toFixed(0)}%, ${renderCostBasis(best)})` }
        }
      })

      editor.add({
        name: "security.scan",
        description: "Scan content for security issues",
        input: {
          type: "object",
          properties: {
            content: { type: "string", description: "Code content to scan" },
            filename: { type: "string", description: "Filename for context" }
          },
          required: ["content"],
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { content, filename } = input as { content: string; filename?: string }
          const issues = orchestrator.securityScanner.scanContent(content, filename || 'unknown')
          const result = orchestrator.securityScanner.getResult()
          return { content: JSON.stringify({ issues: issues.length, score: result.score, details: issues }, null, 2) }
        }
      })

      editor.add({
        name: "history.list",
        description: "List execution history",
        input: {
          type: "object",
          properties: {
            count: { type: "number", description: "Number of recent entries" }
          },
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { count } = input as { count?: number }
          const records = count ? orchestrator.executionHistory.getRecent(count) : orchestrator.executionHistory.getAll()
          if (records.length === 0) return { content: "No execution history yet." }
          const lines = records.map(r => `${r.status === 'success' ? '✅' : '❌'} ${r.taskName} (${r.role}) — ${renderCost(r.cost, r.costProvenance)} — ${r.duration}ms`)
          return { content: lines.join('\n') }
        }
      })

      editor.add({
        name: "history.stats",
        description: "Show execution statistics",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async () => {
          const stats = orchestrator.executionHistory.getStats()
          // `totalCost` sums measured and estimated charges, so it is reported
          // with the split rather than on its own.
          return { content: `Total: ${stats.total} | Success: ${(stats.successRate * 100).toFixed(1)}% | Cost: $${stats.totalCost.toFixed(4)} (measured $${stats.costSplit.measuredCost.toFixed(4)} over ${stats.costSplit.measuredEntries} tasks, estimated $${stats.costSplit.estimatedCost.toFixed(4)} over ${stats.costSplit.estimatedEntries} tasks) | Avg: ${stats.avgDuration.toFixed(0)}ms\nBy role: ${JSON.stringify(stats.byRole)}` }
        }
      })

      // ── Memory ───────────────────────────────────────────────────────────
      //
      // Three tools, and the split between them is the point: `set` and
      // `search`/`list` are REACTIVE (an agent has to remember to call them,
      // and agents forget), while the recollection block injected at spawn is
      // PROACTIVE and is what makes a written note actually get used. These
      // tools are also the day-one value: the store ships EMPTY, so the
      // injection half recalls nothing for anyone until something is written
      // here.
      //
      // `scope` on `set` is a THREE-value enum, not the full `MemoryScope`,
      // and the two excluded values are excluded on purpose:
      //   - `session` is the orchestrator's own escalation-transfer channel.
      //     Letting an agent write there would let it fabricate a context blob
      //     that reads as one the orchestrator produced.
      //   - `learning` is an unused string in the table that shares a name with
      //     a different mechanism (`src/learning.ts`) which is written
      //     AUTOMATICALLY on every failure. Never writable, never injected.

      editor.add({
        name: "memory.set",
        description: "Write a durable note. Nothing is ever written automatically — this is the only way in, and nothing is injected into a task's prompt unless the key is `file:<path>` naming a file that task is scoped to. Appends, so correcting a note writes a new version rather than replacing the old. Scope is project (durable) or temp (scratch); session and learning are not writable.",
        input: {
          type: "object",
          properties: {
            key: {
              type: "string",
              description: "The note's key. Use `file:<path>` (e.g. `file:src/memory-store.ts`) to have it injected automatically into tasks touching that file. Any other key is reachable only by search."
            },
            value: { description: "The note. A string, or any JSON value." },
            scope: {
              type: "string",
              enum: ["project", "temp"],
              description: "project = durable and never evicted by count. temp = scratch, FIFO-evicted. Default: project."
            },
            author: {
              type: "string",
              description: "Who is writing this. Required, and SELF-REPORTED: nothing verifies it, and it is shown to readers as a claim rather than a record."
            },
            confidence: {
              type: "number",
              description: "How sure you are, 0–1. Optional. OMIT IT if you are not sure — an entry that records no confidence is not a low-confidence entry, and inventing a number makes your uncertainty invisible to whoever reads it later."
            },
            tags: { type: "array", items: { type: "string" }, description: "Optional labels." },
            ttl: { type: "number", description: "Optional expiry in ms. Off by default, and for `project` notes that is deliberate: nothing revalidates or rewrites a note, so an expiry would delete it permanently." }
          },
          required: ["key", "value", "author"],
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { key, value, scope, author, confidence, tags, ttl } = input as {
            key: string; value: unknown; scope?: 'project' | 'temp'; author: string
            confidence?: number; tags?: string[]; ttl?: number
          }
          const targetScope: MemoryScope = scope ?? 'project'
          try {
            const entry = orchestrator.memoryStore.set({
              key,
              value,
              scope: targetScope,
              author,
              confidence: confidence ?? null,
              tags: tags ?? [],
              ...(ttl ? { ttl } : {})
            })
            orchestrator.notifyMemoryWritten(entry)
            // Read AFTER the write, so the count is the number that exists now
            // and includes the entry just written.
            const versionsUnderKey = orchestrator.memoryStore.getByKey(key, targetScope).length
            const eviction = orchestrator.memoryStore.takeEviction()
            return {
              content: describeSetResult({
                entry,
                versionsUnderKey,
                evicted: eviction ? { scope: eviction.scope, count: eviction.count } : null,
              })
            }
          } catch (err) {
            // Reported as text, for the same reason `git.check` reports rather
            // than throws: a tool result the agent can read and relay beats an
            // exception it has to interpret. And it says what did NOT happen, so
            // a failed write is never read as a successful one.
            return { content: `memory.set did not write anything: ${err instanceof Error ? err.message : String(err)}. The store is unchanged.` }
          }
        }
      })

      editor.add({
        name: "memory.search",
        description: "Search notes by substring, over keys AND values. Unranked, so a result count is hits not relevance, and nothing is verified against the code. Project scope only unless you ask for internal session context.",
        input: {
          type: "object",
          properties: {
            query: { type: "string", description: "Substring to look for. A path or an identifier matches better than a description." },
            includeSession: {
              type: "boolean",
              description: "Also return internal escalation context — snapshots a failed agent wrote when it exhausted its retries. Those are labelled, never presented as notes, and are never injected into a task. For debugging escalations only."
            }
          },
          required: ["query"],
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { query, includeSession } = input as { query: string; includeSession?: boolean }
          // D1, enforced here rather than inside `searchMemory` so the allowlist
          // is visible at the surface that could get it wrong: project by
          // default, project + session only on an explicit opt-in, and never
          // `learning` — which is not a note store at all but the name of a
          // different, automatically-written mechanism.
          const scopes: MemoryScope[] = includeSession ? ['project', 'session'] : ['project']
          const results = orchestrator.searchMemory(query, scopes)
          const stats = orchestrator.memoryStore.getStats()
          return {
            content: describeSearchResult({
              query,
              results,
              storeTotal: stats.total,
              dbPath: orchestrator.memoryStore.path,
              includeSession: includeSession === true,
            })
          }
        }
      })

      editor.add({
        name: "memory.list",
        description: "List notes in a scope, newest version of each key first, with the entry counts by scope and anything evicted for exceeding a per-scope cap. Nothing here is verified against the code.",
        input: {
          type: "object",
          properties: {
            scope: {
              type: "string",
              enum: ["project", "session", "temp"],
              description: "Which scope to list. Default: project."
            },
            limit: { type: "number", description: "Maximum notes to show. Default 50." }
          },
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { scope, limit } = input as { scope?: MemoryScope; limit?: number }
          const targetScope: MemoryScope = scope ?? 'project'
          const cappedAt = Number.isFinite(limit) && (limit as number) > 0 ? Math.floor(limit as number) : 50
          const { entries, versionsSuperseded } = orchestrator.listMemory(targetScope, cappedAt)
          const stats = orchestrator.memoryStore.getStats()
          return {
            content: describeListResult({
              scope: targetScope,
              entries,
              versionsSuperseded,
              byScope: stats.byScope,
              evicted: stats.evicted,
              truncatedAt: cappedAt,
              dbPath: orchestrator.memoryStore.path,
            })
          }
        }
      })

      editor.add({
        name: "roles.list",
        description: "List all custom agent roles",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async () => {
          const roles = orchestrator.customRoles.list()
          if (roles.length === 0) return { content: "No custom roles defined. Add them in .opencode/nexus.jsonc under 'customRoles', or register one for this session with roles.add." }
          const lines = roles.map(r => `${r.emoji} ${r.displayName} (${r.name}): ${r.prompt.substring(0, 60)}...`)
          return { content: lines.join('\n') }
        }
      })

      editor.add({
        name: "roles.add",
        description: "Add a custom agent role",
        input: {
          type: "object",
          properties: {
            name: { type: "string", description: "Role identifier (lowercase, no spaces)" },
            displayName: { type: "string", description: "Display name" },
            emoji: { type: "string", description: "Emoji for the role" },
            prompt: { type: "string", description: "System prompt for this role" },
            model: { type: "string", description: "First-choice model for the role (optional). It is the first candidate the ranker considers, not the model the spawn necessarily uses: a models[role] entry takes precedence over it, and the ranker is free to select another candidate." }
          },
          required: ["name", "displayName", "prompt"]
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { name, displayName, emoji, prompt, model } = input as any
          orchestrator.customRoles.register({ name, displayName, emoji: emoji || '🤖', prompt, model })
          // Session-only, and said so here because it no longer is: a config
          // reload replaces the registry from the file, so a role added this
          // way and not written to `nexus.jsonc` stops resolving on the next
          // reload. The tool used to imply it had registered something durable.
          return { content: `Custom role '${displayName}' registered for this session. To keep it across config reloads and restarts, add it to .opencode/nexus.jsonc under 'customRoles'.` }
        }
      })

      editor.add({
        name: "forecast",
        description: "Estimate cost before executing tasks",
        input: {
          type: "object",
          properties: {
            tasks: { type: "string", description: "JSON array of tasks with role, model, and complexity" }
          },
          required: ["tasks"]
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { tasks } = input as { tasks: string }
          const taskList = JSON.parse(tasks)
          const remaining = orchestrator.budget.maxTotalCost - orchestrator.totalSpent

          // Support both formats: full Task objects or simple {role, model, complexity}
          const normalizedTasks = taskList.map((t: any) => ({
            task: t.task || {
              id: `forecast-${Date.now()}`,
              name: t.name || `${t.role} task`,
              description: t.description || '',
              files: { include: [] },
              dependencies: [],
              requiredRole: t.role,
              complexity: typeof t.complexity === 'number'
                ? { overall: t.complexity, factors: { fileCount: 0, codeLines: 0, dependencyDepth: 0, domainKnowledge: 0, riskLevel: 'low' as const } }
                : { overall: 50, factors: { fileCount: 0, codeLines: 0, dependencyDepth: 0, domainKnowledge: 0, riskLevel: 'low' as const } },
              priority: 'normal' as const,
              status: 'pending' as const
            },
            role: t.role,
            model: t.model,
            complexity: typeof t.complexity === 'number'
              ? { overall: t.complexity, factors: { fileCount: 0, codeLines: 0, dependencyDepth: 0, domainKnowledge: 0, riskLevel: 'low' as const } }
              : t.complexity || { overall: 50, factors: { fileCount: 0, codeLines: 0, dependencyDepth: 0, domainKnowledge: 0, riskLevel: 'low' as const } }
          }))

          const result = orchestrator.forecaster.forecastAll(normalizedTasks, remaining)
          const lines = result.estimates.map(e => `${e.taskName}: ~$${e.estimatedCost.toFixed(4)} (${e.model})`)
          lines.push(`\nTotal: ~$${result.totalEstimatedCost.toFixed(4)}`)
          lines.push(`Budget remaining: $${remaining.toFixed(2)}`)
          lines.push(`Within budget: ${result.withinBudget ? '✅' : '❌'}`)
          return { content: lines.join('\n') }
        }
      })

      editor.add({
        name: "worktree.enable",
        description: "Enable git worktree isolation for agents",
        input: { type: "object", properties: { repoRoot: { type: "string", description: "Repository root (defaults to cwd)" } } },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { repoRoot } = input as { repoRoot?: string }
          orchestrator.enableWorktrees(repoRoot || process.cwd())
          return { content: "Git worktree isolation enabled." }
        }
      })

      // Reports, never blocks. The description says so in the tool's own
      // listing, because the single most important property of this tool is the
      // one a model cannot infer from its name: it does not change the
      // repository, and it does not refuse.
      editor.add({
        name: "git.check",
        description: "Report on the git convention for this repository: branch, conventional commit subjects, and whether the branch is published. Read-only — it runs no git commit, push or merge, and never refuses. With `decision`, record this repository's one-time answer instead.",
        input: {
          type: "object",
          properties: {
            decision: {
              type: "string",
              enum: ["on", "off"],
              description: "Record the answer for this repository and stop asking. Omit to just report."
            },
            cwd: { type: "string", description: "Directory to inspect. Defaults to the working directory." }
          },
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { decision, cwd } = input as { decision?: 'on' | 'off'; cwd?: string }
          try {
            if (decision) {
              const recorded = orchestrator.recordGitFlowDecision(decision, cwd)
              return {
                content: [
                  `Recorded the git convention decision for this repository: ${recorded}.`,
                  `It is keyed by the resolved repository root and stored in ~/.config/opencode/nexus-gitflow.json,`,
                  `which is nexus's own global config directory — nothing was written to your repository and no git command was run.`,
                  `This will not be asked again for this repository.`,
                  `Current effective state: ${orchestrator.resolveGitFlow(cwd).reason}`
                ].join(' ')
              }
            }
            const report = orchestrator.checkGitFlow(cwd)
            // STATUS-SHAPED, and the ask travels through here. A subagent is
            // driven by tool calls and has no channel to a human, so the only
            // way to ask is to TELL the agent it must ask: the instruction is
            // in the tool result the agent is already reading, and the agent
            // carries it to the user in its own next message. It is emitted only
            // when the answer is genuinely undecided, so a second run in a repo
            // that has already answered stays silent.
            const lines = [
              report.summary,
              '',
              ...report.commits.map(c => `  ${c.conventional ? '✅' : '❌'} ${c.sha.slice(0, 8)} ${c.subject}`),
              report.commits.length === 0 ? '  (no commit subjects were read)' : '',
              '',
              `Scope: commits on this branch since \`${report.scope.base}\` (${report.scope.baseSource}).`,
              `This check ${report.didNot.join('; ')}.`
            ].filter(Boolean)
            if (report.decision === null) {
              lines.push('',
                'ACTION FOR YOU, NOT FOR A TOOL: the git convention is enabled by default and no answer has been recorded for this repository.',
                'Ask the user ONCE, in your own reply, and do not proceed past the question without an answer:',
                '  1. whether nexus should follow the branch / conventional-commit / PR path in this repository, or stay out of its git entirely;',
                '  2. then call this tool again with decision: "on" or decision: "off" to record the answer.',
                'Report what you found either way — this tool never refuses and never writes to the repository.'
              )
            }
            return { content: lines.join('\n') }
          } catch (err) {
            // The one failure this tool can surface is a decision recorded
            // outside a repository, which is a genuine "there is nothing to
            // record" rather than a crash. Reported as text, because a tool
            // result the agent can read and relay beats an exception it has to
            // interpret.
            return { content: `git.check could not complete: ${err instanceof Error ? err.message : String(err)}. No git command was run and nothing was written.` }
          }
        }
      })

      editor.add({
        name: "worktree.list",
        description: "List active agent worktrees",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: true },
        execute: async () => {
          if (!orchestrator.worktreeManager) return { content: "Worktree isolation not enabled." }
          const wts = orchestrator.worktreeManager.list()
          if (wts.length === 0) return { content: "No active worktrees." }
          return { content: wts.map(w => `${w.agentId}: ${w.path}`).join('\n') }
        }
      })

      editor.add({
        name: "worktree.disable",
        description: "Disable worktree isolation and clean up",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: true },
        execute: async () => {
          if (orchestrator.worktreeManager) {
            orchestrator.worktreeManager.cleanupAll()
            orchestrator.worktreeManager = null
          }
          return { content: "Worktree isolation disabled." }
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

      // === Todo Enforcer Tools ===

      editor.add({
        name: "todo.add",
        description: "Add a todo item to track work",
        input: {
          type: "object",
          properties: {
            description: { type: "string", description: "Todo description" },
            assignedTo: { type: "string", description: "Agent or role to assign (optional)" }
          },
          required: ["description"],
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { description, assignedTo } = input as { description: string; assignedTo?: string }
          const item = orchestrator.todoEnforcer.add(description, assignedTo)
          return { content: `📝 Todo added: ${item.id}: ${item.description} (${item.status})` }
        }
      })

      editor.add({
        name: "todo.list",
        description: "List all todo items",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async () => {
          return { content: orchestrator.todoEnforcer.formatAll() }
        }
      })

      editor.add({
        name: "todo.complete",
        description: "Mark a todo item as completed",
        input: {
          type: "object",
          properties: {
            id: { type: "string", description: "Todo item ID" }
          },
          required: ["id"],
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { id } = input as { id: string }
          const item = orchestrator.todoEnforcer.get(id)
          if (!item) return { content: `❌ Todo ${id} not found.` }
          orchestrator.todoEnforcer.complete(id)
          return { content: `✅ Todo completed: ${id}: ${item.description}` }
        }
      })

      editor.add({
        name: "todo.stats",
        description: "Get todo statistics",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async () => {
          const stats = orchestrator.todoEnforcer.getStats()
          return {
            content: `📊 Todo Statistics:\n  Total: ${stats.total}\n  ⏳ Pending: ${stats.pending}\n  🔄 In Progress: ${stats.inProgress}\n  ✅ Completed: ${stats.completed}\n  🚫 Blocked: ${stats.blocked}`
          }
        }
      })

      // === Goal Tracking Tools ===
      editor.add({
        name: "goal.set",
        description: "Set a new persistent objective",
        input: {
          type: "object",
          properties: {
            description: { type: "string", description: "Goal description" },
            autoContinue: { type: "boolean", description: "Auto-continue (default: true)" }
          },
          required: ["description"],
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { description, autoContinue } = input as { description: string; autoContinue?: boolean }
          const goal = goalManager.set(description, autoContinue ?? true)
          return { content: `🎯 Goal set: ${goal.description}` }
        }
      })

      editor.add({
        name: "goal.status",
        description: "Show current active goal status",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async () => {
          const active = goalManager.getActive()
          if (!active) return { content: "No active goal. Use nexus.goal.set() to set one." }
          return {
            content: [
              `🎯 Active Goal: ${active.description}`,
              `📋 ID: ${active.id}`,
              `🔄 Auto-continue: ${active.autoContinue ? 'enabled' : 'disabled'}`,
              `📊 Status: ${active.status}`,
              `📎 Tasks: ${active.tasks.length > 0 ? active.tasks.join(', ') : 'none yet'}`,
              `📅 Created: ${active.createdAt.toISOString()}`,
              `⏱️ Should continue: ${goalManager.shouldContinue() ? 'yes' : 'no'}`
            ].join('\n')
          }
        }
      })

      editor.add({
        name: "goal.complete",
        description: "Mark current active goal as completed",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async () => {
          const active = goalManager.getActive()
          if (!active) return { content: "No active goal to complete." }
          goalManager.complete(active.id)
          await ctx.storage.set("nexus-goal", JSON.parse(JSON.stringify(goalManager.getAll())))
          return {
            content: [
              `✅ Goal completed: ${active.description}`,
              `📋 ID: ${active.id}`,
              `📎 Tasks tracked: ${active.tasks.length}`
            ].join('\n')
          }
        }
      })

      editor.add({
        name: "goal.list",
        description: "List all goals",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async () => {
          const goals = goalManager.getAll()
          if (goals.length === 0) return { content: "No goals set yet. Use nexus.goal.set() to create one." }
          const lines = goals.map(g => {
            const icon = g.status === 'active' ? '🎯' : g.status === 'completed' ? '✅' : g.status === 'paused' ? '⏸️' : '❌'
            return `${icon} [${g.status}] ${g.description} (tasks: ${g.tasks.length})`
          })
          return { content: `Goals (${goals.length}):\n${lines.join('\n')}` }
        }
      })

      // Team management tools
      const teamManager = new TeamManager()
      const astGrep = new AstGrep()

    editor.add({
      name: "team.create",
      description: "Create a new team with a lead role",
      input: {
        type: "object",
        properties: {
          name: { type: "string", description: "Team name" },
          leadRole: { type: "string", description: "Role of the team lead" }
        },
        required: ["name", "leadRole"],
        additionalProperties: false
      },
      options: { codemode: true },
      execute: async (input: unknown) => {
        const { name, leadRole } = input as { name: string; leadRole: string }
        const team = teamManager.create(name, leadRole)
        return { content: `Team '${team.name}' created with ID: ${team.id}\nLead: ${leadRole}\nStatus: ${team.status}\n\nAdd members with nexus.team.addMember(teamId="${team.id}", role="...")` }
      }
    })

    editor.add({
      name: "team.addMember",
      description: "Add a member to a team",
      // `model` is GONE, and it is a BREAKING schema change: it was `required`
      // and no longer exists. It was stored on the member and read by nothing
      // — `member.model` appeared in exactly one place in the repository, the
      // success echo below, which reported back the string the caller had just
      // supplied. See `TeamMember` in `src/team.ts` for why wiring it was not
      // the alternative.
      input: {
        type: "object",
        properties: {
          teamId: { type: "string", description: "Team ID" },
          role: { type: "string", description: "Role for this member" }
        },
        required: ["teamId", "role"],
        additionalProperties: false
      },
      options: { codemode: true },
      execute: async (input: unknown) => {
        const { teamId, role } = input as { teamId: string; role: string }
        const member = teamManager.addMember(teamId, role)
        if (!member) {
          return { content: `Team ${teamId} not found.` }
        }
        const team = teamManager.get(teamId)
        return { content: `Member added to team '${team?.name}':\nID: ${member.id}\nRole: ${member.role}\nStatus: ${member.status}\n\nTotal members: ${team?.members.length || 0}` }
      }
    })

    editor.add({
      name: "team.status",
      description: "Show team status",
      input: {
        type: "object",
        properties: {
          teamId: { type: "string", description: "Team ID (optional, shows all if omitted)" }
        },
        additionalProperties: false
      },
      options: { codemode: true },
      execute: async (input: unknown) => {
        const { teamId } = input as { teamId?: string }
        
        if (teamId) {
          const team = teamManager.get(teamId)
          if (!team) {
            return { content: `Team ${teamId} not found.` }
          }
          // No `m.model`: the field is gone from `TeamMember` because nothing
          // ever read it. See the note on the interface in `src/team.ts`.
          const memberLines = team.members.map(m => `  - ${m.role}: ${m.status}`).join('\n')
          return { content: `Team: ${team.name} (${team.id})\nLead: ${team.lead}\nStatus: ${team.status}\nCreated: ${team.createdAt.toISOString()}\nMembers (${team.members.length}):\n${memberLines || '  No members yet'}` }
        }

        const teams = teamManager.getAll()
        if (teams.length === 0) {
          return { content: "No teams created yet." }
        }
        const lines = teams.map(t => `${t.status === 'active' ? '🟢' : t.status === 'completed' ? '✅' : '🔵'} ${t.name} (${t.id}) - Lead: ${t.lead} - Members: ${t.members.length}`)
        return { content: `Teams (${teams.length}):\n${lines.join('\n')}` }
      }
    })

    editor.add({
      name: "team.activate",
      description: "Activate a team to start execution",
      input: {
        type: "object",
        properties: {
          teamId: { type: "string", description: "Team ID" }
        },
        required: ["teamId"],
        additionalProperties: false
      },
      options: { codemode: true },
      execute: async (input: unknown) => {
        const { teamId } = input as { teamId: string }
        const team = teamManager.get(teamId)
        if (!team) {
          return { content: `Team ${teamId} not found.` }
        }
        if (team.members.length === 0) {
          return { content: `Team '${team.name}' has no members. Add members before activating.` }
        }
        teamManager.activate(teamId)
        return { content: `Team '${team.name}' activated!\n\nTeam is now ready for parallel execution with ${team.members.length} members:\n${team.members.map(m => `  - ${m.role}: ${m.status}`).join('\n')}` }
      }
    })

      // AST-Grep tools
      editor.add({
        name: "astgrep.search",
        description: "Search for AST patterns in codebase",
        input: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "AST pattern to search for" },
            language: { type: "string", description: "Programming language (typescript, python, etc.)" },
            directory: { type: "string", description: "Directory to search in" }
          },
          required: ["pattern", "language", "directory"],
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { pattern, language, directory } = input as { pattern: string; language: string; directory: string }
          const results = astGrep.search(pattern, language, directory)
          if (results.length === 0) return { content: `No matches found for "${pattern}" in ${language}` }
          const lines = results.map(r => `${r.file}:${r.line} — ${r.match}`)
          return { content: `Found ${results.length} matches:\n${lines.join('\n')}` }
        }
      })

      editor.add({
        name: "astgrep.status",
        description: "Check if ast-grep is installed",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: true },
        execute: async () => {
          const available = astGrep.isAvailable()
          return { content: available ? "✅ ast-grep is installed" : "❌ ast-grep is not installed. Install with: cargo install ast-grep" }
        }
      })
    })

    // `/nexus …`, reachable two ways and answered by one function.
    //
    // This used to be a `session.hook("prompt")` that caught any prompt starting
    // with `/nexus` and rewrote its text into the command's result. That hook
    // cannot cancel the turn, so every `/nexus costs` started a model request
    // whose only job was to read the answer back. V2 has a proper channel for
    // each caller, and both go through `runNexusCommand`:
    //
    //  - RPC, for the TUI plugin. It gets the full result back as data and shows
    //    it itself; nothing enters the session. See `src/rpc.ts`.
    //  - A registered `nexus` command, for every client that does not run the
    //    TUI plugin (web, desktop, `opencode run`). Inside the TUI the plugin's
    //    own `/nexus` keymap command wins, because the TUI resolves keymap slash
    //    commands before server commands.
    //
    // Each registration is guarded on its own. If the host refuses either one,
    // that is no reason for the orchestrator, its tools or the other entry
    // point to go missing. The failure is reported, never swallowed: a
    // `/nexus` that silently does nothing is the failure this replaces.
    try {
      await ctx.rpc.register(NexusRpc, {
        command: async (input) => runNexusCommand(
          (text) => orchestrator.handleCommand(text),
          (input as { text: string }).text,
        ),
      })
    } catch (error: unknown) {
      console.warn(`[nexus] could not register the Nexus RPC; TUI commands that reach the server will fail: ${error instanceof Error ? error.message : String(error)}`)
    }

    try {
      // `commands`, not `editor`: the tool-registry tests read every
      // `editor.add({` in this file as a tool registration.
      await ctx.command.transform((commands) => {
        commands.add({
          name: "nexus",
          description: "Nexus: status, agents, costs, pause, resume, dashboard [port] [host], dashboard stop, dashboard state",
          execute: async ({ sessionID, prompt }) => {
            const result = runNexusCommand(
              (text) => orchestrator.handleCommand(text),
              `/nexus ${prompt.text ?? ""}`,
            )
            // A synthetic message with `resume: false` is how core posts a
            // notice (the fork notice, the plan-mode reminder): it is recorded
            // in the session WITHOUT waking the agent, so no model request is
            // made. The TUI renders a synthetic message by its `description`, so
            // the result goes there; `text` is what the model reads on its next
            // turn, framed so it does not try to repeat the command.
            await ctx.session.synthetic({
              sessionID,
              description: result.text,
              text: [
                `The user ran \`/nexus ${(prompt.text ?? "").trim()}\` and the Nexus plugin already handled it. `,
                `Do not run it again. Its output was:`,
                "",
                result.text,
              ].join("\n"),
              metadata: { source: "nexus", ok: result.ok },
              resume: false,
            })
          },
        })
      })
    } catch (error: unknown) {
      console.warn(`[nexus] could not register the /nexus server command: ${error instanceof Error ? error.message : String(error)}`)
    }

    // The budget gate on OpenCode's permission check. See `src/permission-gate.ts`:
    // it closes the path where an agent starts a Nexus agent through the
    // built-in `subagent` tool after the hard limit has tripped. Guarded like the
    // registrations above: a host that refuses the hook still loads the plugin.
    try {
      await ctx.permission.hook("evaluate", (event) => {
        applyBudgetGate(event, { exceeded: orchestrator.isBudgetExceeded(), spent: orchestrator.totalSpent })
      })
    } catch (error: unknown) {
      console.warn(`[nexus] could not register the budget permission gate; only spawns through Nexus will respect the hard budget limit: ${error instanceof Error ? error.message : String(error)}`)
    }

    // Carry the active goal and open todos through context compaction, for
    // Nexus sessions only. See `src/compaction-note.ts`.
    try {
      await ctx.session.hook("compaction", (event) => {
        const note = buildCompactionNote({
          activeGoal: goalManager.getActive(),
          openTodos: [...orchestrator.todoEnforcer.getInProgress(), ...orchestrator.todoEnforcer.getPending()],
        })
        applyCompactionNote(event as unknown as Parameters<typeof applyCompactionNote>[0], note)
      })
    } catch (error: unknown) {
      console.warn(`[nexus] could not register the compaction hook; a compacted session may lose the Nexus goal and todos: ${error instanceof Error ? error.message : String(error)}`)
    }

    // Watch the two config files the config manager reads and reload on change.
    // Started here, immediately before the return, so the disposer returned
    // below is reachable from the first line of setup's tail. Anywhere earlier
    // and a rejection in one of the awaits between here and the return would
    // strand a live poll interval with no way to stop it.
    const stopConfigWatch = watchConfigFiles(ctx, orchestrator)

    return () => {
      stopConfigWatch()
      orchestrator.shutdown()
    }
  }
})

export { NexusOrchestrator } from "./orchestrator"
export { StateBroadcaster } from "./broadcast"
export { NexusConfigManager, DEFAULT_CONFIG, PRESETS } from "./config"
export type { NexusModelConfig, NexusFullConfig, NexusPreset } from "./config"
export { detectCycles } from "./dag"
export { MessageStore } from "./message-store"
export type { MessageStoreConfig } from "./message-store"
export { PersistentMemoryStore } from "./memory-store"
export type { MemoryStoreConfig } from "./memory-store"
export { MessageRouter } from "./fanout"
export type { FanOutRouter } from "./fanout"
export { HealthMonitor } from "./health"
export type { HealthCheck, HealthConfig } from "./health"
export { LearningModule } from "./learning"
export type { LearningEntry, PatternMatch } from "./learning"
export type { Agent, Task, DAG, ExecutionRequest, ExecutionResult } from "./types"
export { TEMPLATES, instantiateTemplate, listTemplates, getTemplate } from "./templates"
export type { TaskTemplate, TaskTemplateStep } from "./templates"
export { ModuleRegistry } from "./modules"
export type { NexusModule, ModuleContext, ModuleTool, ModuleHook } from "./modules"
export { SecurityScanner } from "./security"
export type { SecurityIssue, SecurityScanResult, SecurityConfig } from "./security"
export { PerformanceTracker } from "./performance"
export type { PerformanceEntry, PerformanceScore } from "./performance"
export { CustomRoleManager } from "./custom-roles"
export type { CustomRole, CustomRoleLoadReport } from "./custom-roles"
export { CostForecaster } from "./forecast"
export type { CostEstimate, ForecastResult } from "./forecast"
export { WorktreeManager } from "./worktree"
export type { AgentWorktree } from "./worktree"
export { TodoEnforcer } from "./todo"
export type { TodoItem } from "./todo"
export { GoalManager } from "./goal"
export type { Goal } from "./goal"
export { TeamManager } from "./team"
export type { Team, TeamMember } from "./team"
export { AstGrep } from "./astgrep"
export type { AstGrepPattern, AstGrepResult } from "./astgrep"

// Re-exported from the modules they moved to, so `@serkanalgur/opencode-nexus`
// keeps exporting everything it did before the split.
export { CONFIG_POLL_INTERVAL_MS, CONFIG_RELOAD_DEBOUNCE_MS, MAX_RELOAD_WAIT_MS, watchConfigFiles } from "./config-watch"
export { DASHBOARD_START_DESCRIPTION, DASHBOARD_STOP_DESCRIPTION, NOTIFICATIONS_TEST_DESCRIPTION, type NotificationsTestResult, runDashboardStart, runDashboardStop, runNotificationsTest } from "./tools/dashboard-actions"
export { buildGitFlowConventionSection, nexusAgentsDir } from "./agent-files"
export { renderModelCostReport } from "./cost-report"
