import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

/**
 * Every `AgentStatus` / `TaskStatus` member is assigned somewhere in `src/`.
 *
 * A control against DRIFT, in the same shape as
 * `test/broadcast-event-coverage.test.ts`, and for the same reason: a union
 * member that nothing ever writes is a branch that reads as a capability the
 * orchestrator does not have. `sessionStateOfAgent` (`orchestrator.ts:749`) has
 * an exhaustive switch with no `default`, so ADDING a status to either union is
 * a compile error — which is precisely why the dead members survived. Once the
 * new arm is written, the compiler is satisfied, and the only thing still
 * standing between that arm and a plausible-looking read of a state no agent can
 * ever be in is a person noticing.
 *
 * `spawning` and `blocked` were both such arms, and `queued`/`cancelled` on the
 * task side. A union is a claim about the domain; these four were claims about
 * states the scheduler never produces, and a reader of `sessionStateOfAgent`
 * could not tell which arms were load-bearing.
 *
 * WHY A SOURCE SCAN AND NOT A TYPE-LEVEL ASSERTION. "Somebody assigns this
 * member somewhere" is not expressible in the type system — TS cannot see that
 * `case 'spawning':` is reachable, and an exhaustive switch deliberately does
 * not care. The compiler half of this problem is already covered by the missing
 * `default`; the half that is NOT covered is whether the arms are ever entered,
 * and that is a question about running code, so it is answered from the source
 * text.
 *
 * WHY THE SCAN IS RECEIVER-AWARE. `DAGNode.status` (`types.ts:116`) is its own
 * inline union that OVERLAPS `TaskStatus` on `pending`, `running`, and
 * `cancelled`. So `node.status = 'pending'` is not a `TaskStatus` write, and a
 * naive "does the literal appear in an assignment" grep would credit it as one
 * and let a genuinely dead `TaskStatus` member pass. Same for `TodoItem.status`
 * (`src/todo.ts:4`, which owns a `blocked`) and `Goal.status` / the execution
 * history record status. Each form below therefore names the union it feeds.
 *
 * `src/tui.tsx` is deliberately EXCLUDED, and it is the one exclusion with a
 * real reason rather than a convenience: it declares its OWN `AgentStatus`
 * interface (`src/tui.tsx:45`) with a five-member union, populated from the
 * persisted sidebar blob rather than from `Agent` objects. Its writes are real
 * and they mean something — but they are writes to a different type, and a grep
 * cannot attribute them to the union in `types.ts`. Folding them in would make
 * this file green for the wrong reason.
 */

const SRC_DIR = join(import.meta.dir, '..', 'src')
const TYPES_SOURCE = join(SRC_DIR, 'types.ts')

/** Every `src/*.ts` module — the surface both unions are declared over. */
function sourceFiles(): string[] {
  return readdirSync(SRC_DIR)
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .map((f) => join(SRC_DIR, f))
}

/**
 * The string members of a declared union, parsed out of `types.ts`.
 *
 * Bounded to the declaration: the slice stops at the next top-level `export`,
 * so a later union in the same file cannot leak members into this one. That
 * bound is load-bearing rather than tidy — an unbounded slice would pick up
 * `DAGNode`'s members when reading `AgentStatus`, which is the exact
 * cross-union bleed this file exists to prevent.
 */
function readUnionMembers(name: 'AgentStatus' | 'TaskStatus'): string[] {
  const source = readFileSync(TYPES_SOURCE, 'utf8')
  const start = source.indexOf(`export type ${name} =`)
  expect(start).toBeGreaterThan(-1)
  const next = source.indexOf('\nexport ', start + 1)
  const declaration = source.slice(start, next === -1 ? undefined : next)
  return [...declaration.matchAll(/\|\s*'([a-z-]+)'/g)].map((m) => m[1] as string)
}

/** Every quoted literal on the right-hand side of an assignment. */
function literalsIn(rhs: string): string[] {
  return [...rhs.matchAll(/'([a-z-]+)'/g)].map((m) => m[1] as string)
}

