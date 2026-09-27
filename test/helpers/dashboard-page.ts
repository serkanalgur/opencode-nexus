import { join } from 'node:path'

/**
 * Reading the dashboard page's inline script, for the tests that need it.
 *
 * Two tests need the page's source and neither should own the extraction: the
 * static contract test (`dashboard-page-contract.test.ts`) greps it, and the
 * execution test (`dashboard-page-execution.test.ts`) runs it. A second copy of
 * the `<script>` regex would be a second thing to rot — and the rot would be
 * silent, because both tests would keep passing against an empty string. So the
 * extraction lives here once, and both consumers get the same bytes.
 *
 * There is nothing browser-specific in this module: it is file reading and
 * string handling, deliberately, so the execution test's harness can be the only
 * place that knows what a DOM is.
 */

/** The page the dashboard server serves. */
export const HTML_PATH = join(import.meta.dir, '..', '..', 'dashboard', 'index.html')

/** The served HTML, as bytes on disk. */
export async function readDashboardHtml(): Promise<string> {
  return Bun.file(HTML_PATH).text()
}

/**
 * The page's executable source: the single inline `<script>` body.
 *
 * Throws rather than returning `''` when the block is gone or the page grows a
 * second one, because every caller downstream would otherwise quietly test
 * nothing. The page is required to stay a single hand-written script with no
 * build step — that constraint is what this file is inlined into.
 */
export function extractInlineScript(html: string): string {
  const blocks = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) ?? []
  if (blocks.length !== 1) {
    throw new Error(
      `dashboard/index.html must contain exactly one inline <script> block, found ${blocks.length}`,
    )
  }
  const body = /<script\b[^>]*>([\s\S]*?)<\/script>/.exec(blocks[0] as string)
  if (body === null) throw new Error('dashboard/index.html has an unreadable <script> block')
  return body[1] as string
}

/**
 * The script with comments removed.
 *
 * Comment stripping is the point, not a convenience. The page documents at
 * length WHY certain keys are not read — `criticalThreshold`, `autoTerminate`,
 * `config:update` all appear in prose explaining their removal — and a grep that
 * cannot tell prose from code would either fail on the explanation or force the
 * explanation out of the file. What is left is what actually runs.
 *
 * Line-based and therefore unsound about a `//` inside a string literal; sound
 * here because the page has none, and because `executableSource` is only ever
 * used for pattern absence/presence checks that a stray comment cannot satisfy
 * on its own.
 */
export function executableSource(script: string): string {
  return script
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')
}

/**
 * One named function's source, brace-matched, out of a comment-free script.
 *
 * Brace counting is naive about braces inside string literals, which is a real
 * caveat and not a hypothetical one: the page's prose is full of `{`. It is
 * sound for the small numeric and formatting helpers it is currently used on,
 * none of which contain a brace in a string — and `extracted` is asserted
 * non-empty by every caller, so a match that silently found the wrong span fails
 * rather than passing.
 *
 * Extracting one function at a time is also why this helper exists at all: the
 * execution test does NOT use it. That test loads the whole script and lets the
 * page's own `var` hoisting, its own IIFE and its own module-level state behave
 * as they do in a browser, which is the only way a use-before-declaration is
 * visible — it is invisible to every other check in the suite, which is how one
 * shipped.
 */
export function functionSource(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`)
  if (start === -1) throw new Error(`dashboard/index.html has no function ${name}`)
  let depth = 0
  let opened = false
  for (let i = start; i < source.length; i++) {
    const ch = source[i]
    if (ch === '{') {
      depth++
      opened = true
    } else if (ch === '}') {
      depth--
      if (opened && depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced braces while extracting ${name}`)
}

