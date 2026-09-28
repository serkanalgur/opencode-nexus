import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import * as realOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The plugin writes its generated agent files into homedir()/.config/opencode
// and the config manager reads homedir()/.config/opencode/nexus.jsonc. Under
// `bun test`, changing process.env.HOME does NOT affect os.homedir(), so the
// module is mocked instead — otherwise these tests would read the developer's
// real global config and overwrite their real agent files. This must run before
// the modules under test are loaded, hence the dynamic imports below.
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'nexus-home-'))
const REAL_HOME = realOs.homedir()
mock.module('node:os', () => ({ ...realOs, default: realOs, homedir: () => SANDBOX_HOME }))

const { NexusOrchestrator } = await import('../src/orchestrator')
const { default: plugin } = await import('../src/index')

/**
 * Covers both child-session creation paths in `spawnAgent`:
 *
 *  - subagent-tool path: a tool context is supplied, so OpenCode's built-in
 *    `subagent` tool is invoked with a fabricated tool context. The child
 *    session ID comes from the tool's `progress` callback, and
 *    `ctx.session.create` must NOT be called.
 *  - session-create path: no tool context (internal scheduler / respawn call
 *    sites), so the previous `ctx.session.create()` behaviour is preserved.
 *
 * The last describe block boots the real plugin and drives the `spawn` /
 * `delegate` executors, proving the single-delivery guard: the task is sent
 * through the subagent tool on the linked path, and through `ctx.session.prompt`
 * only on the create fallback.
 */

const CHILD_SESSION_ID = 'ses_child_123'
const CREATED_SESSION_ID = 'session-from-create'

// Restore the real os module for any other test file in the same process.
afterAll(() => {
  mock.module('node:os', () => realOs)
})

function createCtx(opts: { withToolDomain: boolean; subagentCalls?: any[] }) {
  const subagentCalls = opts.subagentCalls ?? []

  const ctx: any = {
    // Empty project dir → configManager falls back to built-in defaults
    location: { directory: mkdtempSync(join(tmpdir(), 'nexus-project-')) },
    session: {
      create: mock(() => Promise.resolve({ id: CREATED_SESSION_ID })),
      switchAgent: mock(() => Promise.resolve()),
      switchModel: mock(() => Promise.resolve()),
      prompt: mock(() => Promise.resolve()),
      wait: mock(() => Promise.resolve()),
      context: mock(() => Promise.resolve([])),
      background: mock(() => Promise.resolve()),
      hook: mock(() => Promise.resolve()),
    },
    storage: {
      set: mock(() => Promise.resolve()),
      get: mock(() => Promise.resolve(null)),
    },
  }

  if (opts.withToolDomain) {
    ctx.tool = {
      list: mock(() => Promise.resolve([
        {
          id: 'subagent',
          name: 'subagent',
          options: {},
          description: 'Spawn a subagent',
          input: {},
          output: {},
          // The real tool reports the child session via progress, then runs the
          // child in the background because `background: true`.
          execute: mock((input: any, context: any) => {
            subagentCalls.push({ input, context })
            return (async () => {
              await context.progress({ sessionID: CHILD_SESSION_ID, status: 'running' })
              return { title: input.description, metadata: {} }
            })()
          }),
        },
      ])),
    }
  }

  return { ctx, subagentCalls }
}

function newOrchestrator(ctx: any) {
  return new NexusOrchestrator({
    budget: { maxTotalCost: 10.00, maxCostPerTask: 1.00, alertThreshold: 0.2, hardLimit: false }
  })
}

/** Run `fn` with console.warn silenced and captured. */
async function withCapturedWarnings<T>(fn: () => Promise<T>): Promise<{ result: T; warnings: any }> {
  const originalWarn = console.warn
  const warnings: any[] = []
  console.warn = mock((...args: any[]) => { warnings.push(args) })
  try {
    const result = await fn()
    return { result, warnings }
  } finally {
    console.warn = originalWarn
  }
}

