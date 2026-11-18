import { describe, it, expect, afterAll, mock } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import * as realOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'nexus-home-'))
mock.module('node:os', () => ({ ...realOs, default: realOs, homedir: () => SANDBOX_HOME }))

const { applyBudgetGate } = await import('../src/permission-gate')
const { default: plugin } = await import('../src/index')

afterAll(() => {
  mock.module('node:os', () => realOs)
})

type Effect = 'allow' | 'deny' | 'ask'
const evaluation = (action: string, resources: string[], effect: Effect = 'allow') =>
  ({ action, resources, effect } as { action: string; resources: string[]; effect: Effect; message?: string })

const EXCEEDED = { exceeded: true, spent: 12.5 }
const WITHIN = { exceeded: false, spent: 3 }

describe('applyBudgetGate', () => {
  it('denies starting a Nexus agent once the hard limit has tripped, and says why', () => {
    const event = evaluation('subagent', ['nexus-coder'])
    expect(applyBudgetGate(event, EXCEEDED)).toBe(true)
    expect(event.effect).toBe('deny')
    expect(event.message).toBe(
      "Nexus's hard budget limit was reached at $12.50, so nexus-coder cannot be started. Nexus agents are refused for the rest of this run.",
    )
  })

  it('turns an ask into a deny too, so nobody is asked to approve past the limit', () => {
    const event = evaluation('subagent', ['nexus-reviewer'], 'ask')
    applyBudgetGate(event, EXCEEDED)
    expect(event.effect).toBe('deny')
  })

  it('changes nothing while the budget holds', () => {
    const event = evaluation('subagent', ['nexus-coder'])
    expect(applyBudgetGate(event, WITHIN)).toBe(false)
    expect(event).toEqual(evaluation('subagent', ['nexus-coder']))
  })

  it('leaves non-Nexus agents alone, even over budget', () => {
    const event = evaluation('subagent', ['general'])
    expect(applyBudgetGate(event, EXCEEDED)).toBe(false)
    expect(event.effect).toBe('allow')
    expect(event.message).toBeUndefined()
  })

  it('leaves other actions alone, even over budget', () => {
    for (const action of ['edit', 'shell', 'read']) {
      const event = evaluation(action, ['nexus-coder'])
      expect(applyBudgetGate(event, EXCEEDED)).toBe(false)
      expect(event.effect).toBe('allow')
    }
  })

  it('never touches a request that is already denied, so the user\'s own message stands', () => {
    const event = { ...evaluation('subagent', ['nexus-coder'], 'deny'), message: 'denied by user config' }
    expect(applyBudgetGate(event, EXCEEDED)).toBe(false)
    expect(event.message).toBe('denied by user config')
  })
})

describe('plugin setup: the budget gate is wired to the permission hook', () => {
  async function boot(register: (name: string, cb: (event: any) => void) => Promise<unknown>) {
    const ctx: any = {
      location: { directory: mkdtempSync(join(tmpdir(), 'nexus-project-')) },
      storage: { set: mock(() => Promise.resolve()), get: mock(() => Promise.resolve(null)) },
      tool: { transform: mock(async (cb: any) => { cb({ namespace: () => {}, add: () => {} }) }), list: mock(() => Promise.resolve([])) },
      permission: { hook: mock(register) },
      session: { create: mock(), prompt: mock(), wait: mock(), context: mock(() => Promise.resolve([])), hook: mock() },
    }
    const cleanup = await plugin.setup(ctx)
    return { ctx, cleanup }
  }

  it('registers an evaluate hook that consults the live orchestrator budget', async () => {
    let evaluate: ((event: any) => void) | undefined
    const { ctx, cleanup } = await boot(async (name, cb) => {
      if (name === 'evaluate') evaluate = cb
      return { dispose: async () => {} }
    })
    expect(ctx.permission.hook).toHaveBeenCalledTimes(1)
    expect(evaluate).toBeDefined()

    // A fresh orchestrator is within budget, so the hook must not deny.
    const event = evaluation('subagent', ['nexus-coder'])
    evaluate!(event)
    expect(event.effect).toBe('allow')
    await (cleanup as any)?.()
  })

  it('still loads, and says so, when the host refuses the hook', async () => {
    const original = console.warn
    const warnings: string[] = []
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
    try {
      const { cleanup } = await boot(async () => { throw new Error('hook refused') })
      expect(typeof cleanup).toBe('function')
      expect(warnings.some((w) => w.includes('could not register the budget permission gate') && w.includes('hook refused'))).toBe(true)
      await (cleanup as any)?.()
    } finally {
      console.warn = original
    }
  })
})