// ── Reading field names out of the server's own source ──────────────────────
//
// WHY THIS EXISTS
//
// The failure these serve is a field the server SENDS and the page does not
// READ. `stat-sessions` sat at `—` for the life of the card because
// `$statSessions` was resolved by `getElementById` and never assigned, while
// the page did read `state.sessions` in `renderSessions` — so the static
// contract test's required-field list passed, and a reader had no way to tell
// "reads the field somewhere" from "fills this element". Three more of the same
// shape were found in one pass: `cost:delta.settledTier`,
// `config:reloaded.trigger` and `SessionStateView.spawnedAt`.
//
// A list of fields the page reads cannot catch that, because the list is
// written by the same hand as the page. A list of fields the SERVER SENDS can,
// and it can be read out of the server's own declarations instead of being
// retyped — which is what these helpers do. A field added to `SessionStateView`
// makes a test fail until somebody decides whether the page consumes it, and
// that is the only version of the check that generalises past the four defects
// that prompted it.

/**
 * Read one of the server's TypeScript sources.
 *
 * Deliberately raw: the point is to read what the server DECLARES, so a
 * transformation here would mean the enumeration is of something other than the
 * contract.
 */
export async function readSourceFile(name: string): Promise<string> {
  return Bun.file(join(import.meta.dir, '..', '..', 'src', `${name}.ts`)).text()
}

/**
 * Replace every comment and string literal with spaces, preserving length.
 *
 * Sound, rather than approximately sound, and that is the whole reason it
 * exists. Every extraction below is then plain brace counting and line scanning
 * over text in which a brace can only be a brace — which removes the caveat the
 * older `executableSource`/`functionSource` helpers above carry about braces
 * inside prose. This codebase is full of `{` in doc comments and of template
 * literals containing braces, and counting those would produce field names read
 * out of a comment.
 *
 * Length is preserved so that an index found in a blanked copy is a valid index
 * into the original. Newlines survive, because the line-oriented scan below
 * depends on them.
 *
 * `strings: false` blanks comments only. The `emit` lookup needs the string
 * argument (`this.emit('cost:delta', …)`) to be visible, and then reads
 * structure out of a second, fully blanked copy at the same offsets.
 *
 * `split('')`, NOT `[...source]`, and that is load-bearing. The spread iterates
 * CODE POINTS while every index below — `source[i]`, `matchBrace`, and each
 * caller's own `slice` offsets — is a UTF-16 CODE UNIT, so a single astral
 * character (an emoji, which this codebase uses in string literals AND in doc
 * comments) silently shifts every position after it. The blanked copy was then
 * SHORTER than its input and every offset into it was wrong, which surfaced as a
 * field name read out of the middle of a comment: an unrelated doc comment
 * containing an emoji above a declaration failed the completeness check with a
 * member no declaration has. `split('')` gives one slot per code unit, so the
 * blanked copy is index-for-index the same string it came from.
 */
export function blankNonCode(source: string, strings = true): string {
  const out = source.split('')
  const n = source.length
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' '
  }
  let i = 0
  while (i < n) {
    const ch = source[i]
    const next = i + 1 < n ? source[i + 1] : ''
    if (ch === '/' && next === '/') {
      let j = i
      while (j < n && source[j] !== '\n') j++
      blank(i, j)
      i = j
    } else if (ch === '/' && next === '*') {
      let j = i + 2
      while (j < n && !(source[j] === '*' && source[j + 1] === '/')) j++
      const end = Math.min(j + 2, n)
      blank(i, end)
      i = end
    } else if (strings && (ch === '"' || ch === "'" || ch === '`')) {
      i = blankStringLike(source, out, i, ch, blank)
    } else {
      i++
    }
  }
  return out.join('')
}

/**
 * Blank a `"`/`'` literal, or a template literal including its interpolations.
 *
 * A template literal is not skippable as one span: `${ … }` holds CODE, and a
 * brace inside it has to keep counting or the enclosing region is closed at the
 * wrong place. So the interpolations are blanked recursively — their own strings
 * and comments — while their braces are left in place.
 */
function blankStringLike(
  source: string,
  out: string[],
  start: number,
  quote: string,
  blank: (from: number, to: number) => void,
): number {
  const n = source.length
  blank(start, start + 1)
  let i = start + 1
  while (i < n) {
    const ch = source[i]
    if (ch === '\\') {
      blank(i, i + 2)
      i += 2
    } else if (ch === quote) {
      blank(i, i + 1)
      return i + 1
    } else if (quote === '`' && ch === '$' && source[i + 1] === '{') {
      const end = matchBrace(source, i + 1)
      const inner = blankNonCode(source.slice(i + 2, end))
      for (let k = 0; k < inner.length; k++) out[i + 2 + k] = inner[k]
      i = end + 1
    } else {
      blank(i, i + 1)
      i++
    }
  }
  return i
}

