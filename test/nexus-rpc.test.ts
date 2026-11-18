import { describe, it, expect, afterAll, mock } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import * as realOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Setup writes agent files under homedir(); sandbox it before the plugin loads.
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'nexus-home-'))
mock.module('node:os', () => ({ ...realOs, default: realOs, homedir: () => SANDBOX_HOME }))

const { default: plugin } = await import('../src/index')
const { NexusRpc, runNexusCommand } = await import('../src/rpc')

afterAll(() => {
  mock.module('node:os', () => realOs)
})

/**
 * `/nexus …` used to reach the orchestrator through a `session.hook("prompt")`
 * that rewrote the prompt into the command's result. That cost a model request
 * per command, because a prompt hook cannot cancel the turn. These tests pin
 * the two V2 channels that replace it: plugin RPC for the TUI, and a registered
 * server command that posts its result without waking the agent.
 */

async function bootPlugin() {
  const rpcHandlers: Record<string, (input: unknown, context: unknown) => Promise<unknown>> = {}
  const rpcDefinitions: unknown[] = []
  const commands = new Map<string, { name: string; description?: string; execute: (input: any) => Promise<void> }>()
  const hookNames: string[] = []

  const ctx: any = {
    location: { directory: mkdtempSync(join(tmpdir(), 'nexus-project-')) },
    storage: { set: mock(() => Promise.resolve()), get: mock(() => Promise.resolve(null)) },
    tool: {
      transform: mock(async (cb: any) => { cb({ namespace: () => {}, add: () => {} }) }),
      list: mock(() => Promise.resolve([])),
    },
    rpc: {
      register: mock(async (definition: unknown, handlers: typeof rpcHandlers) => {
        rpcDefinitions.push(definition)
        Object.assign(rpcHandlers, handlers)
        return { dispose: async () => {}, events: { emit: async () => {} } }
      }),
    },
    command: {
      transform: mock(async (cb: any) => {
        cb({ add: (definition: any) => { commands.set(definition.name, definition) } })
        return { dispose: async () => {} }
      }),
    },
    session: {
      create: mock(() => Promise.resolve({ id: 'ses_created' })),
      prompt: mock(() => Promise.resolve()),
      synthetic: mock(() => Promise.resolve({})),
      wait: mock(() => Promise.resolve()),
      context: mock(() => Promise.resolve([])),
      hook: mock(async (name: string) => { hookNames.push(name) }),
    },
  }

  const cleanup = await plugin.setup(ctx)
  return { ctx, rpcHandlers, rpcDefinitions, commands, hookNames, cleanup }
}

describe('runNexusCommand', () => {
  it('returns the command output as ok', () => {
    expect(runNexusCommand(() => 'Orchestrator paused', '  /nexus pause ')).toEqual({ ok: true, text: 'Orchestrator paused' })
  })

  it('passes the trimmed line to the handler', () => {
    const seen: string[] = []
    runNexusCommand((t) => { seen.push(t); return '' }, '  /nexus agents reviewer  ')
    expect(seen).toEqual(['/nexus agents reviewer'])
  })

  it('turns a throw into a failed result that names the command, never an exception', () => {
    const result = runNexusCommand(() => { throw new Error('port 4747 in use') }, '/nexus dashboard 4747')
    expect(result.ok).toBe(false)
    expect(result.text).toContain('`/nexus dashboard 4747` command failed: port 4747 in use')
    expect(result.text).toContain('Nothing was changed.')
  })
})

describe('the Nexus RPC contract', () => {
  it('declares one command method taking text and returning ok and text', () => {
    expect(NexusRpc.id).toBe('nexus')
    expect(Object.keys(NexusRpc.methods)).toEqual(['command'])
    expect(NexusRpc.methods.command.input.required).toEqual(['text'])
    expect(NexusRpc.methods.command.output.required).toEqual(['ok', 'text'])
    expect(NexusRpc.events).toEqual({})
  })
})

describe('plugin setup: /nexus without a prompt hook', () => {
  it('no longer registers a prompt hook', async () => {
    const { hookNames, cleanup } = await bootPlugin()
    expect(hookNames).not.toContain('prompt')
    await (cleanup as any)?.()
  })

  it('registers the Nexus RPC, and its handler answers with the orchestrator result', async () => {
    const { rpcDefinitions, rpcHandlers, cleanup } = await bootPlugin()
    expect(rpcDefinitions).toEqual([NexusRpc])

    const result = await rpcHandlers.command!({ text: '/nexus pause' }, {})
    expect(result).toEqual({ ok: true, text: 'Orchestrator paused' })

    const unknown = (await rpcHandlers.command!({ text: '/nexus nope' }, {})) as { ok: boolean; text: string }
    expect(unknown.ok).toBe(true)
    expect(unknown.text).toStartWith('Unknown command. Available:')
    await (cleanup as any)?.()
  })

  it('registers a nexus server command that posts its result without waking the agent', async () => {
    const { ctx, commands, cleanup } = await bootPlugin()
    const command = commands.get('nexus')
    expect(command).toBeDefined()

    await command!.execute({ sessionID: 'ses_1', prompt: { text: 'pause' }, delivery: 'steer' })

    expect(ctx.session.prompt).not.toHaveBeenCalled()
    expect(ctx.session.synthetic).toHaveBeenCalledTimes(1)
    const posted = (ctx.session.synthetic as any).mock.calls[0][0]
    expect(posted.sessionID).toBe('ses_1')
    expect(posted.resume).toBe(false)
    expect(posted.description).toBe('Orchestrator paused')
    expect(posted.text).toContain('Do not run it again')
    expect(posted.text).toContain('Orchestrator paused')
    expect(posted.metadata).toEqual({ source: 'nexus', ok: true })
    await (cleanup as any)?.()
  })

  it('still loads, and says so, when the host refuses the registrations', async () => {
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
    try {
      const ctx: any = {
        location: { directory: mkdtempSync(join(tmpdir(), 'nexus-project-')) },
        storage: { set: mock(() => Promise.resolve()), get: mock(() => Promise.resolve(null)) },
        tool: { transform: mock(async (cb: any) => { cb({ namespace: () => {}, add: () => {} }) }), list: mock(() => Promise.resolve([])) },
        rpc: { register: mock(async () => { throw new Error('rpc id taken') }) },
        command: { transform: mock(async () => { throw new Error('command refused') }) },
        session: { create: mock(), prompt: mock(), synthetic: mock(), wait: mock(), context: mock(() => Promise.resolve([])), hook: mock() },
      }
      const cleanup = await plugin.setup(ctx)
      expect(typeof cleanup).toBe('function')
      expect(warnings.some((w) => w.includes('could not register the Nexus RPC') && w.includes('rpc id taken'))).toBe(true)
      expect(warnings.some((w) => w.includes('could not register the /nexus server command') && w.includes('command refused'))).toBe(true)
      await (cleanup as any)?.()
    } finally {
      console.warn = originalWarn
    }
  })
})