describe('spawnAgent — subagent tool path', () => {
  let orchestrator: InstanceType<typeof NexusOrchestrator>
  let ctx: any
  let subagentCalls: any[]

  beforeEach(async () => {
    const made = createCtx({ withToolDomain: true })
    ctx = made.ctx
    subagentCalls = made.subagentCalls
    orchestrator = newOrchestrator(ctx)
    await orchestrator.initialize(ctx)
  })

  it('creates the child via the subagent tool and returns its session id', async () => {
    const agent = await orchestrator.spawnAgent(
      { role: 'coder' },
      {
        toolContext: { sessionID: 'ses_parent', agent: 'nexus-orchestrator', messageID: 'msg_1', callID: 'call_1' },
        task: 'Implement the feature',
      },
    )

    expect(agent.sessionID).toBe(CHILD_SESSION_ID)
    expect(agent.spawnPath).toBe('subagent-tool')
    expect(ctx.session.create).not.toHaveBeenCalled()
    expect(orchestrator.lastDegradedSpawn).toBeNull()
  })

  it('passes the parent session, calling agent and full task to the subagent tool', async () => {
    await orchestrator.spawnAgent(
      { role: 'reviewer' },
      {
        toolContext: { sessionID: 'ses_parent', agent: 'nexus-orchestrator', messageID: 'msg_1', callID: 'call_1' },
        task: 'Review the diff carefully',
      },
    )

    expect(subagentCalls.length).toBe(1)
    const { input, context } = subagentCalls[0]
    // Child session is parent-linked by OpenCode from the tool context sessionID
    expect(context.sessionID).toBe('ses_parent')
    expect(context.agent).toBe('nexus-orchestrator')
    // The complete task text is delivered exactly once, via `prompt`
    expect(input.prompt).toBe('Review the diff carefully')
    expect(input.agent).toBe('nexus-reviewer')
    expect(input.background).toBe(true)
    expect(typeof input.model).toBe('string')
    expect(input.model.includes('/')).toBe(true)
    expect(typeof context.progress).toBe('function')
  })

  it('fails loudly when the calling agent id is missing instead of fabricating one', async () => {
    await expect(
      orchestrator.spawnAgent(
        { role: 'coder' },
        { toolContext: { sessionID: 'ses_parent' }, task: 'Do the thing' },
      ),
    ).rejects.toThrow(/calling agent id/)
    expect(ctx.session.create).not.toHaveBeenCalled()
  })

  it('surfaces subagent tool failures instead of hanging', async () => {
    ctx.tool.list = mock(() => Promise.resolve([
      {
        id: 'subagent',
        execute: mock(() => Promise.reject(new Error('Subagent denied'))),
      },
    ]))

    await expect(
      orchestrator.spawnAgent(
        { role: 'coder' },
        { toolContext: { sessionID: 'ses_parent', agent: 'nexus-orchestrator' }, task: 'Do the thing' },
      ),
    ).rejects.toThrow(/Subagent denied/)
  })
})