/** The index of the `}` closing the `{` at `openIndex`. Throws if unbalanced. */
export function matchBrace(source: string, openIndex: number): number {
  let depth = 0
  for (let i = openIndex; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  throw new Error(`unbalanced braces from offset ${openIndex}`)
}

/**
 * Split a declaration body into its members, on commas AND newlines.
 *
 * Both, because the declaration forms in this codebase separate their members
 * differently and the extractor has to read all of them: an interface body is
 * newline-separated with no commas at all, an object literal is comma-separated,
 * and a single-line inline type is `;`-separated —
 * `result?: { success: boolean; output?: string; error?: string; duration: number }`
 * is how `OrchestratorState` declares its task result. Splitting on newlines
 * alone would break a value that wraps over several lines, and on commas alone
 * would read an interface as a single member — so the split is on any of the
 * three, and only where nothing is open.
 *
 * The angle brackets are the fiddly part and they are not optional: a `models`
 * declaration of `Record<string, string>` has a comma inside `<…>`, and missing
 * it turns the tail of that type into a phantom second property called
 * `string`. An angle is opened only when it is glued to a word character on the
 * left and is not followed by whitespace, which separates `Record<string` from
 * `a < b`; `=>` never closes one, because the `>` of an arrow is preceded by
 * `=`. Both of those are heuristics, and they are stated rather than buried
 * because the alternative — treating the extraction as authoritative — is what
 * makes the self-check in the test worth having.
 */
function splitMembers(code: string): string[] {
  const segments: string[] = []
  let depth = 0
  let angle = 0
  let start = 0
  const cut = (at: number): void => {
    segments.push(code.slice(start, at))
    start = at + 1
  }
  for (let i = 0; i < code.length; i++) {
    const ch = code[i] as string
    const prev = i > 0 ? (code[i - 1] as string) : ''
    const next = i + 1 < code.length ? (code[i + 1] as string) : ''
    if (ch === '<' && next !== '=' && next !== ' ' && next !== '<' && /[\w$>\]]/.test(prev)) {
      angle++
    } else if (ch === '>' && angle > 0 && prev !== '=') {
      angle--
    } else if (ch === '{' || ch === '[' || ch === '(') {
      depth++
    } else if (ch === '}' || ch === ']' || ch === ')') {
      depth--
    } else if ((ch === ',' || ch === '\n' || ch === ';') && depth === 0 && angle === 0) {
      cut(i)
    }
  }
  segments.push(code.slice(start))
  return segments
}

/** The first `needle` outside every bracket, brace, paren and angle, or -1. */
function indexOfTopLevel(code: string, needle: string): number {
  let depth = 0
  let angle = 0
  for (let i = 0; i < code.length; i++) {
    const ch = code[i] as string
    if (ch === '<' && /\s/.test(code[i + 1] ?? ' ')) continue
    if (ch === '<') angle++
    else if (ch === '>' && angle > 0 && code[i - 1] !== '=') angle--
    else if (ch === '{' || ch === '[' || ch === '(') depth++
    else if (ch === '}' || ch === ']' || ch === ')') depth--
    else if (ch === needle && depth === 0 && angle === 0) return i
  }
  return -1
}

/**
 * The page's own activity-log cap, read out of its source.
 *
 * Restated here it would be a second number to keep in step with the page, and
 * the only thing that depends on it is a guard that has to be about the page's
 * real limit. Read from `executableSource` rather than the raw script so that a
 * commented-out `MAX_LOG_ENTRIES` cannot be the one that is found.
 */
export function logEntryCap(script: string): number {
  const found = /\bMAX_LOG_ENTRIES\s*=\s*(\d+)\s*;/.exec(executableSource(script))
  if (found === null) {
    throw new Error('dashboard/index.html declares no readable MAX_LOG_ENTRIES')
  }
  return Number(found[1])
}

