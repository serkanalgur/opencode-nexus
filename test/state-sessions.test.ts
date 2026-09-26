import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DAG, TaskResult } from '../src/types'
import { NexusOrchestrator, type OrchestratorState, type SessionStateView } from '../src/orchestrator'

/**
 * What `getState()` publishes for the dashboard: the sessions view, the task
 * fields the DAG view needs, the config under its real key names, and the
 * broadcaster lifecycle.
 *
 * The sessions view is the point of the file. Every collection nexus keeps
 * about a session was private — `deltaLedgers` and `uncollected` are populated
 * only on the timeout path, and the agent that owned a timed-out session is
 * deleted by `terminateAgent` while the session itself keeps generating and
 * spending. That session was reachable from nowhere: not `getState().agents`,
 * not the page, and not the cost report, which could admit it was under-billing
 * without naming the session. These tests pin that it is now reachable.
 */

type Tokens = { input: number; output: number; reasoning: number; cache: { read: number; write: number } }

function usage(input: number, output: number): Tokens {
  return { input, output, reasoning: 0, cache: { read: 0, write: 0 } }
}

/** Per-1K rates. */
const SONNET = { input: 0.003, output: 0.015, cacheRead: 0.0003, cacheWrite: 0.00375 }
const MODEL = 'anthropic/claude-sonnet-4-6'
const SESSION_ID = 'ses_child'

const COMPLEXITY = {
  overall: 50,
  factors: { fileCount: 0, codeLines: 0, dependencyDepth: 0, domainKnowledge: 0, riskLevel: 'low' as const },
}

/**
 * A latch on `session.prompt`, for tests that must read orchestrator state
 * WHILE a task is in flight.
 *
 * That window is the only place the `idle` → `working` → `idle` transition is
 * observable at all: `executeTask` sets `working` immediately before it issues
 * the prompt, and the `finally` puts it back down after the task settles. A ctx
 * that answers `prompt` synchronously leaves no window to look into, and one
 * that never released would hang the task instead of settling it — so the
 * latch has to be closed by the test, deliberately, at the moment it is
 * asserting.
 */
function promptLatch() {
  let openGate: (() => void) | null = null
  let markEntered: (() => void) | null = null
  const gate = new Promise<void>(resolve => { openGate = resolve })
  const entered = new Promise<void>(resolve => { markEntered = resolve })
  return {
    /** Awaited inside `session.prompt` for as long as the latch is held. */
    gate,
    /** Called by the ctx when `prompt` is entered. */
    markEntered: () => markEntered?.(),
    /** Resolves once the orchestrator is actually inside `prompt`. */
    waitUntilEntered: () => entered,
    /** Lets the held `prompt` return, so the task can run to completion. */
    release: () => openGate?.(),
  }
}

/**
 * A ctx whose session behaves over TIME rather than answering once, because the
 * case under test is about a session that outlives its agent. `tokenSequence`
 * is consumed by successive `session.get` calls, the last repeating.
 */
function makeCtx(opts: {
  tokenSequence?: Tokens[]
  waitNever?: boolean
  waitResolvesAfterMs?: number
  /** When set, `prompt` blocks on this latch instead of resolving. */
  promptGate?: ReturnType<typeof promptLatch>
} = {}) {
  let gets = 0
  const at = (n: number): Tokens => {
    const seq = opts.tokenSequence
    if (!seq || seq.length === 0) return usage(1000, 100)
    return seq[Math.min(n, seq.length - 1)] as Tokens
  }
  return {
    location: { directory: mkdtempSync(join(tmpdir(), 'nexus-project-')) },
    model: { list: mock(() => Promise.resolve({ data: [] })) },
    session: {
      create: mock(() => Promise.resolve({ id: SESSION_ID })),
      prompt: mock((): Promise<void> => {
        if (!opts.promptGate) return Promise.resolve()
        opts.promptGate.markEntered()
        return opts.promptGate.gate
      }),
      // A session that never goes idle is the one that keeps spending; one that
      // resolves after a delay is a session that outlived its task's timeout
      // and then settled, which is the collectable orphan.
      wait: mock((): Promise<void> => {
        if (opts.waitNever) return new Promise<void>(() => {})
        if (opts.waitResolvesAfterMs !== undefined) {
          return new Promise<void>(resolve => setTimeout(resolve, opts.waitResolvesAfterMs))
        }
        return Promise.resolve()
      }),
      context: mock(() => Promise.resolve([])),
      get: mock(() => {
        const n = gets++
        return Promise.resolve({
          id: SESSION_ID,
          time: { created: 0, updated: 0 },
          tokens: at(n),
        })
      }),
    },
    storage: { get: mock(() => Promise.resolve(null)), set: mock(() => Promise.resolve()) },
    tool: { list: mock(() => Promise.resolve([])) },
  }
}

interface TaskNode {
  id: string
  status: string
  result?: { success: boolean; cost: number; tokensUsed: number }
  task: Record<string, unknown>
}

/**
 * Run one task to completion (or to its timeout) and hand back the live
 * orchestrator plus the node, so a test can read state BETWEEN the two.
 * `onReady` runs after `initialize()`, and the orchestrator is deliberately NOT
 * shut down: `shutdown()` flushes every collection, which would erase the very
 * pending state these tests read.
 *
 * `detach` starts the task WITHOUT awaiting it and returns the promise as
 * `settled`. It exists for the tests that hold `session.prompt` on a latch:
 * those must inspect state while the task is suspended mid-prompt, which an
 * `await` before the inspection can never allow.
 */