describe('spawnAgent — session.create path (no tool context)', () => {
  let orchestrator: InstanceType<typeof NexusOrchestrator>
  let ctx: any

  beforeEach(async () => {
    const made = createCtx({ withToolDomain: true })
    ctx = made.ctx
    orchestrator = newOrchestrator(ctx)
    await orchestrator.initialize(ctx)
  })

  it('falls back to ctx.session.create when no tool context is supplied', async () => {
    const { result: agent, warnings } = await withCapturedWarnings(() =>
      orchestrator.spawnAgent({ role: 'coder' }))

    expect(ctx.session.create).toHaveBeenCalled()
    expect(agent.sessionID).toBe(CREATED_SESSION_ID)
    expect(agent.spawnPath).toBe('session-create')
    // Degradation is observable
    expect(orchestrator.lastDegradedSpawn?.agentId).toBe(agent.id)
    expect(orchestrator.lastDegradedSpawn?.reason).toBe('no-parent-context')
    expect(warnings.length).toBeGreaterThan(0)
  })

  it('does not consult the tool list or any latched parent session without a tool context', async () => {
    const { result: agent } = await withCapturedWarnings(() =>
      orchestrator.spawnAgent({ role: 'tester' }))

    expect(ctx.tool.list).not.toHaveBeenCalled()
    expect(agent.spawnPath).toBe('session-create')
    expect(orchestrator.lastDegradedSpawn?.reason).toBe('no-parent-context')
  })

  it('falls back to session.create with reason subagent-tool-unavailable when the tool list is not an array', async () => {
    ctx.tool.list = mock(() => Promise.resolve({ subagent: 'not-an-array' }))
    const { result: agent } = await withCapturedWarnings(() =>
      orchestrator.spawnAgent(
        { role: 'coder' },
        { toolContext: { sessionID: 'ses_parent', agent: 'nexus-orchestrator' }, task: 'Do the thing' },
      ))

    expect(agent.spawnPath).toBe('session-create')
    expect(agent.sessionID).toBe(CREATED_SESSION_ID)
    expect(orchestrator.lastDegradedSpawn?.reason).toBe('subagent-tool-unavailable')
  })

  it('falls back to session.create with reason subagent-tool-unavailable when subagent is absent', async () => {
    ctx.tool.list = mock(() => Promise.resolve([{ id: 'bash', execute: mock(() => Promise.resolve({})) }]))
    const { result: agent } = await withCapturedWarnings(() =>
      orchestrator.spawnAgent(
        { role: 'coder' },
        { toolContext: { sessionID: 'ses_parent', agent: 'nexus-orchestrator' }, task: 'Do the thing' },
      ))

    expect(agent.spawnPath).toBe('session-create')
    expect(orchestrator.lastDegradedSpawn?.reason).toBe('subagent-tool-unavailable')
  })
})

// --- Plugin executor level: single task delivery (index.ts) ---

async function bootPlugin(opts: { withSubagentTool: boolean }) {
  const tools = new Map<string, any>()
  const subagentCalls: any[] = []

  const ctx: any = {
    location: { directory: mkdtempSync(join(tmpdir(), 'nexus-project-')) },
    storage: { set: mock(() => Promise.resolve()), get: mock(() => Promise.resolve(null)) },
    tool: {
      transform: mock(async (cb: any) => {
        cb({
          namespace: () => {},
          add: (t: any) => { tools.set(t.name, t) },
        })
      }),
      list: mock(() => Promise.resolve(
        opts.withSubagentTool
          ? [{
              id: 'subagent',
              execute: mock(async (input: any, context: any) => {
                subagentCalls.push({ input, context })
                await context.progress({ sessionID: CHILD_SESSION_ID, status: 'running' })
                return { title: input.description, metadata: {} }
              }),
            }]
          : [],
      )),
    },
    session: {
      create: mock(() => Promise.resolve({ id: CREATED_SESSION_ID })),
      prompt: mock(() => Promise.resolve()),
      wait: mock(() => Promise.resolve()),
      context: mock(() => Promise.resolve([])),
      background: mock(() => Promise.resolve()),
      hook: mock(() => Promise.resolve()),
    },
  }

  await plugin.setup(ctx)
  return { ctx, tools, subagentCalls }
}

