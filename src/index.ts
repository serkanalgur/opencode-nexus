import { Plugin, type Skill } from "@opencode/plugin"
import { NexusOrchestrator, type SpawnedAgent } from "./orchestrator"
import { GoalManager } from "./goal"
import { keptModifiedWarning, loadNexusSkills, nexusSkillsDir, registerNexusSkills, retireInstalledSkills, type SkillRetireResult, type UnavailableSkill } from "./skills-install"
import { NexusRpc, runNexusCommand } from "./rpc"
import { applyBudgetGate } from "./permission-gate"
import { createCoalescingWriter, toStorageJson } from "./state-persister"
import { applyCompactionNote, buildCompactionNote } from "./compaction-note"
import { writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { watchConfigFiles } from "./config-watch"
import { readNexusAgent, readNexusSubagents, buildGitFlowConventionSection } from "./agent-files"
import type { ToolDeps } from "./tools/deps"
import { registerStatusTools } from "./tools/status"
import { registerDashboardTools } from "./tools/dashboard"
import { registerConfigTools } from "./tools/config"
import { registerAgentsTools } from "./tools/agents"
import { registerInsightTools } from "./tools/insight"
import { registerMemoryTools } from "./tools/memory"
import { registerRolesTools } from "./tools/roles"
import { registerGitTools } from "./tools/git"
import { registerTrackingTools } from "./tools/tracking"
import { registerTeamTools } from "./tools/team"
import { registerAstgrepTools } from "./tools/astgrep"
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

      const toolDeps: ToolDeps = { ctx, orchestrator, goalManager, spawnAndDeliver, persistState }
      registerStatusTools(editor, toolDeps)
      registerDashboardTools(editor, toolDeps)
      registerConfigTools(editor, toolDeps)
      registerAgentsTools(editor, toolDeps)
      registerInsightTools(editor, toolDeps)
      registerMemoryTools(editor, toolDeps)
      registerRolesTools(editor, toolDeps)
      registerGitTools(editor, toolDeps)
      registerTrackingTools(editor, toolDeps)
      registerTeamTools(editor, toolDeps)
      registerAstgrepTools(editor, toolDeps)
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