async function runTask(
  ctx: ReturnType<typeof makeCtx>,
  { taskTimeoutMs = 60_000, graceMs, onReady, afterTask, detach }: {
    taskTimeoutMs?: number
    graceMs?: number
    /** Runs after `initialize()` and before the task, for listener wiring. */
    onReady?: (orchestrator: NexusOrchestrator) => void
    afterTask?: (orchestrator: NexusOrchestrator, agent: { id: string }) => Promise<void> | void
    /** Start the task and hand back `settled` instead of awaiting it. */
    detach?: boolean
  } = {}
) {
  const orchestrator = new NexusOrchestrator({
    selfHealing: { enabled: false, maxRetries: 3, retryDelay: 0, backoffMultiplier: 2, contextTransfer: false },
    ...(graceMs === undefined ? {} : { cost: { timeoutDeltaGraceMs: graceMs } }),
  })
  await orchestrator.initialize(ctx as never)
  orchestrator.setModelCosts({ [MODEL]: SONNET })
  onReady?.(orchestrator)

  const node: TaskNode = {
    id: 'node-1',
    status: 'running',
    task: {
      id: 'task-1',
      name: 't',
      description: 'd',
      requiredRole: 'coder',
      timeout: taskTimeoutMs,
      files: { include: [] },
      complexity: COMPLEXITY,
      dependencies: [],
    },
  }
  orchestrator['dag'] = stubDAG({
    markComplete: (_id: string, result: TaskResult) => { node.result = result },
    markFailed: () => {},
  })

  const agent = await orchestrator.spawnAgent({ role: 'coder', model: MODEL }, { task: 'Do the thing' })
  const taskDone = orchestrator['executeTask'](agent, node as never).then(() => {})
  if (!detach) {
    await taskDone
    await afterTask?.(orchestrator, agent)
  }
  return { orchestrator, agent, node, settled: taskDone }
}

/** The single session row, asserting there is exactly one. */
function onlySession(state: OrchestratorState): SessionStateView {
  expect(state.sessions).toHaveLength(1)
  return state.sessions[0] as SessionStateView
}


/**
 * Minimal `DAG` double. These tests only exercise `markComplete`/`markFailed`,
 * but `orchestrator.dag` is typed as the full `DAG` interface, so the
 * remaining members have to be present. They are deliberately inert.
 */
