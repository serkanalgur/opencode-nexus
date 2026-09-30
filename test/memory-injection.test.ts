import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NexusOrchestrator, type SpawnPath } from '../src/orchestrator'
import { RECALL_HEADING } from '../src/memory-recall'
import type { ComplexityScore, Task } from '../src/types'

/**
 * That recollections actually reach a PROMPT, on every path that sends one.
 *
 * The module tests prove what the block looks like. These prove it is
 * delivered, which is a separate failure: a renderer that is correct and never
 * called looks identical to a feature that does not work.
 *
 * THERE ARE THREE PROMPT DELIVERY POINTS, and the third is the one that is easy
 * to miss. `spawnAgent` composes the text and hands it to the `subagent` tool;
 * the DAG's `executeTask` builds its own; and `spawnAndDeliver` in `index.ts`
 * has a FALLBACK that re-sends the task itself. That fallback used to send the
 * caller's original string, bypassing the composed text — so the degraded spawn,
 * already the one flagged as `lastDegradedSpawn`, was also the one spawn that
 * recalled nothing. Each of the three is asserted separately, because a test
 * that only covers the first two passes while the third is still broken.
 */

const COMPLEXITY: ComplexityScore = {
  overall: 50,
  factors: { fileCount: 1, codeLines: 100, dependencyDepth: 0, domainKnowledge: 0, riskLevel: 'low' },
}

let TEST_DIR: string

beforeEach(() => {
  TEST_DIR = mkdtempSync(join(tmpdir(), 'nexus-memory-inject-'))
})

afterEach(() => {
  try { rmSync(TEST_DIR, { recursive: true, force: true }) } catch {}
})

/** An OpenCode context whose `session.prompt` records what it was asked. */
function makeCtx(prompted: string[], toolList: unknown[] = []): unknown {
  return {
    location: { directory: process.cwd() },
    session: {
      create: mock(() => Promise.resolve({ id: 'session-mock' })),
      prompt: mock((input: { text: string }) => { prompted.push(input.text); return Promise.resolve() }),
      wait: mock(() => Promise.resolve()),
      context: mock(() => Promise.resolve([])),
    },
    storage: { get: mock(() => Promise.resolve(null)), set: mock(() => Promise.resolve()) },
    tool: { list: mock(() => Promise.resolve(toolList)) },
  }
}

/** A tool context complete enough for the subagent-tool path to be taken. */
const TOOL_CONTEXT = { sessionID: 'parent-1', agent: 'build', messageID: 'msg-1' }

/**
 * A `subagent` tool double, so the linked path is the one under test.
 *
 * The real tool reports the child session through `context.progress` and then
 * runs the child in the background, because `createChildSession` passes
 * `background: true`. A double that just returned would be read as "the tool
 * finished without reporting a child session" — see the test file this mirrors.
 */
const SUBAGENT_TOOL = {
  id: 'subagent',
  execute: mock((input: { prompt: string }, context: { progress: (p: { sessionID: string; status: string }) => Promise<void> }) =>
    (async () => {
      await context.progress({ sessionID: 'child-1', status: 'running' })
      return { title: 'child', metadata: {} }
    })()
  ),
}

async function makeOrchestrator(prompted: string[], toolList: unknown[] = []) {
  const orchestrator = new NexusOrchestrator(undefined, undefined, {
    dbPath: join(TEST_DIR, 'memory.db'),
    maxEntries: 1000,
  })
  await orchestrator.initialize(makeCtx(prompted, toolList) as never)
  return orchestrator
}

function seedProjectNote(orchestrator: NexusOrchestrator, key: string, value: string): void {
  orchestrator.memoryStore.set({ key, value, scope: 'project', author: 'alice', confidence: null, tags: [] })
}

function taskWith(overrides: Partial<Task>): Task {
  return {
    id: 'task-1',
    name: 'tidy the store',
    description: 'd',
    requiredRole: 'coder',
    complexity: COMPLEXITY,
    dependencies: [],
    files: { include: [] },
    priority: 'normal',
    status: 'pending',
    ...overrides,
  } as Task
}