/**
 * Every property name declared at the top level of a `{ … }` region.
 *
 * Handles all three forms these declarations actually use, because the server
 * uses all three and missing any of them would silently weaken the enumeration
 * this exists for:
 *
 *   `name: value`   — the ordinary case, including a value that wraps over
 *                     several lines, which the depth tracking rides over.
 *   `name,`         — SHORTHAND. `this.emit('budget:alert', { remaining,
 *                     remainingPercent })` is how the server writes that event,
 *                     and a scanner that requires a colon sees an empty payload
 *                     and concludes the event carries nothing.
 *   `...expr`       — a conditional spread, as in `cost:delta`'s
 *                     `...(error === undefined ? {} : { error })`. A key that
 *                     only ever arrives under a spread is still a key the page
 *                     can be handed, so the spread's object literals are
 *                     recursed into and their keys unioned in.
 *
 * `name: value` and `name,` are told apart by whether the member has a colon at
 * its own top level: a method signature's parameters are inside parens and a
 * return type's colon follows them, so a method is reported as no property at
 * all rather than as one named after its parameter list.
 *
 * LOUD ON ANYTHING ELSE, which is the fourth decision here and the one that
 * matters most. A member matching neither form used to be skipped, and a skipped
 * member is a field the page is never checked against — the file stays green
 * while the enumeration it exists to provide has quietly shrunk. The concrete
 * case is a QUOTED key: `{ 'totalSpentX': 1, totalSpent }` loses `totalSpentX`
 * entirely, because `blankNonCode` has already blanked the string literal by the
 * time this runs and the head is left as whitespace. It cannot be recovered
 * here — the text is gone, and every caller (`interfaceFieldNames`,
 * `inlineFieldNames`, `emitPayloads`) hands this function an already-blanked
 * body — so the choice is not "accept quoted keys" or "reject them" but "throw
 * and let somebody decide". An unrecognised member in a server declaration is
 * itself the signal worth seeing; a silently dropped one is how this check
 * becomes the thing that lies.
 */