/**
 * `AgentStatus` write forms. Object-literal construction is NOT among them:
 * every member has a real assignment or a `settleAgent` call site, so counting
 * literals here could only add ways for the assertion to pass for the wrong
 * reason (`DAGNode`/`TodoItem`/`Goal` literals would all be miscounted).
 */
function scanAgentStatusWrites(source: string): string[] {
  const found: string[] = []
  // `agent.status = 'x'` — the orchestrator's own writes.
  for (const m of source.matchAll(/\bagent\.status\s*=\s*'([a-z-]+)'/g)) found.push(m[1] as string)
  // `x.settleAgent(id, 'x')` — `settleAgent` is a PARAMETERISED writer
  // (`agent.status = status`, `orchestrator.ts:3975`), so its literals are
  // where `completed` and `failed` actually reach an agent. Every real call
  // site reads `orchestrator.settleAgent(agent.id, 'completed')`, so the
  // receiver is matched as an arbitrary identifier rather than a fixed one.
  for (const m of source.matchAll(/\b[\w$]+\.settleAgent\(\s*[\w.$]+\s*,\s*'([a-z-]+)'\s*\)/g)) {
    found.push(m[1] as string)
  }
  return found
}

/**
 * `TaskStatus` write forms. The object literal is included here and not for
 * `AgentStatus` because two members — `pending` and `running` — are only ever
 * written at CONSTRUCTION: a `Task` arrives from a caller already carrying its
 * status, and the orchestrator's own `task.status` writes are both terminal.
 * Scoped to the two files that construct `Task` values; `orchestrator.ts`'s
 * `status: 'pending'` is a `DAGNode` literal, which is why that file is not in
 * this list.
 */
const TASK_LITERAL_FILES = new Set(['index.ts', 'templates.ts'])

function scanTaskStatusWrites(source: string, file: string): string[] {
  const found: string[] = []
  // `task.status = ...`. The right-hand side is captured whole rather than
  // matched for a leading literal, because the one non-trivial site assigns a
  // TERNARY (`orchestrator.ts:2821`) and a `'([a-z-]+)'` directly after the `=`
  // would read that assignment as having no literals at all.
  for (const m of source.matchAll(/\btask\.status\s*=\s*([^;\n]+)/g)) found.push(...literalsIn(m[1] as string))
  // `status: 'x'` in a `Task` object literal.
  if (TASK_LITERAL_FILES.has(file)) {
    for (const m of source.matchAll(/\bstatus:\s*'([a-z-]+)'(?:\s+as\s+const)?\s*[,}]/g)) found.push(m[1] as string)
  }
  return found
}

function writtenInSrc(scan: (source: string, file: string) => string[]): Map<string, string[]> {
  // member -> the files it was found in, so a failure names WHERE the write
  // was looked for and did not appear, which is the whole question. `basename`
  // is what the scanners match on; `sourceFiles` returns full paths, so passing
  // the path through unchecked would make every filename-scoped check miss and
  // report a written member as dead.
  const byMember = new Map<string, string[]>()
  for (const path of sourceFiles()) {
    const file = basename(path)
    for (const member of scan(readFileSync(path, 'utf8'), file)) {
      const hits = byMember.get(member) ?? []
      if (!hits.includes(file)) hits.push(file)
      byMember.set(member, hits)
    }
  }
  return byMember
}