function stubDAG(impl: Pick<DAG, 'markComplete' | 'markFailed'>): DAG {
  return {
    nodes: new Map(),
    addNode() {},
    addDependency() {},
    removeNode() {},
    getReadyNodes: () => [],
    markComplete: impl.markComplete,
    markFailed: impl.markFailed,
    getParallelGroups: () => [],
    isComplete: () => true,
  }
}
describe('getState().sessions', () => {
  it('shows a live agent\'s session as owned, with its identity', async () => {
    const ctx = makeCtx()
    const { orchestrator } = await runTask(ctx)

    const row = onlySession(orchestrator.getState())

    expect(row.id).toBe(SESSION_ID)
    expect(row.owned).toBe(true)
    // Non-null agentId and a role: the difference between "we know this
    // session" and "we know who is running it".
    expect(row.agentId).toBe(orchestrator.getState().agents[0]?.id)
    expect(row.role).toBe('coder')
    expect(row.model).toBe(MODEL)
    expect(row.taskId).toBeNull()
    expect(row.spawnedAt).toBe(orchestrator.getState().agents[0]?.spawnedAt)
    expect(row.observedUncollected).toBe(0)
    // Tokens actually consumed by the task, i.e. `Agent.metrics.totalTokens`.
    expect(row.lastKnownTokens).toBeGreaterThan(0)
    // Alive and between tasks. NOT 'settled': `executeTask` leaves a successful
    // agent `idle`, and only `completed`/`failed`/`terminated` map to settled.
    expect(row.state).toBe('idle')

    await orchestrator.shutdown()
  })

  it('reports a fresh agent as idle, and an agent with no session as no row at all', async () => {
    const orchestrator = new NexusOrchestrator()
    await orchestrator.initialize(makeCtx() as never)
    const agent = await orchestrator.spawnAgent({ role: 'coder', model: MODEL }, { task: 't' })

    // `spawnAgent` leaves the agent `idle`: alive, between tasks. It is NOT
    // yet `working` — that only happens once `executeTask` issues the prompt,
    // which the sibling test below observes for real rather than by hand.
    expect(onlySession(orchestrator.getState()).state).toBe('idle')

    // An agent with no session yet is not a session row. There is no id to key
    // it by, and inventing one would put a phantom in a list a user trusts.
    agent.sessionID = undefined
    expect(orchestrator.getState().sessions).toEqual([])

    await orchestrator.shutdown()
  })

  /**
   * The regression this file exists to prevent, in the form it actually
   * shipped: `sessionStateOfAgent` mapped `working` to `running` correctly all
   * along, and `executeTask` — the PRIMARY execution path — never assigned
   * `'working'` at all. The agent therefore sat at `idle` for the whole of its
   * task, and a session actively burning tokens rendered as `idle`.
   *
   * The earlier version of this test set `agent.status = 'working'` by hand and
   * asserted the mapping, which passed for the wrong reason: it exercised the
   * switch, not the code that was supposed to reach it. The hand-set is gone,
   * and the transition is now observed from a task that is genuinely in flight.
   */
  it('reports a task that is in flight as running, and settles it afterwards', async () => {
    const gate = promptLatch()
    const ctx = makeCtx({ promptGate: gate })

    // `detach` starts the task and returns without awaiting it, so the task is
    // suspended inside `prompt` while this test inspects state. The latch is
    // the ONLY window in which the `working` status exists, and asserting
    // before releasing it is the whole point: the pre-fix code reported `idle`
    // for the entire duration, and only differed from the correct answer after
    // the task was already over.
    const { orchestrator, settled } = await runTask(ctx, { detach: true })
    await gate.waitUntilEntered()

    // The ctx really was held — otherwise the assertions below would be
    // observing a finished task and pass for the wrong reason.
    expect(ctx.session.prompt).toHaveBeenCalled()

    const inFlight = orchestrator.getState()
    // Both views, because the page reads the session row for the sessions
    // table and the agent row for the agent grid, and both derive from the same
    // field. Fixing one without the other would leave a split-brain page.
    expect(inFlight.sessions[0]?.state).toBe('running')
    expect(inFlight.agents[0]?.status).toBe('working')

    gate.release()
    await settled

    // After the task settles the `finally` puts the agent back down, and
    // `running` must not be what it lands on — a stuck `working` would be its
    // own lie, and would keep the page's `Running` filter permanently lit.
    const after = orchestrator.getState()
    expect(after.sessions[0]?.state).not.toBe('running')
    expect(after.agents[0]?.status).not.toBe('working')
    // A successful task leaves the agent `idle` specifically: alive, between
    // tasks. This is the value the PRE-FIX run also produced, which is exactly
    // why the in-flight assertions above are the ones with teeth.
    expect(after.agents[0]?.status).toBe('idle')
    expect(after.sessions[0]?.state).toBe('idle')

    await orchestrator.shutdown()
  })

  it('associates a session with the task its agent was assigned', async () => {
    const orchestrator = new NexusOrchestrator()
    await orchestrator.initialize(makeCtx() as never)
    const agent = await orchestrator.spawnAgent({ role: 'coder', model: MODEL }, { task: 't' })
    orchestrator['tasks'].set('task-9', {
      id: 'task-9', name: 'n', description: 'd', requiredRole: 'coder',
      complexity: COMPLEXITY, dependencies: [], files: { include: [] },
      priority: 'high', status: 'running', assignedAgent: agent.id,
    })

    expect(onlySession(orchestrator.getState()).taskId).toBe('task-9')

    await orchestrator.shutdown()
  })

  it('leaves no residue when a task settles normally', async () => {
    const ctx = makeCtx()
    const { orchestrator } = await runTask(ctx)

    // No collection was armed — nothing timed out — so the session is just an
    // agent's session, with no ledger row and nothing uncollected.
    expect(orchestrator['deltaLedgers'].size).toBe(0)
    expect(orchestrator['uncollected'].size).toBe(0)
    expect(onlySession(orchestrator.getState()).observedUncollected).toBe(0)
    // The one added line is `evicted`, the block that makes the `uncollected`
    // cap visible. It is asserted at its zero value rather than left out of the
    // `toEqual`, because an absent key and a present-and-zero key are different
    // claims: only the second says "nothing was dropped". A third `toEqual`
    // like this one exists in `test/task-cost.test.ts`, so the count is three
    // sites in two files.
    expect(JSON.parse(orchestrator.getCostReport()).uncollected).toEqual({
      sessions: 0, lastKnownTokens: 0, observedUncollected: 0, taskIds: [], entries: [],
      evicted: { sessions: 0, lastKnownTokens: 0, observedUncollected: 0, cap: 200 },
    })

    await orchestrator.shutdown()
  })
})

/**
 * Time a task out, terminate its agent, and return the live orchestrator.
 *
 * `settle: 'pending'` leaves the collection outstanding (a long grace window
 * and no read), which is the mid-flight state. `settle: 'abandon'` lets the
 * real deadline probe run — a short grace window plus a `session.get` that
 * shows the session still busy — because `flushTimeoutDeltas()` is the
 * shutdown path and SETTLES a ledger rather than abandoning it, so it is the
 * wrong lever here.
 *
 * At module scope rather than inside the timeout suite, because it is also how
 * the cap suite reaches the REAL abandon path: `abandonTimeoutDelta` is what
 * calls `trimUncollected`, and a helper that only the timeout tests can reach
 * would leave the cap's production wiring untestable.
 */
async function timedOutThenTerminated(opts: {
  atTimeout: Tokens
  atProbe: Tokens
  settle: 'pending' | 'abandon'
}) {
  // `settle: 'pending'` leaves the collection outstanding — a long grace
  // window, so the mid-flight state is still there when the test reads it.
  // `settle: 'abandon'` uses a short window and lets the real deadline probe
  // run, because `flushTimeoutDeltas()` is the shutdown path and SETTLES a
  // ledger rather than abandoning it, so it is the wrong lever here. The
  // window is read when the ledger is armed, hence the two configurations.
  const graceMs = opts.settle === 'abandon' ? 40 : 60_000
  const ctx = makeCtx({ tokenSequence: [opts.atTimeout, opts.atProbe], waitNever: true })
  // Registered BEFORE the task runs, so the deadline probe's event cannot
  // fire into a listener that is not attached yet. The test then waits on the
  // event rather than on a sleep, so it does not depend on the timer firing
  // within some arbitrary budget.
  let deltaSeen!: Promise<void>
  const { orchestrator, agent } = await runTask(ctx, {
    taskTimeoutMs: 30,
    graceMs,
    onReady: (o) => {
      deltaSeen = new Promise<void>(resolve => { o.on('cost:delta', () => resolve()) })
    },
    afterTask: async (o, a) => {
      await o.terminateAgent(a.id)
    },
  })
  if (opts.settle === 'abandon') {
    await Promise.race([deltaSeen, Bun.sleep(2000)])
  }
  return { orchestrator, agent }
}