/**
 * A `DAG` double that only records the node's result. Cast through `never`,
 * which is the same escape hatch the other suites use for `orchestrator['dag']`
 * — the field is typed as the full `DAG` interface and these tests exercise
 * none of it.
 */
function stubDAG(): never {
  return { markComplete: () => {}, markFailed: () => {} } as unknown as never
}

describe('the DAG execution path injects recollections', () => {
  it('puts the block in the prompt, after the task and before the transfer block', async () => {
    const prompted: string[] = []
    const orchestrator = await makeOrchestrator(prompted)
    seedProjectNote(orchestrator, 'file:src/memory-store.ts', 'THE-NOTE-MARKER')

    const agent = await orchestrator.spawnAgent({ role: 'coder', task: taskWith({ files: { include: ['src/memory-store.ts'] } }) })
    orchestrator['dag'] = stubDAG()
    await orchestrator['executeTask'](agent, { id: 'n1', task: taskWith({ files: { include: ['src/memory-store.ts'] } }), dependencies: [], status: 'running' } as never)

    expect(prompted).toHaveLength(1)
    const text = prompted[0]!
    expect(text).toContain('THE-NOTE-MARKER')
    expect(text).toContain(RECALL_HEADING)
    // POSITION IS PART OF THE MARKING. The block must arrive AFTER the task it
    // is about, so a reader meets the instruction first and the recollection
    // second, and never the other way round.
    expect(text.indexOf('## Task')).toBeLessThan(text.indexOf('## Scope'))
    expect(text.indexOf('## Scope')).toBeLessThan(text.indexOf(RECALL_HEADING))
    await orchestrator.shutdown()
  })

  it('places the block BEFORE the context-transfer block, which also narrates', async () => {
    // The transfer block is the precedent that makes the position read as
    // narration rather than instruction: it is already a trailing block of
    // reported state ("Partial results: … Errors encountered: …"), and the
    // recollection joins it in that register. A recollection placed ABOVE the
    // task would read as part of the assignment.
    const prompted: string[] = []
    const orchestrator = await makeOrchestrator(prompted)
    seedProjectNote(orchestrator, 'file:src/a.ts', 'ORDER-MARKER')

    const agent = await orchestrator.spawnAgent({ role: 'coder', model: 'anthropic/claude-sonnet-4-6' })
    orchestrator['dag'] = stubDAG()
    await orchestrator['executeTask'](agent, {
      id: 'n1',
      task: taskWith({ files: { include: ['src/a.ts'] } }),
      dependencies: [],
      status: 'running',
    } as never, {
      previousAgentId: 'agent-old',
      partialResults: ['did a thing'],
      decisions: [],
      taskProgress: 50,
      errorLog: ['one failure'],
      memoryEntries: [],
    })

    const text = prompted[0] ?? ''
    const scope = text.indexOf('## Scope')
    const block = text.indexOf(RECALL_HEADING)
    const transfer = text.indexOf('Previous Agent Context')
    expect(block).toBeGreaterThan(-1)
    expect(transfer).toBeGreaterThan(-1)
    expect(scope).toBeLessThan(block)
    expect(block).toBeLessThan(transfer)
    await orchestrator.shutdown()
  })

  it('injects nothing at all when no note names one of the task\'s files', async () => {
    const prompted: string[] = []
    const orchestrator = await makeOrchestrator(prompted)
    seedProjectNote(orchestrator, 'file:src/memory-store.ts', 'THE-NOTE-MARKER')

    const agent = await orchestrator.spawnAgent({ role: 'coder', task: taskWith({ files: { include: ['src/totally-other.ts'] } }) })
    orchestrator['dag'] = stubDAG()
    await orchestrator['executeTask'](agent, { id: 'n1', task: taskWith({ files: { include: ['src/totally-other.ts'] } }), dependencies: [], status: 'running' } as never)

    const text = prompted[0]!
    // The negative half, asserted on the ASSEMBLED PROMPT: a block that
    // rendered an empty heading would satisfy a "no marker" check and still
    // hand the agent a section titled "Recollections" containing nothing.
    expect(text).not.toContain('THE-NOTE-MARKER')
    expect(text).not.toContain(RECALL_HEADING)
    await orchestrator.shutdown()
  })

  it('records the injection size, so prompt-weight regression is visible', async () => {
    const prompted: string[] = []
    const orchestrator = await makeOrchestrator(prompted)
    seedProjectNote(orchestrator, 'file:src/a.ts', 'a note')
    const agent = await orchestrator.spawnAgent({ role: 'coder', task: taskWith({ files: { include: ['src/a.ts'] } }) })
    orchestrator['dag'] = stubDAG()
    await orchestrator['executeTask'](agent, { id: 'n1', task: taskWith({ files: { include: ['src/a.ts'] } }), dependencies: [], status: 'running' } as never)

    const recall = orchestrator.getLastRecall()
    expect(recall).not.toBeNull()
    expect(recall!.notes).toBe(1)
    expect(recall!.characters).toBeGreaterThan(0)
    await orchestrator.shutdown()
  })
})

