import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import * as realOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AgentRole, DAGNode, ModelSelection, Task } from '../src/types'

/**
 * `configManager` reads homedir()/.config/opencode/nexus.jsonc and `initialize`
 * reads location.directory. `bun test` does not honour process.env.HOME for
 * os.homedir(), so the module is mocked, following `spawn-subagent-tool.test.ts`.
 * Sandboxing both pins the role→model config to `DEFAULT_CONFIG`.
 *
 * The tests below rely on one specific fact about that map: the bare id
 * `minimax-m2.5-free` appears in no role entry, so `spawnAgent`'s auto-complete
 * scan cannot resolve it. (Four of `selectBestModel`'s six hardcoded candidates
 * DO appear in `DEFAULT_CONFIG` and would auto-complete fine.) If that model is
 * ever added to the defaults or to the candidate list, these tests lose their
 * meaning and must be re-pointed at another non-configured id.
 */
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'nexus-home-'))
const REAL_HOME = realOs.homedir()
mock.module('node:os', () => ({ ...realOs, default: realOs, homedir: () => SANDBOX_HOME }))

const { NexusOrchestrator } = await import('../src/orchestrator')
type SpawnedAgent = import('../src/orchestrator').SpawnedAgent

const tempDirs: string[] = [SANDBOX_HOME]

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-project-'))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  mock.module('node:os', () => realOs)
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

/**
 * `ModelSelection.model` is the bare id (`scoreModel` splits the candidate on
 * "/"), but `spawnAgent` needs the qualified "providerID/modelID" form.
 *
 * `selectBestModel`'s first candidate is the user-supplied role model, so a
 * config entry with no provider prefix makes `scoreModel` yield the whole value
 * as `provider` and `model: ""` — which `spawnAgent` accepts, resolving
 * `agent.model.model` to 'default'.
 */

/** A bare id that is a real `selectBestModel` candidate but appears in NO role config. */
const NON_CONFIGURED_BARE_MODEL = 'minimax-m2.5-free'
const NON_CONFIGURED_PROVIDER = 'opencode'

/**
 * Narrow views of private members, so tests can drive `spawnAndExecute` and
 * override the role→model lookup without `any`.
 */
type Internals = {
  spawnAndExecute(node: DAGNode, transferContext?: unknown): Promise<void>
  executeTask(agent: SpawnedAgent, node: DAGNode, transferContext?: unknown): Promise<void>
  configManager: { getModelForRole(role: string): string }
}

function internals(orchestrator: InstanceType<typeof NexusOrchestrator>): Internals {
  return orchestrator as unknown as Internals
}

function makeTask(): Task {
  return {
    id: 'task-1',
    name: 'Do the thing',
    description: 'A small isolated task',
    requiredRole: 'coder',
    complexity: {
      overall: 50,
      factors: { fileCount: 1, codeLines: 50, dependencyDepth: 0, domainKnowledge: 0, riskLevel: 'low' }
    },
    dependencies: [],
    files: { include: ['a.ts'] },
    priority: 'normal',
    status: 'pending'
  }
}

function makeNode(task: Task): DAGNode {
  return { id: task.id, task, dependencies: [], status: 'pending' }
}

function newOrchestrator() {
  return new NexusOrchestrator({
    // Keep the scheduler loop fast; `executeDAG` sleeps one interval per pass.
    schedulerInterval: 1,
    budget: { maxTotalCost: 10.00, maxCostPerTask: 1.00, maxCostPerAgent: 2.00, alertThreshold: 0.2, hardLimit: false }
  })
}

function createCtx() {
  return {
    location: { directory: makeTempDir() },
    session: {
      create: mock(() => Promise.resolve({ id: 'ses_dag_1' })),
      switchAgent: mock(() => Promise.resolve()),
      switchModel: mock(() => Promise.resolve()),
      prompt: mock(() => Promise.resolve()),
      wait: mock(() => Promise.resolve()),
      context: mock(() => Promise.resolve([
        { type: 'assistant', content: [{ type: 'text', text: 'done' }] }
      ])),
      background: mock(() => Promise.resolve()),
      hook: mock(() => Promise.resolve()),
    },
    storage: {
      set: mock(() => Promise.resolve()),
      get: mock(() => Promise.resolve(null)),
    },
  }
}

function bareStubAgent(): SpawnedAgent {
  return { id: 'agent-stub', sessionID: 'ses_dag_1' } as unknown as SpawnedAgent
}

/** Capture the `SpawnConfig.model` that `spawnAndExecute` passes, isolating it from execution. */
function captureSpawnedModels(orchestrator: InstanceType<typeof NexusOrchestrator>): string[] {
  const seen: string[] = []
  orchestrator.spawnAgent = async (config) => {
    seen.push(config.model ?? '')
    return bareStubAgent()
  }
  // Task execution is irrelevant to which model was selected.
  internals(orchestrator).executeTask = async () => { }
  return seen
}

function stubSelection(orchestrator: InstanceType<typeof NexusOrchestrator>, provider: string, model: string): void {
  orchestrator.selectModel = (): ModelSelection => ({
    provider,
    model,
    estimatedCost: 0,
    estimatedQuality: 0.5,
    reasoning: 'stubbed'
  })
}

