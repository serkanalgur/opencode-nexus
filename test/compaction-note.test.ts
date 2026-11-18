import { describe, it, expect, afterAll, mock } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import * as realOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'nexus-home-'))
mock.module('node:os', () => ({ ...realOs, default: realOs, homedir: () => SANDBOX_HOME }))

const { applyCompactionNote, buildCompactionNote, MAX_TODOS_IN_NOTE } = await import('../src/compaction-note')
const { default: plugin } = await import('../src/index')

afterAll(() => {
  mock.module('node:os', () => realOs)
})

const todo = (id: string, description: string, status: 'pending' | 'in_progress' = 'pending', assignedTo?: string) =>
  ({ id, description, status, assignedTo })

describe('buildCompactionNote', () => {
  it('returns null when there is no goal and no open todo, so nothing is added', () => {
    expect(buildCompactionNote({ activeGoal: null, openTodos: [] })).toBeNull()
  })

  it('carries the active goal and each open todo with its status and owner', () => {
    const note = buildCompactionNote({
      activeGoal: { description: 'Ship the billing page' },
      openTodos: [todo('todo-1', 'Write the API', 'in_progress', 'coder'), todo('todo-2', 'Review it')],
    })
    expect(note).toBe([
      'Nexus orchestration state. Carry it into the summary verbatim, under a heading',
      '"Nexus state", so work can resume from the summary:',
      '',
      'Active goal: Ship the billing page',
      '',
      'Open todos:',
      '- [in_progress] todo-1: Write the API (coder)',
      '- [pending] todo-2: Review it',
    ].join('\n'))
  })

  it('caps the todo list and says how many were left out', () => {
    const many = Array.from({ length: MAX_TODOS_IN_NOTE + 3 }, (_, i) => todo(`todo-${i}`, `task ${i}`))
    const note = buildCompactionNote({ activeGoal: null, openTodos: many })!
    expect(note.split('\n').filter((l) => l.startsWith('- [pending]'))).toHaveLength(MAX_TODOS_IN_NOTE)
    expect(note).toContain('…and 3 more; nexus.todo.list shows all of them')
  })
})

describe('applyCompactionNote', () => {
  it('adds the note to a Nexus session\'s compaction request', () => {
    const event = { agent: 'nexus-orchestrator', system: [{ type: 'text' as const, text: 'Summarize.' }] }
    expect(applyCompactionNote(event, 'NOTE')).toBe(true)
    expect(event.system).toEqual([{ type: 'text', text: 'Summarize.' }, { type: 'text', text: 'NOTE' }])
  })

  it('leaves a non-Nexus session alone, so one project\'s plan cannot leak into another conversation', () => {
    const event = { agent: 'build', system: [{ type: 'text' as const, text: 'Summarize.' }] }
    expect(applyCompactionNote(event, 'NOTE')).toBe(false)
    expect(event.system).toHaveLength(1)
  })

  it('adds nothing when there is no note', () => {
    const event = { agent: 'nexus-orchestrator', system: [] as { type: 'text'; text: string }[] }
    expect(applyCompactionNote(event, null)).toBe(false)
    expect(event.system).toEqual([])
  })
})

describe('plugin setup: the compaction hook carries live Nexus state', () => {
  it('registers a compaction hook that adds the active goal to a Nexus session', async () => {
    const hooks = new Map<string, (event: any) => void>()
    const tools = new Map<string, any>()
    const ctx: any = {
      location: { directory: mkdtempSync(join(tmpdir(), 'nexus-project-')) },
      storage: { set: mock(() => Promise.resolve()), get: mock(() => Promise.resolve(null)) },
      tool: {
        transform: mock(async (cb: any) => { cb({ namespace: () => {}, add: (t: any) => { tools.set(t.name, t) } }) }),
        list: mock(() => Promise.resolve([])),
      },
      session: {
        create: mock(), prompt: mock(), wait: mock(), context: mock(() => Promise.resolve([])),
        hook: mock(async (name: string, cb: (event: any) => void) => { hooks.set(name, cb) }),
      },
    }
    const cleanup = await plugin.setup(ctx)
    const compaction = hooks.get('compaction')
    expect(compaction).toBeDefined()

    // Nothing set yet: the request is left untouched.
    const empty = { agent: 'nexus-orchestrator', system: [] as unknown[] }
    compaction!(empty)
    expect(empty.system).toEqual([])

    // Set a goal through the real tool, then compact again.
    await tools.get('goal.set').execute({ description: 'Migrate the auth module' }, {})
    const event = { agent: 'nexus-orchestrator', system: [] as { text: string }[] }
    compaction!(event)
    expect(event.system).toHaveLength(1)
    expect(event.system[0]!.text).toContain('Active goal: Migrate the auth module')

    const other = { agent: 'build', system: [] as unknown[] }
    compaction!(other)
    expect(other.system).toEqual([])
    await (cleanup as any)?.()
  })
})