describe('the timed-out session whose agent was terminated', () => {
  // The case this whole projection exists for. On timeout the task fails,
  // `handleFailure` calls `terminateAgent`, and the agent is removed from
  // `this.agents` — while the session is NOT aborted and keeps generating and
  // spending. It was therefore invisible on every layer.

  it('is still reachable in the state, as an unowned running session', async () => {
    const { orchestrator, agent } = await timedOutThenTerminated({
      atTimeout: usage(150_000, 10_000),
      atProbe: usage(400_000, 30_000),
      settle: 'pending',
    })

    // The precondition this rests on: the agent really is gone.
    expect(orchestrator.getState().agents).toEqual([])
    expect(orchestrator['deltaLedgers'].size).toBe(1)

    const row = onlySession(orchestrator.getState())

    expect(row.id).toBe(SESSION_ID)
    // THE ASSERTION. Not in `agents`, and named here with nothing owning it.
    expect(row.owned).toBe(false)
    expect(row.agentId).toBeNull()
    expect(row.role).toBeNull()
    // Still running, and still being billed, so `state` is not 'abandoned'.
    expect(row.state).toBe('running')
    expect(row.taskId).toBe('node-1')
    expect(row.model).toBe(MODEL)
    // The cumulative usage already charged for it — a real read, not a guess.
    expect(row.lastKnownTokens).toBe(160_000)
    expect(row.observedUncollected).toBe(0)

    await orchestrator.shutdown()
  })

  it('becomes abandoned, with the unbilled remainder attributed to it', async () => {
    const { orchestrator } = await timedOutThenTerminated({
      atTimeout: usage(150_000, 10_000),
      atProbe: usage(400_000, 30_000),
      settle: 'abandon',
    })

    const row = onlySession(orchestrator.getState())

    expect(row.state).toBe('abandoned')
    // Still nobody's, and now with spend that happened and was not billed.
    expect(row.owned).toBe(false)
    expect(row.agentId).toBeNull()
    expect(row.lastKnownTokens).toBe(430_000)
    // 250k in + 20k out past the timeout charge, priced at sonnet's per-1K rates.
    expect(row.observedUncollected).toBeCloseTo(
      250_000 / 1000 * SONNET.input + 20_000 / 1000 * SONNET.output, 12)
    expect(row.observedUncollected).toBeGreaterThan(0)

    await orchestrator.shutdown()
  })

  it('names the abandoned session in the cost report, not just its task', async () => {
    const { orchestrator, agent } = await timedOutThenTerminated({
      atTimeout: usage(150_000, 10_000),
      atProbe: usage(400_000, 30_000),
      settle: 'abandon',
    })

    const uncollected = JSON.parse(orchestrator.getCostReport()).uncollected

    // `taskIds` alone cannot answer "which session", and the agent that owned
    // it is gone, so the session id is the only durable handle there is.
    expect(uncollected.entries).toEqual([{
      sessionID: SESSION_ID,
      taskId: 'node-1',
      agentId: agent.id,
      model: MODEL,
      lastKnownTokens: 430_000,
      observedUncollected: uncollected.observedUncollected,
    }])
    // The agent id is the one the session HAD. Reporting it as if the agent were
    // still there would be the fabrication the sessions view exists to avoid —
    // which is why `entries.agentId` is provenance and `sessions[].agentId` is
    // resolved against `this.agents`.
    expect(orchestrator.getState().sessions[0]?.agentId).toBeNull()
    expect(uncollected.taskIds).toEqual(['node-1'])
    // And the cap is INERT on the real write path: one genuinely abandoned
    // session, through `abandonTimeoutDelta` by way of the deadline probe, and
    // nothing is dropped. The cap's own tests drive the map and the trim
    // directly, so this is what proves the production path calls the trim at
    // all — an unreached `trimUncollected()` would pass all four of them.
    expect(uncollected.evicted).toEqual({
      sessions: 0, lastKnownTokens: 0, observedUncollected: 0, cap: 200,
    })

    await orchestrator.shutdown()
  })

  it('settles back to nothing when the orphan session is in fact collected', async () => {
    // The happy path for the orphan: the session goes idle inside the grace
    // window, the remainder is billed, and the obligation must disappear rather
    // than linger as a stale collection or a stale session row.
    const ctx = makeCtx({
      tokenSequence: [usage(150_000, 10_000), usage(250_000, 20_000)],
      waitResolvesAfterMs: 40,
    })
    let deltaSeen!: Promise<Record<string, unknown>>
    const { orchestrator, agent } = await runTask(ctx, {
      taskTimeoutMs: 30,
      graceMs: 60_000,
      onReady: (o) => {
        deltaSeen = new Promise<Record<string, unknown>>(resolve => {
          o.on('cost:delta', (d: Record<string, unknown>) => resolve(d))
        })
      },
    })
    const delta = await Promise.race([deltaSeen, Bun.sleep(2000).then(() => null)])

    // Non-vacuity: a collection really was armed and really was settled, with
    // the increment charged. Without this the assertions below would also hold
    // on a run that never timed out at all.
    expect(delta).not.toBeNull()
    expect(delta?.reason).toBe('session-idle')
    expect(delta?.deltaCost).toBeGreaterThan(0)
    expect(delta?.uncollected).toBeUndefined()

    expect(orchestrator['deltaLedgers'].size).toBe(0)
    expect(orchestrator['uncollected'].size).toBe(0)
    expect(JSON.parse(orchestrator.getCostReport()).uncollected.sessions).toBe(0)
    // The spend was collected, so the session row carries none of it. The agent
    // was terminated by the timeout, so the row reads 'settled' — the session
    // is not abandoned and not expected to spend more, and that is a different
    // answer from 'idle'.
    const state = orchestrator.getState()
    expect(state.sessions).toHaveLength(1)
    expect(state.sessions[0]?.state).toBe('settled')
    expect(state.sessions[0]?.observedUncollected).toBe(0)

    await orchestrator.terminateAgent(agent.id)
    // And once the agent is gone, the session is simply gone with it: an
    // unowned session with no collection behind it is not a thing nexus tracks.
    expect(orchestrator.getState().sessions).toEqual([])

    await orchestrator.shutdown()
  })
})