describe('the spawn-tool path injects recollections', () => {
  // The tool path has NO `Task` object — `nexus.spawn` takes a string — so
  // `files.include` does not exist and the paths named in the prose are the only
  // file signal. The block still has to arrive, or "recollections are injected
  // on spawn" is true of one of the two spawn paths.

  it('delivers the block through the subagent tool', async () => {
    const prompted: string[] = []
    const orchestrator = await makeOrchestrator(prompted, [SUBAGENT_TOOL])
    seedProjectNote(orchestrator, 'file:src/auth/jwt.ts', 'TOOL-PATH-MARKER')

    const agent = await orchestrator.spawnAgent(
      { role: 'coder' },
      { toolContext: TOOL_CONTEXT, task: 'fix the token check in src/auth/jwt.ts' }
    )

    expect(agent.spawnPath).toBe('subagent-tool' as SpawnPath)
    const prompt = SUBAGENT_TOOL.execute.mock.calls.at(-1)?.[0] as { prompt: string }
    expect(prompt.prompt).toContain('TOOL-PATH-MARKER')
    expect(prompt.prompt).toContain(RECALL_HEADING)
    // The task text is still there. The block is appended, not substituted.
    expect(prompt.prompt).toContain('fix the token check in src/auth/jwt.ts')
    await orchestrator.shutdown()
  })

  it('carries the composed text on the agent, so the degraded re-prompt reuses it', async () => {
    const prompted: string[] = []
    const orchestrator = await makeOrchestrator(prompted, [SUBAGENT_TOOL])
    seedProjectNote(orchestrator, 'file:src/auth/jwt.ts', 'TOOL-PATH-MARKER')

    const agent = await orchestrator.spawnAgent(
      { role: 'coder' },
      { toolContext: TOOL_CONTEXT, task: 'fix the token check in src/auth/jwt.ts' }
    )
    // This is the contract `index.ts`'s `spawnAndDeliver` reads. Asserted here
    // because the field existing is not the same as a caller using it, and the
    // failure this guards — a fallback that re-sends the caller's own string —
    // is invisible from the orchestrator side.
    expect(agent.deliveredText).toContain('TOOL-PATH-MARKER')
    expect(agent.deliveredText).toContain(RECALL_HEADING)
    await orchestrator.shutdown()
  })

  it('leaves deliveredText equal to the task when nothing was recalled', async () => {
    const prompted: string[] = []
    const orchestrator = await makeOrchestrator(prompted, [SUBAGENT_TOOL])
    const task = 'fix the token check in src/auth/jwt.ts'
    const agent = await orchestrator.spawnAgent(
      { role: 'coder' },
      { toolContext: TOOL_CONTEXT, task }
    )
    // Sending deliveredText must be a NO-OP on the common path, or the fix for
    // the degraded fallback would be a behaviour change for every spawn.
    expect(agent.deliveredText).toBe(task)
    await orchestrator.shutdown()
  })

  it('does NOT inject on the DAG path twice, by reading the store once', async () => {
    const prompted: string[] = []
    const orchestrator = await makeOrchestrator(prompted)
    seedProjectNote(orchestrator, 'file:src/memory-store.ts', 'ONCE-MARKER')

    // `spawnAndExecute` is what the DAG calls: it spawns and then executes. If
    // both halves injected, the note would appear twice in one prompt and a
    // reader would count it as two recollections.
    const node = { id: 'n1', task: taskWith({ files: { include: ['src/memory-store.ts'] } }), dependencies: [], status: 'pending' }
    orchestrator['dag'] = stubDAG()
    await orchestrator['spawnAndExecute'](node as never)

    const text = prompted[0]!
    const occurrences = text.split('ONCE-MARKER').length - 1
    expect(occurrences).toBe(1)
    await orchestrator.shutdown()
  })
})

