import type { MemoryEntry, MemoryScope } from "./types"
import { INJECTABLE_SCOPES } from "./types"
import { isNewerThan } from "./memory-store"

/**
 * Automatic memory retrieval: what gets found, and how it is marked once found.
 *
 * THE GOVERNING PRINCIPLE, which every choice in this file is answerable to:
 *
 *   Memory does not speak over what the code says. It says what the code does
 *   not. Writes are explicit, attributed and timestamped. There is NO automatic
 *   writing.
 *
 * The asymmetry that justifies having this at all: **a miss injects silence,
 * never a guess.** An agent that forgets to call a tool fails silently; an
 * injection that misses also fails silently, and only one of them cannot invent
 * a claim about the codebase. That is the whole reason to prefer retrieval over
 * a tool — and also the whole reason retrieval must be narrow enough to miss
 * honestly.
 *
 * The failure this feature exists to avoid was already lived in this project:
 * `speedScore` was documented as a term in model selection and was not, and
 * nothing caught it for two releases. An orchestrator that reports its own
 * recollection about a codebase will confidently say things that stopped being
 * true. So: nothing is written without someone asking, and everything injected
 * is marked as RECOLLECTION rather than as instruction.
 *
 * WHY THE MARKING IS BUILT THE WAY IT IS. Four mechanisms, of which only the
 * last is structural, and the distinction is the point:
 *
 *   1. REGISTER. The block opens by describing ITSELF. Convention.
 *   2. ATTRIBUTION. Every line carries an author and a RELATIVE age, which
 *      degrades as it ages. Convention.
 *   3. POSITION. Injected after the task and before the context-transfer block,
 *      so it reads as trailing narration. Convention.
 *   4. QUOTATION. The value is inside a quoted, attributed line, so a stored
 *      IMPERATIVE — someone will write "always run `bun run migrate` first" —
 *      is visibly a quotation of a note rather than a directive. STRUCTURE.
 *
 * An agent under time pressure can talk past the first three. It cannot read a
 * quotation as an instruction without ignoring the attribution that makes it a
 * quotation. So (4) is the mechanism worth protecting in review, and the
 * closing sentence of the block ("the code is right") is the second.
 */

/** The whole automatic-retrieval scope allowlist. One element, on purpose. */
const INJECTABLE: readonly MemoryScope[] = INJECTABLE_SCOPES

/**
 * Most notes rendered into one block.
 *
 * The DAG prompt is roughly 100–200 tokens before this. Five notes is a ceiling
 * on how much of a task's attention recollection may take, not a target.
 */
export const MAX_RECALL_ENTRIES = 5

/**
 * Total characters of the rendered block, including the header.
 *
 * ~200 tokens. Larger and recollection stops being a note and becomes a second
 * system prompt — which is the specific outcome the marking exists to prevent.
 */
export const MAX_RECALL_CHARS = 800

/** Characters of one stored value before it is cut. */
export const MAX_VALUE_CHARS = 240

/** The block heading. Exported so a test can assert the ABSENCE of it. */
export const RECALL_HEADING = '## Recollections'

/**
 * The lines that open every block, and the reason the block exists.
 *
 * Kept as one constant so the disclaimer cannot be shortened away one line at a
 * time, and so the test that guards the marking asserts against the real text
 * rather than a transcription of it.
 */
const RECALL_PREAMBLE = [
  '## Recollections about these files (people\'s notes, not facts about the code)',
  '',
  'Each line below is something a person wrote down at some point. None of it was',
  'checked against the current code. Verify any of it against the actual files',
  'before you act on it. If it disagrees with what you read, the code is right.',
].join('\n')

/** What retrieval is asked about. Everything here comes from the task. */
export interface RecallRequest {
  /**
   * The task's declared file scope, from `Task.files.include`.
   *
   * EMPTY on the `spawn` / `delegate` tool path, which has no `Task` object at
   * all — see `orchestrator.spawnAgent`. Paths found in `text` are used to cover
   * that path, which is why this is not the only source.
   */
  files: readonly string[]
  /**
   * Freeform task text: the task's name and description, or the `task` string a
   * caller passed to `nexus.spawn`. Only read for path extraction and, in the
   * fallback tier, for tokens. NEVER a value from the store.
   */
  text: string
}

