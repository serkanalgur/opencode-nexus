import type { Plugin } from "@opencode/plugin"
import type { NexusOrchestrator, SpawnedAgent } from "../orchestrator"
import type { GoalManager } from "../goal"

/**
 * What the tool modules in `src/tools/` need from `setup()`. Built once in
 * `src/index.ts` and passed to every `register*Tools` call, so each module
 * names exactly the setup-scope values it closes over.
 */
export interface ToolDeps {
  readonly ctx: Plugin.Context
  readonly orchestrator: NexusOrchestrator
  readonly goalManager: GoalManager
  /** Create a child session and deliver the task exactly once. See `setup()`. */
  readonly spawnAndDeliver: (opts: { role: string; task: string; model?: string }, toolCtx: any) => Promise<SpawnedAgent>
  /** The coalescing writer of the orchestrator snapshot. See `src/state-persister.ts`. */
  readonly persistState: () => Promise<void>
}

/** The editor `ctx.tool.transform` hands its callback. */
export type ToolEditor = Parameters<Parameters<Plugin.Context["tool"]["transform"]>[0]>[0]
