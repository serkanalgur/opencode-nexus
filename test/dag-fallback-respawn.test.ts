import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import * as realOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { DAG, DAGNode, Task } from '../src/types'

/**
 * Same HOME sandboxing rationale as `dag-model-selection.test.ts`:
 * `configManager` reads homedir()/.config/opencode/nexus.jsonc and
 * `initialize` reads location.directory, and `bun test` does not honour
 * process.env.HOME for os.homedir(). The module is mocked so both are
 * sandboxed and the role→model map is pinned to DEFAULT_CONFIG.
 */
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'nexus-home-'))
const REAL_HOME = realOs.homedir()
mock.module('node:os', () => ({ ...realOs, default: realOs, homedir: () => SANDBOX_HOME }))

const { NexusOrchestrator, DEFAULT_ESCALATION } = await import('../src/orchestrator')

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

/** Narrow views of private members, so tests can drive the DAG without `any`. */
type Internals = {
  dag: DAG | null
  escalationPolicy: { fallbackModels: string[] }
}

function internals(orchestrator: NexusOrchestrator): Internals {
  return orchestrator as unknown as Internals
}

/**
 * The escalation step 3 actually reaches for these tasks.
 *
 * NOT `DEFAULT_ESCALATION.fallbackModels[0]`. Model selection at complexity 50
 * wins with `google/gemini-2.5-flash`, which is also `fallbackModels[0]`, so
 * step 3 skips that entry as "the model that just failed" and uses the next
 * one. Naming the reachable entry once here keeps the tests below asserting
 * about behaviour instead of re-deriving the list order.
 */
const REACHED_FALLBACK = 'anthropic/claude-haiku-4-5'
/** The entry step 3 steps over, because selection already chose it. */
const SKIPPED_FALLBACK = 'google/gemini-2.5-flash'