/** One note, and the key that found it. */
export interface RecalledNote {
  entry: MemoryEntry
  /** The `file:` key that matched this note. */
  matchedKey: string
  /**
   * How many EARLIER versions of the same `(scope, key)` this one supersedes.
   *
   * True, and knowable, only because `set` appends. An upserting store could
   * not say this, which is why `set` is not one.
   */
  supersedes: number
}

/** What a spawn injected, and how much of it there was. */
export interface RecallOutcome {
  /**
   * The block, or `null` when nothing matched.
   *
   * `null` is a real, expected result and not an error: with an empty store
   * every task gets `null`, and a miss injects silence.
   */
  block: string | null
  /**
   * How many notes matched, BEFORE capping.
   *
   * The gap between this and `shown` is what the truncation line reports, so a
   * reader of the block is told the same number a caller of this function is
   * told. The two cannot disagree.
   */
  matched: number
  /** How many were rendered into `block`. */
  shown: number
  /**
   * Length of `block` in characters, or 0 for `null`.
   *
   * Reported so prompt-weight regressions are visible. The block is prepended
   * to the prompt and `readSessionTokens` counts it in `input`, so the BILL is
   * accurate — but nothing else in the cost report says how much of a task's
   * input was recollection, and an uncapped block is an uncapped bill.
   */
  characters: number
}

/** The store surface retrieval needs. Narrow on purpose, so it is mockable. */
export interface MemoryReader {
  getByKey(key: string, scope?: MemoryScope): MemoryEntry[]
}

/**
 * The key a note must use to be injected for a given file.
 *
 * ONE convention, so it is learnable and so a miss is diagnosable: a user who
 * wrote `memory-store` instead of `file:src/memory-store.ts` gets silence, and
 * the `memory.set` result tells them the convention so the next attempt
 * fires. A second accepted spelling (bare basename, say) would raise the hit
 * rate and cost the one property that makes the store inspectable: that a key
 * says exactly what it matches.
 */
export function fileKey(file: string): string {
  return `file:${normalizePath(file)}`
}

/**
 * Path spelling differences that must not decide whether a note fires.
 *
 * `./src/a.ts` and `src/a.ts` are the same file, and a task listing one and a
 * note naming the other is a formatting accident, not a different subject. Only
 * separators and `./` prefixes are normalised — NOT case, and NOT `..`
 * resolution, because those change which file is meant and silently
 * normalising them would make a note fire against a file the writer did not
 * name.
 */