describe('spawnAndExecute — qualified providerID/modelID', () => {
  let orchestrator: InstanceType<typeof NexusOrchestrator>

  beforeEach(async () => {
    orchestrator = newOrchestrator()
    await orchestrator.initialize(createCtx() as never)
  })

  it('passes the qualified model to spawnAgent, not the bare id', async () => {
    stubSelection(orchestrator, NON_CONFIGURED_PROVIDER, NON_CONFIGURED_BARE_MODEL)

    const seen = captureSpawnedModels(orchestrator)
    await internals(orchestrator).spawnAndExecute(makeNode(makeTask()))

    expect(seen).toEqual(['opencode/minimax-m2.5-free'])
  })

  it('rejects a selection with no provider instead of building "undefined/x"', async () => {
    stubSelection(orchestrator, '', NON_CONFIGURED_BARE_MODEL)
    const seen = captureSpawnedModels(orchestrator)

    await expect(internals(orchestrator).spawnAndExecute(makeNode(makeTask())))
      .rejects.toThrow(/is missing its provider/)
    expect(seen).toEqual([])
  })

  it('rejects a selection with an empty model instead of spawning "provider/"', async () => {
    // Exactly what `scoreModel` produces for a user config entry with no
    // provider prefix, e.g. {"coder": "mimo-v2.6-flash-free"}: the whole value
    // becomes the provider and the model id is empty. Guarding only on
    // `provider` would let "mimo-v2.6-flash-free/" through, where
    // `spawnAgent` skips auto-completion and resolves the model to 'default'.
    stubSelection(orchestrator, 'mimo-v2.6-flash-free', '')
    const seen = captureSpawnedModels(orchestrator)

    await expect(internals(orchestrator).spawnAndExecute(makeNode(makeTask())))
      .rejects.toThrow(/is missing its model/)
    expect(seen).toEqual([])
  })
})

describe('executeDAG — a non-configured candidate does not kill the scheduler', () => {
  let orchestrator: InstanceType<typeof NexusOrchestrator>

  beforeEach(async () => {
    orchestrator = newOrchestrator()
    await orchestrator.initialize(createCtx() as never)
  })

  it('completes the node and splits provider and model onto the agent', async () => {
    // The selected candidate is absent from the sandboxed DEFAULT_CONFIG role
    // map, so the bare id cannot be auto-completed by `spawnAgent`.
    stubSelection(orchestrator, NON_CONFIGURED_PROVIDER, NON_CONFIGURED_BARE_MODEL)

    const result = await orchestrator.execute({ tasks: [makeTask()] })

    expect(result.success).toBe(true)
    expect(result.tasks.length).toBe(1)
    expect(result.tasks[0]?.success).toBe(true)
    expect(orchestrator.getState().agents[0]?.model).toBe('opencode/minimax-m2.5-free')
  })
})

describe('executeDAG — a malformed selection fails one node, not the run', () => {
  let orchestrator: InstanceType<typeof NexusOrchestrator>

  beforeEach(async () => {
    orchestrator = newOrchestrator()
    await orchestrator.initialize(createCtx() as never)
  })

  it('keeps sibling results and surfaces the failure', async () => {
    const bad = makeTask()
    bad.id = 'task-bad'
    bad.name = 'Bad node'
    bad.requiredRole = 'coder'

    const good = makeTask()
    good.id = 'task-good'
    good.name = 'Good node'
    good.requiredRole = 'reviewer'

    // The malformed case is exactly what a prefixless role config produces:
    // whole value as provider, empty model id.
    orchestrator.selectModel = (role): ModelSelection => (role === 'coder'
      ? { provider: 'mimo-v2.6-flash-free', model: '', estimatedCost: 0, estimatedQuality: 0.5, reasoning: 'stubbed' }
      : { provider: NON_CONFIGURED_PROVIDER, model: NON_CONFIGURED_BARE_MODEL, estimatedCost: 0, estimatedQuality: 0.5, reasoning: 'stubbed' })

    const failures: Array<{ taskId: string; error: string }> = []
    orchestrator.on('task:failed', (data: { taskId: string; error: string }) => {
      failures.push(data)
    })

    const result = await orchestrator.execute({ tasks: [bad, good] })

    // Without per-node containment the rejected promise fails the whole
    // `Promise.all`, and `execute` returns success:false with zero tasks —
    // discarding the healthy sibling's result entirely.
    expect(result.success).toBe(true)
    expect(result.tasks.length).toBe(2)

    const failedTask = result.tasks.find(t => t.success === false)
    const succeededTask = result.tasks.find(t => t.success === true)

    expect(failedTask?.error).toContain('is missing its model')
    expect(succeededTask?.success).toBe(true)

    // The failure is observable: node.result reaches the caller and the
    // task:failed event carries the diagnostic.
    expect(failures.length).toBe(1)
    expect(failures[0]?.taskId).toBe('task-bad')
    expect(failures[0]?.error).toContain('is missing its model')
  })
})

describe('spawnAgent — invalid model error message', () => {
  let orchestrator: InstanceType<typeof NexusOrchestrator>

  beforeEach(async () => {
    orchestrator = newOrchestrator()
    await orchestrator.initialize(createCtx() as never)
  })

  it('labels a caller-supplied model as requested', async () => {
    await expect(orchestrator.spawnAgent({ role: 'coder' satisfies AgentRole, model: 'not-a-configured-model' }))
      .rejects.toThrow(/Invalid model "not-a-configured-model" \(requested "coder"\)/)
  })

  it('labels a role-config model as configured, not "undefined"', async () => {
    // Simulate a config whose coder model is missing its provider prefix —
    // `getModelForRole` warns but returns it unchanged.
    internals(orchestrator).configManager.getModelForRole = () => 'prefixless-model'

    await expect(orchestrator.spawnAgent({ role: 'coder' satisfies AgentRole }))
      .rejects.toThrow(/Invalid model "prefixless-model" \(configured for role "coder"\)/)
  })
})