export function topLevelDeclaredNames(body: string): string[] {
  const code = blankNonCode(body)
  const names: string[] = []
  for (const segment of splitMembers(code)) {
    const member = segment.trim()
    if (member === '') continue

    if (member.startsWith('...')) {
      // The union of every object literal the spread can contribute, which is
      // exactly the set of keys this member may add to the payload.
      let contributed = false
      for (let at = member.indexOf('{'); at !== -1; at = member.indexOf('{', at + 1)) {
        contributed = true
        const close = matchBrace(member, at)
        for (const nested of topLevelDeclaredNames(member.slice(at + 1, close))) {
          if (!names.includes(nested)) names.push(nested)
        }
        at = close
      }
      // A spread of something that is not an object literal adds keys this
      // cannot know, which is the same silent shrink as an unread member.
      if (!contributed) {
        throw new Error(
          `cannot read the keys of a conditional spread: ${JSON.stringify(member)} has no object ` +
            `literal in it, so the keys it may contribute are unknown — spread it literally, or ` +
            `name the shape in the test the way IDENTIFIER_PAYLOADS does`,
        )
      }
      continue
    }

    const colon = indexOfTopLevel(member, ':')
    const head = (colon === -1 ? member : member.slice(0, colon)).trim()
    const found = /^(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??$/.exec(head)
    if (found === null) {
      const cause =
        head === ''
          ? 'a quoted key, whose literal blankNonCode has already erased — unquote the key, or ' +
            'declare the shape where the test can reach it'
          : 'a member form this extractor does not recognise'
      throw new Error(
        `cannot read the property name of ${JSON.stringify(member)}: it is ${cause}. A member ` +
          `dropped here is a field nothing checks, so this fails rather than shrinking the ` +
          `enumeration quietly.`,
      )
    }
    names.push(found[1] as string)
  }
  return names
}


/** The `{ … }` body of `interface <name> {`, as offsets into `source`. */
function interfaceBody(source: string, name: string): { open: number; close: number } {
  const at = source.indexOf(`interface ${name} {`)
  if (at === -1) throw new Error(`no interface ${name} in the source`)
  const open = source.indexOf('{', at)
  return { open: open + 1, close: matchBrace(source, open) }
}

/**
 * The field names of a flat `interface` — `Agent`, `MemoryEntry`,
 * `SessionStateView`, `NexusConfigLoadInfo`.
 */
export function interfaceFieldNames(source: string, name: string): string[] {
  const blanked = blankNonCode(source)
  const { open, close } = interfaceBody(blanked, name)
  return topLevelDeclaredNames(blanked.slice(open, close))
}

/**
 * The field names of an object type spelled out INLINE, reached by a field path.
 *
 * `interface OrchestratorState` declares its agents, tasks, config, budget and
 * selfHealing shapes in place rather than naming them, so there is no second
 * interface to read and the keys have to come out of the declaration. The
 * opener is inferred rather than passed: after `name:` it takes the first `{` at
 * depth 0, which is the element type for both `name: { … }` and
 * `name: Array<{ … }>` — which is what lets `['config', 'budget']` and
 * `['agents']` be the same call.
 */
export function inlineFieldNames(
  source: string,
  interfaceName: string,
  path: readonly string[],
): string[] {
  const blanked = blankNonCode(source)
  const { open: rootOpen, close: rootClose } = interfaceBody(blanked, interfaceName)
  let open = rootOpen
  let close = rootClose
  for (const segment of path) {
    const region = blanked.slice(open, close)
    const found = new RegExp(`^\\s*${segment}\\s*\\??\\s*:`, 'm').exec(region)
    if (found === null) {
      throw new Error(`interface ${interfaceName} has no field ${path.join('.')}`)
    }
    const braceAt = region.indexOf('{', found.index + found[0].length - 1)
    if (braceAt === -1) throw new Error(`${path.join('.')} is not an object type`)
    // `open`/`close` always describe the text INSIDE a brace pair, so the body
    // handed to the line scan starts at depth 0. Keeping that invariant is what
    // stops the scan from seeing a body permanently nested one level in — where
    // it finds no top-level declaration in it and reports an empty field list
    // rather than failing.
    open = open + braceAt + 1
    close = matchBrace(blanked, open - 1)
  }
  return topLevelDeclaredNames(blanked.slice(open, close))
}

/** What `this.emit('<event>', …)` passes: an inline literal, or a name. */
export type EmitPayload =
  | { readonly kind: 'literal'; readonly fields: readonly string[] }
  | { readonly kind: 'identifier'; readonly name: string }

/**
 * Every payload an event is emitted with, across all its emit sites.
 *
 * An array rather than one shape because an event can be emitted from several
 * places with different fields — `cost:delta` has three emit sites and the
 * abandoned one carries an extra `uncollected` — and the enumeration has to be
 * the UNION, because the page has to cope with whichever one it is handed.
 *
 * Driven off the quoted event name, so an event added to `BROADCAST_EVENTS` and
 * emitted inline is picked up with no edit here. An event emitted as a bare
 * identifier comes back as `kind: 'identifier'`, which is the signal that its
 * shape has to be declared by hand in the test.
 */
export function emitPayloads(source: string, event: string): EmitPayload[] {
  // Comments blanked, strings KEPT: the quoted event name is the thing being
  // searched for. Offsets are then read from a fully blanked copy.
  const searchable = blankNonCode(source, false)
  const code = blankNonCode(source)
  const found: EmitPayload[] = []
  const needle = new RegExp(`this\\.emit\\('${event}',\\s*`, 'g')
  let match = needle.exec(searchable)
  while (match !== null) {
    const at = match.index + match[0].length
    if (code[at] === '{') {
      const close = matchBrace(code, at)
      found.push({ kind: 'literal', fields: topLevelDeclaredNames(code.slice(at + 1, close)) })
    } else {
      const name = /^[A-Za-z_$][\w$]*/.exec(code.slice(at))
      if (name === null) throw new Error(`cannot read the payload of this.emit('${event}', …)`)
      found.push({ kind: 'identifier', name: name[0] })
    }
    match = needle.exec(searchable)
  }
  return found
}

