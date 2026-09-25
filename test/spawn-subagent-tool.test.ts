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
    budget: { maxTotalCost: 10.00, maxCostPerTask: 1.00, maxCostPerAgent: 2.00, alertThreshold: 0.2, hardLimit: false }
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
  let orchestrator: NexusOrchestrator
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
  let orchestrator: NexusOrchestrator
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

    ctx.session.context = mock(() => Promise.resolve([
      { role: 'assistant', content: 'done' },
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