describe('every AgentStatus member is assigned somewhere in src/', () => {
  const members = readUnionMembers('AgentStatus')
  const written = writtenInSrc((source, file) => scanAgentStatusWrites(source))

  it('parses the union at all, so the checks below cannot pass on an empty scan', () => {
    // The vacuity guard. If this file stops parsing the declaration, every
    // assertion below becomes trivially true and reports a clean bill of
    // health over nothing.
    expect(members.length).toBeGreaterThan(0)
    expect(new Set(members).size).toBe(members.length)
  })

  it('has at least one recognised write form, so the scan is proven live', () => {
    expect(written.size).toBeGreaterThan(0)
    expect(written.size).toBeGreaterThanOrEqual(members.length - 2)
  })

  it('assigns every member', () => {
    expect(members.filter((m) => !written.has(m))).toEqual([])
  })

  it('assigns no member outside the union', () => {
    // The other direction. An assignment the union does not name would be a
    // status a reader cannot predict, and it is the drift this file exists to
    // catch in the shape it is least likely to be caught in.
    expect([...written.keys()].filter((w) => !members.includes(w))).toEqual([])
  })
})

describe('every TaskStatus member is assigned somewhere in src/', () => {
  const members = readUnionMembers('TaskStatus')
  const written = writtenInSrc(scanTaskStatusWrites)

  it('parses the union at all', () => {
    expect(members.length).toBeGreaterThan(0)
    expect(new Set(members).size).toBe(members.length)
  })

  it('has at least one recognised write form, so the scan is proven live', () => {
    expect(written.size).toBeGreaterThan(0)
  })

  it('assigns every member', () => {
    expect(members.filter((m) => !written.has(m))).toEqual([])
  })

  it('assigns no member outside the union', () => {
    expect([...written.keys()].filter((w) => !members.includes(w))).toEqual([])
  })
})

describe('the scan itself is accurate, so a green result is not a broken grep', () => {
  // The controls above read real source, and a source-level test whose parser
  // rots reports "everything is covered" with the same confidence as a correct
  // one. These run the scanners against synthetic snippets, so a regex that
  // silently stops matching — or starts matching the wrong union — fails here
  // rather than quietly approving the drift above.

  it('does not credit a DAGNode write to TaskStatus', () => {
    // The false positive this file is most exposed to. `DAGNode.status`
    // overlaps `TaskStatus`, so a receiver-blind scan would call this a task
    // write and wave through a dead `pending` member.
    const nodeOnly = "node.status = 'pending'\nnode.status = 'running'\nnode.status = 'cancelled'\n"
    expect(scanTaskStatusWrites(nodeOnly, 'orchestrator.ts')).toEqual([])
  })

  it('does not credit TodoItem, Goal, or history-record statuses to either union', () => {
    // `todo.ts` owns a `blocked` and a `pending`; `goal.ts` owns a `cancelled`.
    // Both literals are members of the unions under test, so a scanner that
    // ignored receivers would make `blocked`/`cancelled` look written.
    const foreign = "item.status = 'blocked'\nitem.status = 'pending'\n"
    expect(scanAgentStatusWrites(foreign)).toEqual([])
    expect(scanTaskStatusWrites(foreign, 'todo.ts')).toEqual([])
    expect(scanTaskStatusWrites("goal.status = 'cancelled'\n", 'goal.ts')).toEqual([])
  })

  it('still finds the writes it is supposed to find', () => {
    // The other half: a scanner that rejects everything passes every negative
    // control above while approving nothing. This pins the positives.
    expect(scanAgentStatusWrites("agent.status = 'working'\n")).toEqual(['working'])
    expect(scanAgentStatusWrites("orchestrator.settleAgent(agent.id, 'completed')\n")).toEqual(['completed'])
    expect(scanTaskStatusWrites("node.task.status = 'failed'\n", 'orchestrator.ts')).toEqual(['failed'])
    // The ternary assignment, which is why the RHS is captured whole. Note
    // `completed` appears TWICE: once in the comparison and once in the branch.
    // That is correct — the scanner reports literals, not distinct values — and
    // it is harmless because the consumers only ask "was this member written",
    // which a duplicate cannot change. Pinned here so the count is not mistaken
    // for a dedupe bug.
    expect(
      scanTaskStatusWrites("node.task.status = node.status === 'completed' ? 'completed' : 'failed'\n", 'orchestrator.ts')
    ).toEqual(['completed', 'completed', 'failed'])
  })
})