describe('nexus.spawn executor — single task delivery', () => {
  it('does NOT call session.prompt when the child was created via the subagent tool', async () => {
    const { ctx, tools, subagentCalls } = await bootPlugin({ withSubagentTool: true })
    const spawn = tools.get('spawn')
    expect(spawn).toBeDefined()

    const result = await spawn.execute(
      { role: 'coder', task: 'Implement the parser', model: 'opencode/test-model' },
      { sessionID: 'ses_parent', agent: 'nexus-orchestrator', messageID: 'msg_1', id: 'call_1' },
    )

    expect(result.content).toContain(CHILD_SESSION_ID)
    // Task reached the child through the subagent tool, exactly once
    expect(subagentCalls.length).toBe(1)
    expect(subagentCalls[0].input.prompt).toBe('Implement the parser')
    expect(subagentCalls[0].context.sessionID).toBe('ses_parent')
    expect(ctx.session.create).not.toHaveBeenCalled()
    // A second delivery would duplicate the task (round-1 BLOCKING 3)
    expect(ctx.session.prompt).not.toHaveBeenCalled()
  })

  it('calls session.prompt exactly once when the spawn fell back to session.create', async () => {
    const { ctx, tools } = await bootPlugin({ withSubagentTool: false })
    const spawn = tools.get('spawn')

    const result = await withCapturedWarnings(async () =>
      spawn.execute(
        { role: 'coder', task: 'Implement the parser', model: 'opencode/test-model' },
        { sessionID: 'ses_parent', agent: 'nexus-orchestrator', messageID: 'msg_1', id: 'call_1' },
      ))

    expect(result.result.content).toContain(CREATED_SESSION_ID)
    expect(ctx.session.create).toHaveBeenCalled()
    expect(ctx.session.prompt).toHaveBeenCalledTimes(1)
    expect((ctx.session.prompt as any).mock.calls[0][0]).toEqual({
      sessionID: CREATED_SESSION_ID,
      text: 'Implement the parser',
    })
  })

  it('writes the generated agent files into the sandbox home, not the real one', async () => {
    await bootPlugin({ withSubagentTool: true })

    const sandboxAgentFile = join(SANDBOX_HOME, '.config', 'opencode', 'agents', 'nexus-coder.md')
    expect(existsSync(sandboxAgentFile)).toBe(true)
    // Every generated permission rule must carry an effect, or OpenCode drops
    // the agent from the registry
    const content = readFileSync(sandboxAgentFile, 'utf-8')
    const frontmatter = content.split('---')[1] ?? ''
    const ruleCount = (frontmatter.match(/action:/g) || []).length
    expect(ruleCount).toBeGreaterThan(0)
    expect((frontmatter.match(/effect:/g) || []).length).toBe(ruleCount)

    // The orchestrator agent must be allowed to spawn the nexus-* agents
    const orchestratorFile = join(SANDBOX_HOME, '.config', 'opencode', 'agents', 'nexus-orchestrator.md')
    expect(readFileSync(orchestratorFile, 'utf-8')).toContain('action: subagent')

    // The plugin must have written into the sandbox, never the real home
    expect(SANDBOX_HOME).not.toBe(REAL_HOME)
  })

  it('nexus.delegate does NOT re-prompt on the subagent tool path', async () => {
    const { ctx, tools, subagentCalls } = await bootPlugin({ withSubagentTool: true })
    const delegate = tools.get('delegate')
    expect(delegate).toBeDefined()

    // Real V2 shape: session messages are discriminated by `type` and an
    // assistant message's text lives in typed `content` parts. (The V1 fixture
    // `{ role: 'assistant', content: 'done' }` encoded the bug where the
    // plugin filtered on `role`, never matched, and reported a placeholder.)
    ctx.session.context = mock(() => Promise.resolve([
      { type: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ]))

    const result = await delegate.execute(
      { role: 'reviewer', task: 'Review the parser', model: 'opencode/test-model', timeout: 5000 },
      { sessionID: 'ses_parent', agent: 'nexus-orchestrator', messageID: 'msg_2', id: 'call_2' },
    )

    expect(result.content).toContain('done')
    expect(subagentCalls.length).toBe(1)
    expect(subagentCalls[0].input.prompt).toBe('Review the parser')
    expect(ctx.session.prompt).not.toHaveBeenCalled()
    // wait() still observes the child session created by the subagent tool
    expect(ctx.session.wait).toHaveBeenCalledWith({ sessionID: CHILD_SESSION_ID })
  })
})

/**
 * Issue #100, at the level it shipped: a spawn tool that gives up leaves the
 * agent it spawned sitting at `working` in the published state forever.
 *
 * The tools mark the agent `working` as soon as `spawnAgent` returns, and the
 * only writer of a terminal status on that path was the tool body's own success
 * branch. Every other exit — and the ordinary one is a `session.wait` that
 * REJECTS rather than timing out, which is what an aborted or evicted child
 * session does — returned "Failed to spawn agent" / "Delegate failed" to the
 * caller and dropped out with the row still `working`. The session row agreed,
 * because `sessionStateOfAgent` maps `working` to `running`: one dead session,
 * reported as spending in both views, with no way for a reader to tell.
 *
 * These read the state through the `dashboard` tool, which is `getState()`
 * verbatim — the same payload `/api/state` serves.
 */
describe('a spawn tool that gives up (issue #100)', () => {
  /** The published state, via the tool that serves `getState()` verbatim. */
  async function state(tools: Map<string, any>): Promise<any> {
    const dashboard = tools.get('dashboard')
    expect(dashboard).toBeDefined()
    return JSON.parse((await dashboard.execute({})).content)
  }

  /**
   * Boot the plugin with a `session.wait` that rejects — the way a real child
   * session does when it is aborted, evicted, or gone before it went idle.
   */
  async function bootWithRejectingWait() {
    const booted = await bootPlugin({ withSubagentTool: true })
    booted.ctx.session.wait = mock(() =>
      Promise.reject(new Error('SessionNotFoundError: ses_child_123')))
    return booted
  }

  it('does not leave the spawn tool\'s agent working', async () => {
    const { ctx, tools } = await bootWithRejectingWait()

    const result = await tools.get('spawn').execute(
      { role: 'explorer', task: 'Find the leak', model: 'opencode/test-model', wait: true, timeout: 5000 },
      { sessionID: 'ses_parent', agent: 'nexus-orchestrator', messageID: 'msg_1', id: 'call_1' },
    )

    // The tool still reports rather than throwing at the caller, and it reports
    // through its own partial-result branch — a rejected poll reaches that
    // branch, not the outer `catch`, so the copy is deliberately not asserted
    // here. What is under test is what it left in the STATE.
    expect(result.content).toContain(CHILD_SESSION_ID)

    const s = await state(tools)
    // THE ASSERTION. Pre-fix this row read `working`, and the session row
    // below read `running`, for the rest of the process.
    expect(s.agents).toHaveLength(1)
    expect(s.agents[0].status).not.toBe('working')
    expect(s.agents[0].status).toBe('failed')
    // And the session view, which reads the same field, cannot disagree.
    expect(s.sessions).toHaveLength(1)
    expect(s.sessions[0].state).not.toBe('running')
  })

  it('does not leave the delegate tool\'s agent working', async () => {
    const { tools } = await bootWithRejectingWait()

    const result = await tools.get('delegate').execute(
      { role: 'reviewer', task: 'Review the parser', model: 'opencode/test-model', timeout: 5000 },
      { sessionID: 'ses_parent', agent: 'nexus-orchestrator', messageID: 'msg_2', id: 'call_2' },
    )

    expect(result.content).toContain('Delegate failed')

    const s = await state(tools)
    expect(s.agents).toHaveLength(1)
    expect(s.agents[0].status).not.toBe('working')
    expect(s.sessions[0].state).not.toBe('running')
  })

  it('keeps the agent row, because a settled agent is not an orphan', async () => {
    const { tools } = await bootWithRejectingWait()

    await tools.get('delegate').execute(
      { role: 'reviewer', task: 'Review the parser', model: 'opencode/test-model', timeout: 5000 },
      { sessionID: 'ses_parent', agent: 'nexus-orchestrator', messageID: 'msg_2', id: 'call_2' },
    )

    const s = await state(tools)
    // The row SURVIVES, owned. Deleting the agent here — the way
    // `terminateAgent` does — would publish the session as an `owned: false`
    // orphan, which is reserved for a session still generating after its agent
    // was escalated away. This one is finished; it is a different fact.
    expect(s.agents).toHaveLength(1)
    expect(s.sessions[0].owned).toBe(true)
    expect(s.sessions[0].agentId).toBe(s.agents[0].id)
    expect(s.sessions[0].state).toBe('settled')
  })

  it('settles when the spawn tool fails AFTER the spawn, not only on a dead poll', async () => {
    // The other half of the same leak, on a different exit. A rejected `wait`
    // is caught by the tool's own partial-result branch; a throw from anything
    // after that — a failing `storage.set` here, a throw from a read — reaches
    // the tool's OUTER `catch`, which used to return "Failed to spawn agent"
    // with the row still at `working`. Two distinct exits, one invariant, so
    // both are driven.
    const { ctx, tools } = await bootPlugin({ withSubagentTool: true })
    const healthySet = ctx.storage.set
    ctx.storage.set = mock(() => Promise.reject(new Error('storage is down')))

    const result = await tools.get('spawn').execute(
      { role: 'explorer', task: 'Find the leak', model: 'opencode/test-model', wait: true, timeout: 5000 },
      { sessionID: 'ses_parent', agent: 'nexus-orchestrator', messageID: 'msg_1', id: 'call_1' },
    )

    expect(result.content).toContain('Failed to spawn agent')
    // Restored before reading: the `dashboard` tool persists the state it
    // returns through the same `storage.set`, and a read that fails is not a
    // measurement.
    ctx.storage.set = healthySet
    const s = await state(tools)
    expect(s.agents[0].status).not.toBe('working')
    expect(s.sessions[0].state).not.toBe('running')
  })

  it('settles a dead poll as completed when the session did produce output', async () => {
    // The other side of the dead-poll branch, and the reason the settle is at
    // each exit rather than on entry to the catch. A rejected poll says nothing
    // about whether the child finished; the session's own messages do. When
    // they carry an answer, 'failed' would be the wrong terminal status for a
    // task that produced its result — and settling to 'failed' on entry would
    // have made that permanent, since the first terminal outcome wins.
    const { ctx, tools } = await bootWithRejectingWait()
    ctx.session.context = mock(() => Promise.resolve([
      { type: 'assistant', content: [{ type: 'text', text: 'the answer' }] },
    ]))

    const result = await tools.get('spawn').execute(
      { role: 'explorer', task: 'Find the leak', model: 'opencode/test-model', wait: true, timeout: 5000 },
      { sessionID: 'ses_parent', agent: 'nexus-orchestrator', messageID: 'msg_1', id: 'call_1' },
    )
    expect(result.content).toContain('the answer')

    const s = await state(tools)
    expect(s.agents[0].status).toBe('completed')
    expect(s.sessions[0].state).toBe('settled')
  })

  it('publishes no session row with a missing id or state, on any path', async () => {
    // The second half of #100, asserted over the whole collection rather than
    // one row: `sessions[]` is the one list a reader may treat as fully
    // populated, so an empty `id` or an absent `state` anywhere in it is a
    // defect even when every other field on that row is fine.
    for (const wait of [true, false]) {
      const { tools } = await bootWithRejectingWait()
      await tools.get('spawn').execute(
        { role: 'explorer', task: 'Find the leak', model: 'opencode/test-model', wait, timeout: 5000 },
        { sessionID: 'ses_parent', agent: 'nexus-orchestrator', messageID: 'msg_1', id: 'call_1' },
      )

      const s = await state(tools)
      for (const row of s.sessions) {
        expect(typeof row.id).toBe('string')
        expect(row.id.length).toBeGreaterThan(0)
        expect(row.state).not.toBeNull()
        expect(row.state).not.toBeUndefined()
        expect(['running', 'idle', 'abandoned', 'settled']).toContain(row.state)
      }
    }
  })
})