describe('recall degrades to silence rather than taking a task down', () => {
  it('injects nothing, and does not throw, once the store is closed', async () => {
    const prompted: string[] = []
    const orchestrator = await makeOrchestrator(prompted)
    seedProjectNote(orchestrator, 'file:src/a.ts', 'SHOULD-NOT-APPEAR')
    await orchestrator.shutdown()

    // `shutdown()` closes the store. A spawn racing teardown used to throw out
    // of prompt construction, and `test/task-cost.test.ts`'s "a task that times
    // out after teardown" exists to assert that this path does not take a task
    // down. Recollection is an enhancement; no enhancement is worth an aborted
    // task.
    const agent = await orchestrator.spawnAgent({ role: 'coder', model: 'anthropic/claude-sonnet-4-6' })
    orchestrator['dag'] = stubDAG()
    await orchestrator['executeTask'](agent, { id: 'n1', task: taskWith({ files: { include: ['src/a.ts'] } }), dependencies: [], status: 'running' } as never)

    expect(prompted[0] ?? '').not.toContain('SHOULD-NOT-APPEAR')
    expect(prompted[0] ?? '').toContain('## Task')
  })
})

describe('memory.enabled is a gate that actually gates', () => {
  it('injects nothing when the block is off, on the same path that injects when it is on', async () => {
    const prompted: string[] = []
    const orchestrator = await makeOrchestrator(prompted)
    seedProjectNote(orchestrator, 'file:src/a.ts', 'GATED-MARKER')

    // The control: on by default, so the note is in the prompt. Without this the
    // test below would also pass if the path had simply stopped working.
    orchestrator['dag'] = stubDAG()
    await orchestrator['spawnAndExecute']({
      id: 'n1', task: taskWith({ files: { include: ['src/a.ts'] } }),
      dependencies: [], status: 'pending',
    } as never)
    expect(prompted[0] ?? '').toContain('GATED-MARKER')

    // Now off. The gate is read from the config manager on every call, so
    // flipping it here is enough — there is no second stored copy to re-seed,
    // which is the property that makes the flag live rather than decorative.
    orchestrator.configManager.updateStorageConfig({ memory: { enabled: false } } as never)

    orchestrator['dag'] = stubDAG()
    await orchestrator['spawnAndExecute']({
      id: 'n2', task: taskWith({ files: { include: ['src/a.ts'] } }),
      dependencies: [], status: 'pending',
    } as never)

    const second = prompted[1] ?? ''
    expect(second).not.toContain('GATED-MARKER')
    // The TASK still went out. A gate that stopped the prompt would be a worse
    // bug than a gate that did nothing.
    expect(second).toContain('## Task')

    // And the outcome is indistinguishable from a miss, which is the same value
    // the existing catch block returns — "off" and "the read failed" look
    // identical to a caller, and correctly so: nothing was injected either way.
    expect(orchestrator.recallForTask({ files: ['src/a.ts'], text: 'tidy' }))
      .toEqual({ block: null, matched: 0, shown: 0, characters: 0 })
    await orchestrator.shutdown()
  })
})