describe('getState().tasks', () => {
  let orchestrator: NexusOrchestrator

  beforeEach(() => {
    orchestrator = new NexusOrchestrator()
  })

  afterEach(async () => {
    await orchestrator.shutdown()
  })

  it('carries the DAG edges, so a dependency graph is not a flat list', () => {
    orchestrator['tasks'].set('a', {
      id: 'a', name: 'a', description: '', requiredRole: 'coder', complexity: COMPLEXITY,
      dependencies: [], files: { include: [] }, priority: 'high', status: 'pending',
    })
    orchestrator['tasks'].set('b', {
      id: 'b', name: 'b', description: '', requiredRole: 'reviewer', complexity: COMPLEXITY,
      // The edges that were previously dropped on the floor.
      dependencies: ['a'], files: { include: [] }, priority: 'critical', status: 'pending',
      assignedAgent: 'agent-1',
    })

    const state = orchestrator.getState()
    const byId = new Map(state.tasks.map(t => [t.id, t]))

    expect(byId.get('b')?.dependencies).toEqual(['a'])
    // Empty, never null, so a client can tell "no edges" from "not reported".
    expect(byId.get('a')?.dependencies).toEqual([])
    expect(byId.get('b')?.priority).toBe('critical')
    expect(byId.get('b')?.assignedAgent).toBe('agent-1')
  })

  it('carries a finished task\'s cost and tokens, and truncates only the output', () => {
    orchestrator['tasks'].set('a', {
      id: 'a', name: 'a', description: '', requiredRole: 'coder', complexity: COMPLEXITY,
      dependencies: [], files: { include: [] }, priority: 'normal', status: 'completed',
      result: {
        success: true,
        output: 'x'.repeat(900),
        duration: 1234,
        tokensUsed: 4321,
        cost: 0.1234,
      },
    })

    const task = orchestrator.getState().tasks[0]

    expect(task?.cost).toBeCloseTo(0.1234, 12)
    expect(task?.tokensUsed).toBe(4321)
    expect(task?.result?.success).toBe(true)
    expect(task?.result?.duration).toBe(1234)
    expect(task?.result?.output).toHaveLength(500)
  })

  it('omits cost and tokens for a task with no result, rather than reporting zero spend', () => {
    orchestrator['tasks'].set('a', {
      id: 'a', name: 'a', description: '', requiredRole: 'coder', complexity: COMPLEXITY,
      dependencies: [], files: { include: [] }, priority: 'normal', status: 'pending',
    })

    const task = orchestrator.getState().tasks[0]

    // `undefined`, not 0: a task that has not run has not spent nothing, it has
    // no figure at all, and 0 would read as a measured total.
    expect(task?.cost).toBeUndefined()
    expect(task?.tokensUsed).toBeUndefined()
    expect(task?.result).toBeUndefined()
  })
})

describe('getState().agents', () => {
  it('carries the token and error metrics it was already collecting', async () => {
    const orchestrator = new NexusOrchestrator()
    await orchestrator.initialize(makeCtx() as never)
    const agent = await orchestrator.spawnAgent({ role: 'coder', model: MODEL }, { task: 't' })
    agent.metrics.totalTokens = 1234
    agent.metrics.averageResponseTime = 567
    agent.metrics.errorRate = 0.25

    const row = orchestrator.getState().agents[0]

    expect(row?.spawnedAt).toBe(agent.spawnedAt.toISOString())
    expect(row?.sessionID).toBe(SESSION_ID)
    expect(row?.totalTokens).toBe(1234)
    expect(row?.averageResponseTime).toBe(567)
    expect(row?.errorRate).toBe(0.25)

    await orchestrator.shutdown()
  })
})