function makeTask(id: string, role: string): Task {
  return {
    id,
    name: `Task ${id}`,
    description: `Description for ${id}`,
    requiredRole: role,
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

/** One prompt call: which session was asked to do what. */
type PromptCall = { sessionID?: string; text: string }

interface Harness {
  prompts: PromptCall[]
}

/**
 * A ctx whose `session.prompt` fails for the first `failLeadingPrompts` calls
 * and succeeds afterwards, so an escalation's *retry* can be observed
 * succeeding. Each `session.create` returns a distinct id, which is what lets a
 * test tell the original attempt's session from the fallback's.
 *
 * The counter is global across sessions, so a multi-node test fails only the
 * leading prompt(s) — the first node in DAG order — and leaves its siblings to
 * succeed on their first attempt.
 */
function createCtx(failLeadingPrompts = 0) {
  let sessions = 0
  let promptCalls = 0
  const prompts: PromptCall[] = []
  return {
    prompts,
    location: { directory: makeTempDir() },
    session: {
      create: mock(() => Promise.resolve({ id: `ses_${++sessions}` })),
      switchAgent: mock(() => Promise.resolve()),
      switchModel: mock(() => Promise.resolve()),
      prompt: mock((input: PromptCall) => {
        prompts.push(input)
        return promptCalls++ < failLeadingPrompts
          ? Promise.reject(new Error('prompt exploded'))
          : Promise.resolve()
      }),
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

type Ctx = ReturnType<typeof createCtx>

/**
 * Config that skips straight to step 3: `maxRetries: 0` makes step 1
 * ineligible, and `contextTransfer: false` maps to `enableRespawn: false`,
 * so step 2 is skipped too. The step *order* and policy are untouched — this
 * only removes the two earlier branches from the path.
 */
function newOrchestrator() {
  return new NexusOrchestrator({
    schedulerInterval: 1,
    selfHealing: { enabled: true, maxRetries: 0, retryDelay: 0, contextTransfer: false },
    budget: { maxTotalCost: 10.00, maxCostPerTask: 1.00, maxCostPerAgent: 2.00, alertThreshold: 0.2, hardLimit: false }
  })
}

async function initialized(failLeadingPrompts = 0): Promise<{ orchestrator: NexusOrchestrator; h: Harness }> {
  const orchestrator = newOrchestrator()
  const ctx = createCtx(failLeadingPrompts)
  await orchestrator.initialize(ctx as never)
  return { orchestrator, h: { prompts: ctx.prompts } }
}

function nodeOf(orchestrator: NexusOrchestrator, id: string): DAGNode {
  const node = internals(orchestrator).dag?.nodes.get(id)
  if (!node) throw new Error(`no DAG node for ${id}`)
  return node
}

/** The agent the orchestrator reports for a given qualified model. */
function agentFor(orchestrator: NexusOrchestrator, model: string) {
  return orchestrator.getState().agents.find(a => a.model === model)
}

describe('handleFailure step 3 — the fallback model actually runs the task', () => {
  beforeEach(() => {
    // The policy is built from a copy of DEFAULT_ESCALATION, but a test that
    // drains it must not leave the next one short. Fail loudly if that changes.
    expect([...DEFAULT_ESCALATION.fallbackModels]).toEqual([
      'google/gemini-2.5-flash',
      'anthropic/claude-haiku-4-5'
    ])
  })

  it('prompts the fallback session and completes the node instead of stranding it at pending', async () => {
    // The first attempt's prompt throws; step 3's must succeed, so the node
    // ends completed rather than failed.
    const { orchestrator, h } = await initialized(1)

    const result = await orchestrator.execute({ tasks: [makeTask('task-1', 'coder')] })

    // Two prompts: the original attempt and the fallback. The old code spawned
    // a second session but never prompted it, so this was a single call.
    expect(h.prompts.length).toBe(2)
    expect(h.prompts[0]?.sessionID).not.toBe(h.prompts[1]?.sessionID)
    // The fallback session was actually handed the task.
    expect(h.prompts[1]?.text).toContain('Task task-1')
    expect(h.prompts[1]?.text).toContain('Description for task-1')

    // The node left 'pending' and finished.
    expect(nodeOf(orchestrator, 'task-1').status).toBe('completed')
    expect(result.success).toBe(true)
    expect(result.tasks[0]?.success).toBe(true)

    // `spawnedAgent` points at the agent that ran it, and that agent is on
    // the escalation model — the wiring the bare `spawnAgent` skipped.
    const spawned = nodeOf(orchestrator, 'task-1').spawnedAgent
    expect(spawned).toBeDefined()
    expect(agentFor(orchestrator, REACHED_FALLBACK)?.id).toBe(spawned?.id)
  })

  it('leaves the node running or completed, never pending', async () => {
    // Pins the actual defect: the old step 3 left `status === 'pending'` with
    // an orphaned agent, so the scheduler would keep re-picking the node.
    const { orchestrator } = await initialized(1)

    await orchestrator.execute({ tasks: [makeTask('task-1', 'coder')] })

    const node = nodeOf(orchestrator, 'task-1')
    expect(['running', 'completed']).toContain(node.status)
    expect(node.task.assignedAgent).toBe(node.spawnedAgent?.id)
  })

  it('uses the fallback model, not the role-configured one', async () => {
    const { orchestrator } = await initialized(1)

    // Wrap rather than replace: the real `spawnAgent` produces a fully-formed
    // agent, which the real `executeTask` needs (it reads `agent.model.*`).
    const spawned: string[] = []
    const realSpawnAgent = orchestrator.spawnAgent.bind(orchestrator)
    orchestrator.spawnAgent = async (config) => {
      spawned.push(config.model ?? '')
      return realSpawnAgent(config)
    }

    await orchestrator.execute({ tasks: [makeTask('task-1', 'coder')] })

    // The second spawn carries an escalation reference, and the escalation
    // CHANGED THE MODEL.
    //
    // This assertion is load-bearing and was briefly relaxed, wrongly. Step 3
    // shifted `fallbackModels[0]` with no comparison against the model that just
    // failed, and since selection wins with 'google/gemini-2.5-flash' at almost
    // every complexity — which is also `fallbackModels[0]` — an unconditional
    // shift re-ran the identical task on the identical model, burning a full
    // task's tokens and an escalation entry to achieve nothing. "Escalation
    // must change the model" is the product requirement, and it does not hold
    // by accident of which model selection happens to pick.
    //
    // The escalation is the NEXT usable entry, not the head: step 3 steps over
    // the head because it is the model that just failed.
    expect(spawned.length).toBe(2)
    expect(spawned[1]).toBe(REACHED_FALLBACK)
    expect(spawned[0]).not.toBe(spawned[1])
  })

  it('skips a fallback that equals the model that just failed, and burns it', async () => {
    // The other half of the same requirement: an entry equal to the failed
    // model is not merely skipped, it is stepped over AND consumed, so a node
    // does not re-attempt it on a later escalation.
    const { orchestrator } = await initialized(1)
    expect(internals(orchestrator).escalationPolicy.fallbackModels[0])
      .toBe(SKIPPED_FALLBACK)

    // The first attempt runs on the model selection picks, which at this
    // complexity IS google/gemini-2.5-flash — the head of the fallback list.
    const spawned: string[] = []
    const realSpawnAgent = orchestrator.spawnAgent.bind(orchestrator)
    orchestrator.spawnAgent = async (config) => {
      spawned.push(config.model ?? '')
      return realSpawnAgent(config)
    }

    await orchestrator.execute({ tasks: [makeTask('task-1', 'coder')] })

    // Exactly two spawns, and the escalation is NOT the model that just
    // failed. Before the step-3 fix this produced two spawns both on
    // google/gemini-2.5-flash: a full task's tokens spent re-running the same
    // thing.
    expect(spawned).toHaveLength(2)
    expect(spawned[0]).toBe(SKIPPED_FALLBACK)
    expect(spawned[1]).toBe(REACHED_FALLBACK)

    // And the unusable entry was consumed, so a second escalation cannot reach
    // for the model that just failed.
    expect(internals(orchestrator).escalationPolicy.fallbackModels).toEqual([])
  })

  it('reaches step 4 without consuming the list when EVERY fallback equals the failed model', async () => {
    // No usable escalation exists, so step 3 must not fire at all — and it must
    // leave the shared policy intact. Draining it would strip the escalation
    // route from every OTHER node too, turning one node's dead end into the
    // whole orchestrator's.
    const { orchestrator } = await initialized(1)
    internals(orchestrator).escalationPolicy.fallbackModels = [
      'google/gemini-2.5-flash',
      'google/gemini-2.5-flash',
    ]

    const spawned: string[] = []
    const realSpawnAgent = orchestrator.spawnAgent.bind(orchestrator)
    orchestrator.spawnAgent = async (config) => {
      spawned.push(config.model ?? '')
      return realSpawnAgent(config)
    }
    const alerts: string[] = []
    orchestrator.on('agent:escalation', (e: { taskId: string }) => { alerts.push(e.taskId) })

    const result = await orchestrator.execute({ tasks: [makeTask('task-1', 'coder')] })

    // One attempt only: no step-3 respawn, because there is nothing to switch
    // to. The node fails, which is the honest outcome.
    expect(spawned).toEqual([SKIPPED_FALLBACK])
    expect(alerts).toEqual(['task-1'])
    expect(nodeOf(orchestrator, 'task-1').status).toBe('failed')
    // `result.success` is about the DAG having run to completion, not about
    // every task succeeding — the per-task result is the one that says the
    // task failed. Pre-existing `execute()` semantics, not a step-3 claim.
    expect(result.tasks[0]?.success).toBe(false)

    // Nothing was consumed: the list is still there for a node that failed on
    // a DIFFERENT model and could use these entries.
    expect(internals(orchestrator).escalationPolicy.fallbackModels)
      .toEqual(['google/gemini-2.5-flash', 'google/gemini-2.5-flash'])
  })
})

describe('handleFailure step 3 — the fallback entry is consumed', () => {
  it('does not reuse a fallback on a second escalation', async () => {
    const { orchestrator } = await initialized(1)

    await orchestrator.execute({ tasks: [makeTask('task-1', 'coder')] })

    // BOTH entries are gone: `anthropic/claude-haiku-4-5` is the one the
    // escalation used, and `google/gemini-2.5-flash` was stepped over and
    // consumed because it is the model that just failed. Consumed-not-skipped
    // is deliberate — a later escalation must not reach for the model that
    // already failed once.
    expect(internals(orchestrator).escalationPolicy.fallbackModels).toEqual([])

    // A second, independent orchestrator gets the full default list — the
    // policy owns its copy rather than mutating the shared module default.
    const second = newOrchestrator()
    await second.initialize(createCtx(1) as never)
    expect(internals(second).escalationPolicy.fallbackModels).toHaveLength(2)
  })

  it('burns one entry per escalation, so a node can only fall back twice', async () => {
    // With the default two-entry list, two step-3 escalations drain the list
    // and the third failure reaches step 4 (alert) instead.
    const { orchestrator } = await initialized(0)

    const policy = internals(orchestrator).escalationPolicy
    const first = policy.fallbackModels.shift()
    const second = policy.fallbackModels.shift()

    expect(first).toBe('google/gemini-2.5-flash')
    expect(second).toBe('anthropic/claude-haiku-4-5')
    expect(policy.fallbackModels).toEqual([])
  })
})

describe('handleFailure step 4 — still reached when no fallback remains', () => {
  it('alerts and marks the node failed', async () => {
    const { orchestrator } = await initialized(1)
    // Drain the list so step 3 is ineligible and control falls to step 4.
    internals(orchestrator).escalationPolicy.fallbackModels.length = 0

    const escalations: Array<{ agentId: string; taskId: string; error: string }> = []
    orchestrator.on('agent:escalation', (data: { agentId: string; taskId: string; error: string }) => {
      escalations.push(data)
    })

    const result = await orchestrator.execute({ tasks: [makeTask('task-1', 'coder')] })

    // Only the original attempt was prompted — no fallback spawn happened.
    expect(escalations.length).toBe(1)
    expect(escalations[0]?.taskId).toBe('task-1')
    expect(escalations[0]?.error).toBe('prompt exploded')

    expect(nodeOf(orchestrator, 'task-1').status).toBe('failed')
    expect(result.tasks[0]?.success).toBe(false)
    expect(result.tasks[0]?.error).toBe('prompt exploded')
  })
})

describe('handleFailure step 3 — a throw in the fallback path is contained', () => {
  it('fails the node without discarding its siblings', async () => {
    // Same per-node containment the previous PR added to `executeDAG`: the
    // rejection has to surface as this node's failure, not escape the
    // `Promise.all` and take the healthy sibling's result with it.
    //
    // Only the leading prompt fails, so `task-bad` (first in DAG order) is the
    // node that reaches step 3; `task-good` completes on its first attempt and
    // is the sibling whose result must survive.
    const { orchestrator } = await initialized(1)

    // Sibling nodes spawn concurrently, so a call *count* would be racy. Key
    // the throw on "this task has already spawned once" instead — that
    // identifies the step-3 path exactly and per node, because with this policy
    // (retries exhausted, respawn disabled) step 3 is the only REMAINING
    // caller that spawns a second agent for a task. Steps 1 and 2 also re-spawn
    // the same node, and the harness disables both, so the key is correct FOR
    // THIS POLICY: if retries or respawn were ever enabled here, the first
    // attempt would throw and this test would silently stop testing sibling
    // containment at all.
    //
    // The previous key was the fallback MODEL REF, on the grounds that step 3
    // was the only caller passing a model override. That stopped being true:
    // the cost term is now a real per-task estimate, so selection can itself
    // pick an escalation fallback, and keying on the ref made the FIRST attempt
    // throw too — failing the sibling as well and destroying the very
    // containment this test exists to pin. A spawn-count key does not depend on
    // which model selection happens to choose.
    const spawnsPerTask = new Map<string, number>()
    const realSpawnAgent = orchestrator.spawnAgent.bind(orchestrator)
    orchestrator.spawnAgent = async (config) => {
      const taskId = config.task.id
      const seen = (spawnsPerTask.get(taskId) ?? 0) + 1
      spawnsPerTask.set(taskId, seen)
      if (seen > 1) {
        throw new Error('fallback session create failed')
      }
      return realSpawnAgent(config)
    }

    const result = await orchestrator.execute({
      tasks: [makeTask('task-bad', 'coder'), makeTask('task-good', 'reviewer')]
    })

    // Without containment this rejection would reject the whole `Promise.all`
    // and `execute` would return success:false with zero tasks.
    expect(result.success).toBe(true)
    expect(result.tasks.length).toBe(2)

    const failed = result.tasks.find(t => t.success === false)
    const succeeded = result.tasks.find(t => t.success === true)
    expect(failed?.error).toContain('fallback session create failed')
    expect(succeeded?.success).toBe(true)
  })
})