function normalizePath(file: string): string {
  return file.trim().replace(/\\/g, '/').replace(/^\.\//, '')
}

/**
 * A token that looks like a source path inside freeform task text.
 *
 * The `spawn` / `delegate` tools receive a task STRING, not a `Task`, so
 * `files.include` does not exist on that path. A task string that mentions
 * `src/auth/jwt.ts` has named a file, and using that is strictly better than
 * matching on prose: it is the same key convention, it is an exact lookup on an
 * indexed column, and it cannot match a word inside an unrelated key.
 *
 * THE LEADING BRANCH IS `(?:^|[\s"'`(,]|\[)` AND NOT ONE BIGGER CLASS, and the
 * split is not stylistic. An unescaped `[` inside a character class -- which is
 * what the class-merging form writes, and what `bun lint`'s
 * `noUselessEscapeInRegex` rule pushes you towards -- makes this pattern match
 * NOTHING AT ALL, silently: no throw, no warning, just an empty result on every
 * task. Verified on this Bun: in the merged form all four of
 * `fix the bug in src/auth/jwt.ts please`, `(see ./src/a/b.ts)`,
 * `x src/c.ts, done` and `array src/foo.test.ts] end` extract nothing, and the
 * `spawn` / `delegate` path stops retrieving entirely while every other test
 * still passes.
 *
 * The test `reads file paths out of freeform task text` in
 * `test/memory-recall.test.ts` is the only thing that catches it. That test is
 * load-bearing for this reason and not for its own sake -- do not narrow it to a
 * single case.
 */
const PATH_LIKE = /(?:^|[\s"'`(,]|\[)((?:\.{0,2}\/)?(?:[\w.@~-]+\/)+[\w.@~-]+\.\w{1,8})(?=$|[\s"'`)\],:;])/g

/**
 * Every `file:` key this task could match, in retrieval order.
 *
 * Tier 1 is the task's declared file scope. Tier 2 is paths named in the text,
 * which is the only file signal the tool path has. Both produce the SAME key
 * shape, so both resolve through one exact lookup — there is one convention to
 * learn and one thing to be wrong about.
 */
export function candidateKeys(request: RecallRequest): string[] {
  const keys: string[] = []
  const seen = new Set<string>()
  const add = (key: string): void => {
    if (seen.has(key)) return
    seen.add(key)
    keys.push(key)
  }

  for (const file of request.files) {
    const normalized = normalizePath(file)
    if (normalized) add(fileKey(normalized))
  }

  for (const match of request.text.matchAll(PATH_LIKE)) {
    const found = match[1]
    if (found) add(fileKey(found))
  }

  return keys
}


/**
 * Find the notes this task should be reminded of, ranked for retention.
 *
 * RETRIEVAL IS EXACT LOOKUPS ONLY, and that is a correction to the design this
 * was built from rather than a simplification of it. The design specified a
 * third, weaker tier — substring `LIKE` over the key column, against the task's
 * prose — and it was implemented and then removed, because it falsifies the
 * feature's central claim.
 *
 * The design's own argument for having automatic retrieval at all is an
 * asymmetry: a MISS INJECTS SILENCE, NEVER A GUESS, which is the one property a
 * tool call cannot have. A substring tier destroys exactly that. With nothing
 * written about the task's files, the tier still finds something — on a
 * substring of any word the writer happened to use. A real observation from
 * this codebase's own test run: a task scoped to `src/totally-other.ts` was
 * handed a note about `src/memory-store.ts`, matched on the single word
 * "store" from a task named "tidy the store". A miss produced a guess.
 *
 * The cost of that is not just the tokens. A block that appears on most tasks
 * with mostly-irrelevant content TEACHES the agent to skim past a section
 * titled "Recollections", and a section that has been discounted is useless on
 * the task where it was right. The marking only survives if being rare is what
 * makes it worth reading. So a miss is silence, the block is a signal when it
 * appears, and the tokens are spent only on genuine matches.
 *
   * WHAT REPLACED IT: paths NAMED IN THE TASK TEXT, resolved to the same `file:`
 * key and the same exact lookup. That is what the substring tier was for — the
 * `spawn` / `delegate` tools receive a string, so there is no `files.include`
 * to read — and it does that job with a far stronger signal, on an indexed
 * column, with no scan. A task that says "fix the token check in
 * src/auth/jwt.ts" has named a file, and that is worth retrieving on. A task
 * that says "tidy the store" has named a WORD, and a word is not a file.
 *
 * `reader.searchKeys` is therefore NOT called from here. A key-only
 * `searchKeys` was implemented on the store for this tier and then REMOVED
 * rather than left exported and unused — an unused exported method is the same
 * dead knob this change deletes twice elsewhere. `MemoryReader` keeps only
 * `getByKey`, which is also the strongest statement of the guarantee: automatic
 * retrieval performs exact key lookups and reads no other column at all, so
 * there is no path by which a `session` blob's nested content could be reached
 * even if the scope allowlist were removed.
 *
 * WHAT THAT DOES TO THE UNBOUNDED-TABLE CONCERN. The design worried that
 * `project` is exempt from `maxEntries`, so any scan over it is unbounded. That
 * worry is now confined to `search`, which is a TOOL the caller chooses to
 * invoke and which reports its own result count: the cost is on a path someone
 * asked for, and `nexus.memory.list` prints `byScope` so growth is a number a
 * user can see. The spawn path — which runs unattended, once per task, for
 * every task — does no scan at all.
 *
 * VERSIONS ARE COLLAPSED TO THE NEWEST, and that is the single most important
 * behaviour in this function. `getByKey` returns every version of a key — `set`
 * appends, deliberately, so a correction is a new version and the old one stays
 * readable — and rendering them all would inject the wrong text alongside the
 * right text and let an agent act on either. A note that was corrected and then
 * still shown is worse than no note, because it looks exactly as authoritative
 * as the version that replaced it.
 *
 * `supersedes` is resolved HERE rather than left to the caller, so the exported
 * function cannot hand back a note whose supersede count is a placeholder.
 */
export function recallNotes(reader: MemoryReader, request: RecallRequest): RecalledNote[] {
  const found = new Map<string, RecalledNote>()

  for (const key of candidateKeys(request)) {
    for (const scope of INJECTABLE) {
      for (const entry of reader.getByKey(key, scope)) {
        // De-duplicated by id: one key can be reached by more than one tier,
        // and the same note appearing twice is a note the reader would count
        // twice.
        if (found.has(entry.id)) continue
        // Scope-filtered on what actually came back, not only on what was asked
        // for. The reader is given the scope, and this is the guard that holds
        // if a reader ever ignores its `scope` argument: exact lookups do not
        // read values either, so a leaked `session` blob would not otherwise
        // announce itself.
        if (!INJECTABLE.includes(entry.scope)) continue
        found.set(entry.id, { entry, matchedKey: key, supersedes: 0 })
      }
    }
  }

  // `getByKey` is ordered oldest-first, but the comparison is made explicit and
  // by ID rather than by arrival order. Arrival order is not a version order:
  // two writes in the same millisecond share a `timestamp`, so picking the last
  // arrival picks whichever the store happened to return, and a user who
  // corrected a note would be shown the text they had replaced.
  const newestPerKey = new Map<string, RecalledNote>()
  for (const note of found.values()) {
    const key = versionKeyOf(note)
    const held = newestPerKey.get(key)
    if (!held || isNewerThan(note.entry, held.entry)) {
      newestPerKey.set(key, note)
    }
  }

  const notes = rankForRetention([...newestPerKey.values()])
  for (const note of notes) {
    // Counted against the note's OWN key, never against `matchedKey`: a
    // fallback-tier hit carries a `~token` marker there, which matches nothing.
    // The scope comes from the entry, so a reader given a narrower scope than
    // the note was written in reports 0 rather than an inflated count.
    note.supersedes = reader
      .getByKey(note.entry.key, note.entry.scope)
      .filter(v => v.id !== note.entry.id).length
  }
  return notes
}

/**
 * The `(scope, key)` a note is versioned under.
 *
 * `matchedKey` is the key that FOUND the note, which for a fallback-tier hit is
 * a `~token` marker rather than a real key. Version counting has to use the
 * note's own key or it counts the wrong family.
 */
/**
 * The identity a note is versioned under: its scope AND its own key.
 *
 * `matchedKey` is deliberately not this. It is the key that FOUND the note,
 * which for a fallback-tier hit is a `~token` marker rather than a real key, and
 * using it would count versions against a key that matches nothing.
 *
 * Scope is part of the identity because the same key in two scopes is two
 * unrelated things — `test/memory-store.test.ts` already relies on that — and
 * collapsing across scopes would add a `session` blob's version count to a
 * `project` note's.
 */
function versionKeyOf(note: RecalledNote): string {
  return `${note.entry.scope}|${note.entry.key}`
}

/**
 * The order notes are DROPPED in, which is the reverse of the order they are
 * kept in.
 *
 * A note whose author STATED a low confidence goes before one that stated
 * nothing, because a stated low value is a reason to drop and no statement is
 * not. Ordering `null` last for retention is the same decision as rendering it
 * as "not stated" rather than as `0`: treating an absence as a low score would
 * penalise the author for being honest about not knowing, and would make the
 * honest entry the first thing to disappear under the cap.
 *
 * Ties break oldest-first, so the cap sheds the least recent of equally-ranked
 * notes.
 */
function rankForRetention(notes: RecalledNote[]): RecalledNote[] {
  return notes.sort((a, b) => {
    const rank = (c: number | null): number => (c === null ? Number.POSITIVE_INFINITY : c)
    const diff = rank(b.entry.confidence) - rank(a.entry.confidence)
    if (diff !== 0) return diff
    // Newest first among equally-ranked notes, so the cap sheds the OLDEST of
    // them. By id, so same-millisecond notes do not sort arbitrarily — see
    // `isNewerThan`.
    return isNewerThan(a.entry, b.entry) ? -1 : 1
  })
}

/**
 * Render the block, or `null` if there is nothing to say.
 *
 * `notes` is expected to be the ranked, capped list. The character cap is
 * enforced HERE, in the renderer, rather than at the reader, so that it applies
 * to the text the agent actually receives rather than to a list that later
 * shrinks for a different reason.
 *
 * TRUNCATION IS ANNOUNCED, and that is the load-bearing part. A block that
 * silently shows three of nine reads as "those were all of them", which is the
 * exact failure the marking exists to prevent: a reader told a partial set is a
 * reader who knows to look for the rest. The precedent and the reasoning are
 * the dashboard's — see `test/dashboard-page-execution.test.ts`, where the
 * reason given is "the count, so a line that shows three of nine does not read
 * as three".
 */
export function renderRecall(notes: RecalledNote[]): RecallOutcome {
  if (notes.length === 0) {
    return { block: null, matched: 0, shown: 0, characters: 0 }
  }

  const matched = notes.length
  const rendered: string[] = []
  let budget = MAX_RECALL_CHARS - RECALL_PREAMBLE.length
  let shown = 0

  for (const note of notes) {
    if (shown >= MAX_RECALL_ENTRIES) break
    const line = renderNote(note)
    // A line that does not fit is not shortened to fit: a note cut mid-sentence
    // is a note that reads as a complete claim, which is the specific harm the
    // marking is for. It is dropped, and the drop is counted.
    if (line.length > budget) {
      if (shown === 0) {
        // Nothing fit at all. Still emit the header, because "there are
        // recollections and they did not fit" is information; silently emitting
        // nothing would be indistinguishable from "no recollections", which is
        // what a truncated-to-zero block would read as.
        const block = `${RECALL_PREAMBLE}\n\n(showing 0 of ${matched} notes — none fitted within the ${MAX_RECALL_CHARS}-character limit)`
        return { block, matched, shown: 0, characters: block.length }
      }
      break
    }
    rendered.push(line)
    budget -= line.length + 1
    shown++
  }

  const parts = [RECALL_PREAMBLE, '']
  if (shown < matched) {
    parts.push(`(showing ${shown} of ${matched} notes — the rest did not fit)`)
    parts.push('')
  }
  parts.push(...rendered)
  const block = parts.join('\n')
  return { block, matched, shown, characters: block.length }
}

/** One bullet: key, age, author, confidence, supersede count, then the VALUE. */
function renderNote(note: RecalledNote): string {
  const meta = [
    `written ${relativeAge(note.entry.timestamp)}`,
    `by ${note.entry.author}`,
    note.entry.confidence === null
      ? 'confidence: not stated'
      : `confidence: ${note.entry.confidence}`,
    note.supersedes > 0
      ? `supersedes ${note.supersedes} earlier version${note.supersedes === 1 ? '' : 's'}`
      : null,
  ].filter(Boolean).join(', ')

  return `- key "${note.matchedKey}" — ${meta}:\n  "${renderValue(note.entry.value)}"`
}

/**
 * A stored value as ONE quoted line.
 *
 * Quotation is the structural half of the marking, so it is applied here, to
 * every value, without exception: a value containing an imperative sentence
 * ("always run the migration first") is the case the whole format exists for,
 * and it only reads as a quotation because it is wrapped in one and attributed.
 * The `memory-recall` test asserts exactly that.
 *
 * JSON for objects and arrays, because that is how the store serialises them
 * and re-serialising here is the only way a reader can see the shape. Strings
 * are emitted bare — a string value is already text, and quoting JSON's own
 * quotes inside a quoted line is noise.
 */
function renderValue(value: unknown): string {
  let text: string
  if (typeof value === 'string') {
    text = value
  } else {
    try {
      text = JSON.stringify(value) ?? String(value)
    } catch {
      // Cyclic or otherwise unserialisable. The store already JSON-encoded it
      // to write it, so this cannot normally happen — but a renderer that
      // throws takes down a task's prompt, and a note is never worth that.
      text = String(value)
    }
  }
  text = text.replace(/\s*\n\s*/g, ' ').trim()
  if (text.length > MAX_VALUE_CHARS) {
    return `${text.slice(0, MAX_VALUE_CHARS - 1).trimEnd()}…`
  }
  return text
}

/**
 * How long ago something was written, in plain words.
 *
 * RELATIVE, and that is a correctness decision rather than a style one: a date
 * is a fact that goes stale silently, while an age degrades as it ages and
 * tells the reader the useful thing — that this was true a while ago, and how
 * long a while that is.
 *
 * Hand-rolled arithmetic, no `Intl` and no `toLocaleDateString`. Localised or
 * timezone-dependent date rendering is exactly the class of thing that passes
 * on a development machine and differs on CI, and the words below are the
 * output contract.
 */
export function relativeAge(timestamp: Date, now: number = Date.now()): string {
  const ms = Math.max(0, now - timestamp.getTime())
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  if (days < 14) return `${days} day${days === 1 ? '' : 's'} ago`
  const weeks = Math.floor(days / 7)
  if (weeks < 9) return `${weeks} week${weeks === 1 ? '' : 's'} ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`
  const years = Math.floor(days / 365)
  return `over ${years} year${years === 1 ? '' : 's'} ago`
}

/**
 * Find and render in one call. The shape every caller wants.
 *
 * `countSuperseded` runs only over what survived, so the common miss costs one
 * indexed lookup and nothing else.
 */
export function recallForTask(reader: MemoryReader, request: RecallRequest): RecallOutcome {
  const notes = recallNotes(reader, request)
  if (notes.length === 0) {
    return { block: null, matched: 0, shown: 0, characters: 0 }
  }
  // DELIBERATELY NOT PRE-SLICED to the entry cap. An earlier version sliced
  // here "so a note that would be dropped does not cost a supersede lookup", and
  // that optimisation cost the one thing the block exists to get right: the
  // renderer reads `notes.length` as the number that MATCHED, so pre-slicing
  // turned "showing 5 of 50 notes" into "showing 5 of 5" — a block claiming the
  // five it shows were ALL of them, which is precisely the failure the
  // announced count exists to prevent. `renderRecall` enforces the cap itself.
  return renderRecall(notes)
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOL RESULTS
//
// Formatting for the `memory.set` / `search` / `list` tools, kept here beside
// the prompt block rather than in `index.ts` for one reason: the honesty
// requirements are the same on both surfaces, and the instruction that makes a
// reader verify what they are told has to be stated in ONE place to be kept.
// A tool result is a place a user reads, so it carries the same warning the
// prompt block carries — plus the thing the prompt block cannot say, which is
// that a result count is a hit count and never a relevance count.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The warning every tool result opens with, in full.
 *
 * NOT OPTIONAL AND NOT CONFIGURABLE, and the reason it lives in the RESULT
 * rather than only in the tool description is the one `git.check` already
 * documents: a subagent is driven by tool calls and may never have read the
 * description. An instruction that only exists in the description reaches
 * whoever happened to read it.
 */
export const UNVERIFIED_NOTES_WARNING = [
  'These are notes PEOPLE wrote down. Nothing here was checked against the',
  'code, and it is never checked for you. Matching is a plain substring test',
  'over stored text — it is unranked, so a result count is how many entries',
  'mention your words, NOT how many are relevant.',
  'Treat a match as a lead: read the file before you act on any of it. If a',
  'note disagrees with the code, the code is right.',
].join(' ')

/** The `author` caveat. True of every entry, so stated once, up front. */
export const SELF_REPORTED_AUTHOR_WARNING =
  'The author shown is whatever the writer put in `author`. Nothing verifies it, so treat it as a claim, not a record.'

/** Scopes an agent-written note may use. See `WRITABLE_SCOPES`. */
export const WRITABLE_SCOPES = ['project', 'temp'] as const satisfies readonly MemoryScope[]

/** One entry, one line, for a tool result. */
export function formatEntry(entry: MemoryEntry, prefix = ''): string {
  const when = relativeAge(entry.timestamp)
  const confidence = entry.confidence === null ? 'confidence not stated' : `confidence ${entry.confidence}`
  const body = renderValue(entry.value)
  return `${prefix}[${entry.scope}] ${entry.key} — ${body} (written ${when} by ${entry.author}, ${confidence}, id ${entry.id})`
}

/** A short header naming a scope and a db path, for a result that found nothing. */
function storeHeader(total: number, dbPath: string): string {
  return `${total} entr${total === 1 ? 'y' : 'ies'} in the memory store at ${dbPath}.`
}

/**
 * The two empties, told apart.
 *
 * "0 results" alone is ambiguous between "nothing was ever written" and "the
 * search is broken", and those are diagnosed in completely different ways — one
 * by writing a note, the other by an afternoon. So an empty STORE says so and
 * names the file on disk, which is the thing to go and look at; a non-empty
 * store with no match says how much IS stored, which is the thing that proves
 * the query ran.
 */
export function describeEmptyResult(
  query: string,
  total: number,
  dbPath: string
): string {
  if (total === 0) {
    return [
      `No matches for "${query}": the memory store is EMPTY.`,
      storeHeader(0, dbPath),
      '',
      'Nothing has ever been written to it, so "no matches" here means nothing was',
      'remembered — it does not mean the search failed. Write the first note with',
      '`memory.set` to change that.',
    ].join('\n')
  }
  return [
    `0 matches for "${query}" in a store holding ${total} entries.`,
    storeHeader(total, dbPath),
    '',
    'The query ran and matched nothing. That is a real answer, not a failure — but',
    'it is also a WEAK one, because matching is a substring test: a note can be',
    'relevant and miss on wording, and an irrelevant one can match on a common',
    'word. Try a path or an identifier from the code rather than a description.',
  ].join('\n')
}

/**
 * The `memory.set` result: the three facts a user would otherwise get wrong.
 *
 * A tool named `set` that silently appends is the defect this text exists to
 * prevent. Writing the same key twice leaves BOTH readable, so a user who
 * believes they corrected a note may be looking at the version they meant to
 * replace. So: what happened, how many versions now exist, and which one agents
 * will see.
 */
export function describeSetResult(input: {
  entry: MemoryEntry
  versionsUnderKey: number
  evicted: { scope: MemoryScope; count: number } | null
}): string {
  const { entry, versionsUnderKey, evicted } = input
  const lines = [
    `Stored under key "${entry.key}" in scope "${entry.scope}", as version ${versionsUnderKey} of that key.`,
    '',
    'THREE THINGS THAT ARE EASY TO GET WRONG:',
    '  1. This APPENDED. Nothing was overwritten. Every earlier version of this key',
    '     is still on disk and still readable under the same key.',
    '  2. Agents are shown the MOST RECENT version only. That is the one above.',
    '  3. There is no `memory.delete` TOOL — removal is API-only, deliberately,',
    '     because an agent that finds a note inconvenient will delete it to unblock',
    '     itself. Correcting a note means writing a new version, not removing the old.',
  ]

  if (versionsUnderKey > 1) {
    lines.push('', `${versionsUnderKey - 1} earlier version(s) of this key remain, and will be reported as superseded.`)
  }

  if (!isAutoInjectableKey(entry.key)) {
    lines.push(
      '',
      'THIS NOTE WILL NOT BE INJECTED INTO ANY TASK\'S PROMPT. Automatic retrieval',
      'only looks up keys of the form `file:<path>`, against the files a task is',
      'scoped to. A note under any other key is reachable only through',
      '`memory.search` and `memory.list`, by whoever goes looking.',
      'To have it appear automatically, write it under the file it is about:',
      `  key: "file:${examplePathForKey(entry.key)}"`,
      'That is the whole convention — one rule, and a note that misses it is a note',
      'that is silently never shown.'
    )
  }

  if (evicted) {
    lines.push(
      '',
      `AND: storing this entry evicted ${evicted.count} older entr${evicted.count === 1 ? 'y' : 'ies'} from scope ` +
      `"${evicted.scope}" to stay within that scope's entry cap. ` +
      'The "project" scope is never evicted this way. `memory.list` reports these totals.'
    )
  }

  return lines.join('\n')
}

/**
 * Whether a key can ever be injected automatically.
 *
 * `file:` is the only automatic shape, and being strict about it is what keeps
 * a key honest: a key says exactly what it matches, so a note that does not
 * fire is diagnosable by reading the key.
 */
export function isAutoInjectableKey(key: string): boolean {
  return key.startsWith('file:') && key.length > 'file:'.length
}

/** A plausible file path for a key that is not `file:`-shaped, for the hint. */
function examplePathForKey(key: string): string {
  const cleaned = key.replace(/^[a-z]+:/i, '').trim()
  if (cleaned && /[./]/.test(cleaned)) return cleaned
  return 'src/the-file-this-is-about.ts'
}

/**
 * The `memory.search` result, with a label on anything that is not a note.
 *
 * D1: the allowlist is applied by the CALLER, and a `session` hit is labelled
 * rather than presented as a note. That label is the whole point of the opt-in
 * existing at all — `includeSession` is for a user debugging why a task
 * escalated, and in that context a failure blob IS the answer, but it is not
 * something about their project and must not read like one.
 */
export function describeSearchResult(input: {
  query: string
  results: MemoryEntry[]
  storeTotal: number
  dbPath: string
  includeSession: boolean
}): string {
  const { query, results, storeTotal, dbPath, includeSession } = input
  if (results.length === 0) return describeEmptyResult(query, storeTotal, dbPath)

  const header = [
    `${results.length} match${results.length === 1 ? '' : 'es'} for "${query}"${includeSession ? ' (project + internal session context)' : ' (project scope only)'}.`,
    storeHeader(storeTotal, dbPath),
    '',
    UNVERIFIED_NOTES_WARNING,
    '',
    SELF_REPORTED_AUTHOR_WARNING,
    '',
  ].join('\n')

  const body = results.map(entry => {
    if (entry.scope === 'session') {
      // Prefixed, not footnoted. A line that says "internal escalation context"
      // mid-sentence is read as a note; a line whose FIRST token says so is not.
      return `  [session] ${entry.key}\n      INTERNAL ESCALATION CONTEXT, NOT A NOTE ABOUT YOUR PROJECT. This is a\n      snapshot of a failed agent's own state, written by the orchestrator when a\n      task exhausted its retries. It nests that agent's memory entries inside\n      itself, which is why it is opt-in only.\n      — ${renderValue(entry.value)} (${relativeAge(entry.timestamp)} by ${entry.author}, id ${entry.id})`
    }
    return `  ${formatEntry(entry)}`
  }).join('\n')

  const scopeNote = includeSession
    ? '\nOnly the [project] entries are ever injected into a task. The [session] ones are never.'
    : '\nProject scope only. Internal escalation context is excluded by default; pass includeSession: true to see it.'

  return `${header}\n${body}\n${scopeNote}`
}

/**
 * The `memory.list` result.
 *
 * Reports the per-scope entry count and the eviction totals together, because
 * they are the same question: "is everything I wrote still there?" A number
 * that only answers it when you already suspect the answer is not a number that
 * helps.
 */
export function describeListResult(input: {
  scope: MemoryScope
  entries: MemoryEntry[]
  versionsSuperseded: number
  byScope: Record<string, number>
  evicted: Record<string, number>
  truncatedAt: number
  dbPath: string
}): string {
  const { scope, entries, versionsSuperseded, byScope, evicted, truncatedAt, dbPath } = input
  const counts = Object.entries(byScope).map(([s, n]) => `${s} ${n}`).join(', ') || 'no entries'
  const evictions = Object.entries(evicted)
  const evictionLine = evictions.length === 0
    ? 'Nothing has been evicted this run.'
    : `Evicted this run to stay within per-scope caps: ${evictions.map(([s, n]) => `${n} from ${s}`).join(', ')}. ` +
      'The "project" scope is never evicted this way. These totals reset when the process restarts, so they UNDER-report across runs.'

  if (entries.length === 0) {
    return [
      `No entries in scope "${scope}".`,
      storeHeader(Object.values(byScope).reduce((a, b) => a + b, 0), dbPath),
      `By scope: ${counts}.`,
      '',
      evictionLine,
      '',
      UNVERIFIED_NOTES_WARNING,
    ].join('\n')
  }

  const truncationNote = versionsSuperseded > 0
    ? `(showing ${entries.length} notes; ${versionsSuperseded} earlier version(s) of a key are not listed — ` +
      'the newest version of each key is, and `memory.search` on the key will show all of them)'
    : ''

  return [
    `${entries.length} note(s) in scope "${scope}".`,
    storeHeader(Object.values(byScope).reduce((a, b) => a + b, 0), dbPath),
    `By scope: ${counts}.`,
    '',
    evictionLine,
    '',
    UNVERIFIED_NOTES_WARNING,
    '',
    SELF_REPORTED_AUTHOR_WARNING,
    '',
    truncationNote,
    ...entries.map(entry => formatEntry(entry, '  ')),
    '',
    cappedAtNote(truncatedAt),
  ].filter(line => line !== '').join('\n')
}

function cappedAtNote(truncatedAt: number): string {
  return `Capped at ${truncatedAt}. Raise the cap for a wider view — it changes nothing about which notes are real.`
}