describe('getState().config', () => {
  it('carries the resolved config under its real key names', async () => {
    const orchestrator = new NexusOrchestrator({
      budget: { maxTotalCost: 12.5, maxCostPerTask: 1, maxCostPerAgent: 2, alertThreshold: 0.25, hardLimit: true },
    })
    await orchestrator.initialize(makeCtx() as never)

    const { config } = orchestrator.getState()

    // `maxTotalCost` — NOT `maxBudget` or `max`, which the page was reading and
    // which do not exist. `alertThreshold` is the only threshold; there is no
    // `criticalThreshold` or `criticalPct` on either side.
    expect(config.budget.maxTotalCost).toBe(12.5)
    expect(config.budget.alertThreshold).toBe(0.25)
    // `hardLimit` — NOT `autoTerminate`, and with the opposite sense to what
    // that name suggests: true means "stop at the ceiling", it does not mean
    // "cleanly terminate the agents at the ceiling".
    expect(config.budget.hardLimit).toBe(true)
    // `enabled` — NOT `retryOnFailure`. There is no `escalation` or
    // `deadlockDetection` key, because no such configuration exists;
    // `maxRetries` is the retry knob.
    expect(config.selfHealing.enabled).toBe(true)
    expect(config.selfHealing.maxRetries).toBe(3)
    expect(config.selfHealing.contextTransfer).toBe(true)
    // The resolved role -> model map, read live so a session-scoped override is
    // reflected rather than a load-time snapshot.
    expect(Object.keys(config.models).length).toBeGreaterThan(0)
    expect(config.models.coder).toBeString()

    await orchestrator.shutdown()
  })

  it('reports the budget in force, which `execute()` can replace', async () => {
    const orchestrator = new NexusOrchestrator({
      budget: { maxTotalCost: 10, maxCostPerTask: 1, maxCostPerAgent: 2, alertThreshold: 0.2, hardLimit: false },
    })
    await orchestrator.initialize(makeCtx() as never)

    expect(orchestrator.getState().config.budget.maxTotalCost).toBe(10)

    // A caller-supplied budget is what spend is measured against for the run,
    // so the config the state publishes has to be that one — a panel reading
    // the configured ceiling while the run enforces another would lie by
    // omission.
    orchestrator['budget'] = { ...orchestrator['budget'], maxTotalCost: 3 }

    expect(orchestrator.getState().config.budget.maxTotalCost).toBe(3)
    expect(orchestrator.getState().budgetRemaining).toBeCloseTo(3, 12)

    await orchestrator.shutdown()
  })
})

describe('the broadcaster lifecycle', () => {
  it('is wired by `initialize()`, which had no caller for it at all before', async () => {
    const orchestrator = new NexusOrchestrator()
    expect(orchestrator.broadcaster).toBeNull()

    await orchestrator.initialize(makeCtx() as never)

    // `initBroadcaster()` used to have no caller anywhere in `src/`, so in
    // production `broadcaster` was null and the throttled state push chained
    // onto the state-change callback was a no-op at every `notifyStateChange()`.
    expect(orchestrator.broadcaster).not.toBeNull()

    await orchestrator.shutdown()
  })

  it('is torn down by `shutdown()`', async () => {
    const orchestrator = new NexusOrchestrator()
    await orchestrator.initialize(makeCtx() as never)
    expect(orchestrator.broadcaster).not.toBeNull()

    await orchestrator.shutdown()

    // Null, not merely destroyed: a dashboard that reconnected after teardown
    // would otherwise push into a broadcaster whose subscriptions are gone.
    expect(orchestrator.broadcaster).toBeNull()
  })

  it('broadcasts the shutdown event before it tears itself down', async () => {
    const orchestrator = new NexusOrchestrator()
    await orchestrator.initialize(makeCtx() as never)
    const seen: string[] = []
    orchestrator.on('orchestrator:shutdown', () => seen.push('shutdown'))

    await orchestrator.shutdown()

    // A client that is about to have its socket closed underneath it must still
    // hear why.
    expect(seen).toEqual(['shutdown'])
  })

  it('still calls the state-change callback exactly once per change', async () => {
    const orchestrator = new NexusOrchestrator()
    let calls = 0
    await orchestrator.initialize(makeCtx() as never, () => { calls++ })
    orchestrator.initBroadcaster({ throttleMs: 10_000 })

    orchestrator.notifyStateChange()
    orchestrator.notifyStateChange()
    await Bun.sleep(200)

    // Debounced, and NOT doubled by the broadcaster: `initBroadcaster()` used to
    // chain the previous callback into a new closure, so a second call would
    // have invoked it twice per change.
    expect(calls).toBe(1)
    expect(orchestrator.broadcaster).not.toBeNull()

    await orchestrator.shutdown()
  })
})

