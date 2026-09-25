import { describe, it, expect, mock } from 'bun:test'
import * as realOs from 'node:os'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'nexus-home-'))
mock.module('node:os', () => ({ ...realOs, default: realOs, homedir: () => SANDBOX_HOME }))

const { NexusOrchestrator, lastAssistantText, assistantMessageText } = await import('../src/orchestrator')

/**
 * The plugin used to read results with
 * `messages.filter(m => m.role === 'assistant').pop()?.content`. V2 session
 * messages are a union discriminated by `type` and have no `role` field, so
 * that filter never matched: every result silently degraded to a placeholder
 * string ("Task completed", "Completed with no output"), which then flowed into
 * `TaskResult.output`, execution history, the dashboard and the output security
 * scanner. These tests pin the real extraction.
 */

const user = { type: 'user', text: 'do the thing' } as const
const assistant = (...text: string[]) => ({
  type: 'assistant',
  content: text.map(t => ({ type: 'text', text: t })),
})

describe('assistant text extraction from ctx.session.context()', () => {
  it('returns the joined text parts of an assistant message', () => {
    expect(assistantMessageText(assistant('part one ', 'part two'))).toBe('part one part two')
  })

  it('ignores non-text content parts (reasoning, tool calls)', () => {
    const message = {
      type: 'assistant',
      content: [
        { type: 'reasoning', text: 'thinking...' },
        { type: 'text', text: 'the answer' },
        { type: 'tool', callID: 'call_1', state: { status: 'completed' } },
      ],
    }
    expect(assistantMessageText(message as never)).toBe('the answer')
  })

  it('returns the LAST assistant message of a session', () => {
    const messages = [user, assistant('first'), assistant('final answer')]
    expect(lastAssistantText(messages as never)).toBe('final answer')
  })

  it('returns "" when there is no assistant message, so callers can show their placeholder', () => {
    expect(lastAssistantText([user] as never)).toBe('')
    expect(lastAssistantText([] as never)).toBe('')
  })

  it('executeTask records the real agent output instead of "Task completed"', async () => {
    const orchestrator = new NexusOrchestrator()
    const ctx = {
      location: { directory: mkdtempSync(join(tmpdir(), 'nexus-project-')) },
      model: { list: mock(() => Promise.resolve({ data: [] })) },
      session: {
        create: mock(() => Promise.resolve({ id: 'ses_child' })),
        prompt: mock(() => Promise.resolve()),
        wait: mock(() => Promise.resolve()),
        context: mock(() => Promise.resolve([user, assistant('the real answer')])),
      },
      storage: { get: mock(() => Promise.resolve(null)), set: mock(() => Promise.resolve()) },
      tool: { list: mock(() => Promise.resolve([])) },
    }
    await orchestrator.initialize(ctx as never)

    let recorded: { output: string; success: boolean } | undefined
    orchestrator['dag'] = { markComplete: (_id: string, result: { output: string; success: boolean }) => { recorded = result } }

    const node = {
      id: 'node-1',
      status: 'running',
      task: {
        name: 't', description: 'd', requiredRole: 'coder', timeout: 1000,
        files: { include: [], exclude: [] },
      },
    }
    const agent = await orchestrator.spawnAgent(
      { role: 'coder', model: 'opencode-go/space-bunny-free' },
      { task: 'Do the thing' },
    )

    await orchestrator['executeTask'](agent, node as never)

    // The placeholder used to be recorded here for every single run.
    expect(recorded?.success).toBe(true)
    expect(recorded?.output).toBe('the real answer')
    expect(recorded?.output).not.toBe('Task completed')

    await orchestrator.shutdown()
  })
})