describe('the uncollected cap', () => {
  // The leak this bounds is pre-existing: the only `delete` on `uncollected` was
  // on the successful settle path, so the map grew by one entry per abandoned
  // session for the life of the process. It became a real problem when
  // `sessionViews()` started iterating the map on every `getState()` — which
  // runs on every throttled socket push and every `/api/state` — so the leak
  // began shipping a growing payload to every connected client forever.
  //
  // A CAP rather than a TTL, and the reason is not a preference: a TTL would
  // key off the session's own `time.idle`, and an abandoned session is by
  // definition one that never went idle (or whose read of it failed every
  // retry). `readSessionTokens` coerces that missing stamp to 0 for exactly
  // this reason, so an honest TTL would need scheduled re-reads of the session
  // API — async work, from a synchronous projection — for a record whose entire
  // content is "we stopped watching this".
  //
  // 200 abandoned sessions is far past what a real run reaches: an entry
  // requires a task to time out AND its collection to be given up on. The tests
  // drive the map directly rather than timing out 201 real tasks, using the same
  // bracket-access escape hatch the rest of this file uses to read internals.
  const CAP = 200

  /** The `uncollected` map, typed from the private field. */
  function uncollectedMap(o: NexusOrchestrator): Map<string, {
    sessionID: string; taskId: string; agentId: string; model: string
    lastKnownTokens: number; observedUncollected: number
  }> {
    return o['uncollected']
  }

  /** Seed one entry WITHOUT trimming, so the cap state under test is explicit. */
  function seedEntry(o: NexusOrchestrator, n: number, lastKnownTokens: number): void {
    uncollectedMap(o).set(`ses_${n}`, {
      sessionID: `ses_${n}`,
      taskId: `node-${n}`,
      agentId: `agent-${n}`,
      model: MODEL,
      lastKnownTokens,
      observedUncollected: lastKnownTokens / 1000 * SONNET.input,
    })
  }

  /** Seed one entry, then trim — the two halves of the write path, in order. */
  function abandon(o: NexusOrchestrator, n: number, lastKnownTokens: number): void {
    seedEntry(o, n, lastKnownTokens)
    o['trimUncollected']()
  }

  /**
   * Abandon a session the way PRODUCTION does: through `abandonTimeoutDelta`,
   * the method the deadline probe calls when a timed-out session refuses to
   * settle, and the one that ends with `this.trimUncollected()`.
   *
   * This is the distinction the test below turns on. Calling `abandon()` above
   * invokes the trim BY HAND, so it proves the trim's arithmetic and nothing
   * about whether anything calls it; calling this proves the call is there. The
   * ledger is a minimal cast because only `sessionID`, `agent`, `charged` and
   * `model` are read on this path — the rest of the interface belongs to the
   * settlement path, which is not what is under test.
   */
  function abandonViaRealPath(o: NexusOrchestrator, sessionID: string): void {
    o['abandonTimeoutDelta'](
      {
        sessionID,
        agent: { id: `agent-${sessionID}`, metrics: { totalCost: 0, totalTokens: 0 } },
        charged: usage(1000, 100),
        model: MODEL,
      } as never,
      usage(9000, 900),
      'abandoned',
    )
  }

  function report(o: NexusOrchestrator) {
    return JSON.parse(o.getCostReport()).uncollected as {
      sessions: number
      lastKnownTokens: number
      observedUncollected: number
      taskIds: string[]
      entries: Array<{ sessionID: string; lastKnownTokens: number; observedUncollected: number }>
      evicted: {
        sessions: number
        lastKnownTokens: number
        observedUncollected: number
        cap: number
      }
    }
  }

  it('is not reached by 200 abandoned sessions, so nothing is itemised away', () => {
    const orchestrator = new NexusOrchestrator()
    for (let n = 1; n <= CAP; n++) abandon(orchestrator, n, 1000)

    const un = report(orchestrator)
    // The cap is inclusive: exactly `cap` entries survive, and the 200th is
    // still there. An off-by-one that trimmed at `>=` would drop a session for
    // no reason at the boundary, which is the shape of bug a cap is easiest to
    // introduce and hardest to notice.
    expect(un.sessions).toBe(CAP)
    expect(un.entries).toHaveLength(CAP)
    expect(un.entries[0]?.sessionID).toBe('ses_1')
    expect(un.evicted.sessions).toBe(0)
    expect(un.evicted.cap).toBe(CAP)
  })

  it('evicts the OLDEST first, so the most recent abandonment is the one kept', () => {
    const orchestrator = new NexusOrchestrator()
    for (let n = 1; n <= CAP + 3; n++) abandon(orchestrator, n, 1000)

    const un = report(orchestrator)
    // FIFO, and only three dropped: `ses_1`, `ses_2`, `ses_3`. The survivors are
    // a contiguous tail — 4 through 203 — which is what makes the order
    // assertion below able to state "oldest went, newest stayed" without
    // restating 200 ids. Those three survivors are exactly the ones a reader
    // could still act on, being the sessions closest to having been terminated.
    const ids = un.entries.map(e => e.sessionID)
    expect(ids).toHaveLength(CAP)
    expect(ids[0]).toBe('ses_4')
    expect(ids[ids.length - 1]).toBe(`ses_${CAP + 3}`)
    expect(un.evicted.sessions).toBe(3)
    expect(un.evicted.lastKnownTokens).toBe(3000)
    expect(un.taskIds).toHaveLength(CAP)
  })

  it('carries the evicted money forward, so the under-count never silently shrinks', () => {
    // The whole point of the `evicted` block. Eviction is not free: the dropped
    // session leaves `entries` and `sessions[]` below, and if its sums went with
    // it then a bounded map would read as "we are under-billing by less than we
    // were" — the exact silent-shrinking-number failure the block exists to
    // prevent.
    const orchestrator = new NexusOrchestrator()
    for (let n = 1; n <= CAP; n++) abandon(orchestrator, n, 2000)
    const before = report(orchestrator)
    // Pushes past the cap, so the NEWEST entry (`ses_201`, 5000 tokens) is added
    // and the OLDEST (`ses_1`, 2000 tokens) is what leaves. FIFO is the whole
    // point of the previous test, so the arithmetic here is: +5000 in, -2000
    // out, leaving the surviving total HIGHER than it was a moment ago.
    abandon(orchestrator, CAP + 1, 5000)

    const after = report(orchestrator)
    expect(after.lastKnownTokens).toBe(before.lastKnownTokens - 2000 + 5000)
    // The evicted figures are the DROPPED entry's, not the new one's.
    expect(after.evicted.sessions).toBe(1)
    expect(after.evicted.lastKnownTokens).toBe(2000)
    expect(after.evicted.observedUncollected).toBeCloseTo(2000 / 1000 * SONNET.input, 12)
    // And the two blocks still account for every session ever abandoned, so the
    // magnitude is fully recoverable by a reader who adds them.
    expect(after.sessions + after.evicted.sessions).toBe(CAP + 1)
    // `observedUncollected` keeps its meaning: it is the sum over the entries
    // the reader can SEE, and the evicted block is a separate lower bound rather
    // than something folded into it. Both are lower bounds in the same
    // direction, so adding them is still a lower bound.
    const expectedSurviving = (CAP - 1) * (2000 / 1000 * SONNET.input) + (5000 / 1000 * SONNET.input)
    expect(after.observedUncollected).toBeCloseTo(expectedSurviving, 12)
    expect(after.observedUncollected + after.evicted.observedUncollected)
      .toBeCloseTo((CAP * 2000 + 5000) / 1000 * SONNET.input, 12)
  })

  it('trims on the REAL abandon path, so the cap is not a test-only fiction', async () => {
    // The four tests above drive the map and `trimUncollected` DIRECTLY. That
    // makes them white-box: they pin the trim's arithmetic exactly, and they
    // would ALL stay green with the single `this.trimUncollected()` call at the
    // end of `abandonTimeoutDelta` deleted — i.e. with the cap absent from
    // production entirely. Given this whole change is about a leak that shipped
    // silently, and that every one of these assertions is about bounding it,
    // leaving the wiring unasserted was the wrong place to economise.
    //
    // So: seed the map to just under the cap, then drive genuine abandonments
    // through the real path and require that they evict. Seeding is still
    // white-box, and that is the point: the variable under test is not the FIFO
    // arithmetic, which the tests above own, but whether PRODUCTION CODE ever
    // asks for the trim.
    const orchestrator = new NexusOrchestrator()
    for (let n = 1; n <= CAP; n++) seedEntry(orchestrator, n, 1000)
    // Precondition: full, not over, and nothing evicted yet — so any eviction
    // below is attributable to a real abandon and not to the seeding.
    expect(orchestrator['uncollected'].size).toBe(CAP)
    expect(report(orchestrator).evicted.sessions).toBe(0)

    // THE REAL PATH. `abandonTimeoutDelta` is the method the deadline probe
    // calls when a timed-out session will not settle, and it is the method that
    // ends with `this.trimUncollected()`. Deleting that one line is what this
    // test exists to catch.
    abandonViaRealPath(orchestrator, 'ses_real_1')
    expect(orchestrator['uncollected'].size).toBe(CAP)
    expect(orchestrator['uncollected'].has('ses_1')).toBe(false)
    expect(orchestrator['uncollected'].has('ses_real_1')).toBe(true)
    expect(report(orchestrator).evicted.sessions).toBe(1)

    // Once more, to show it is not a one-shot: the oldest survivor goes next,
    // and the evicted count accumulates.
    abandonViaRealPath(orchestrator, 'ses_real_2')
    expect(orchestrator['uncollected'].size).toBe(CAP)
    expect(orchestrator['uncollected'].has('ses_2')).toBe(false)
    expect(report(orchestrator).evicted.sessions).toBe(2)
    expect(report(orchestrator).evicted.lastKnownTokens).toBe(2000)
    // The newest abandonment is always the survivor — the one a reader could
    // still act on, being closest to having been terminated.
    expect(orchestrator['uncollected'].has('ses_real_2')).toBe(true)

    // And the real production entry point, a genuine task timeout whose
    // deadline probe gives up, writes through the same method and is capped by
    // it. This is the path with no private access at all.
    const { orchestrator: live } = await timedOutThenTerminated({
      atTimeout: usage(150_000, 10_000),
      atProbe: usage(400_000, 30_000),
      settle: 'abandon',
    })
    const un = report(live)
    expect(un.sessions).toBe(1)
    expect(un.entries[0]?.sessionID).toBe(SESSION_ID)
    // Full to the brim: the trim the probe's abandon just performed left it
    // bounded, and the seeded 200 are what a second abandon would evict.
    for (let n = 1; n <= CAP - 1; n++) seedEntry(live, n, 1000)
    expect(live['uncollected'].size).toBe(CAP)
    expect(un.evicted.sessions).toBe(0)

    await live.shutdown()
    await orchestrator.shutdown()
  })

  it('makes an evicted session vanish from sessions[], which is what the cap costs', () => {
    // Pinned as a VISIBLE loss, in the direction that matters: the row is gone
    // from the state the page renders. This is the legibility price of the cap,
    // asserted rather than described, because a doc comment saying "an evicted
    // entry stops appearing" is not a thing that fails when it stops being true.
    const orchestrator = new NexusOrchestrator()
    for (let n = 1; n <= CAP + 1; n++) abandon(orchestrator, n, 1000)

    const ids = orchestrator.getState().sessions.map(s => s.id)
    expect(ids).toHaveLength(CAP)
    expect(ids).not.toContain('ses_1')
    expect(ids).toContain(`ses_${CAP + 1}`)
    // `getState()` stays bounded, which is the reason the cap exists: this is
    // the payload every throttled push and every `/api/state` serialises.
    expect(orchestrator.getState().sessions).toHaveLength(CAP)
  })
})
