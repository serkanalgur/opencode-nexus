/**
 * The fullscreen configuration panel's decision logic.
 *
 * ── WHY THIS IS A SEPARATE FILE, AND WHY IT IS ALL PURE ──
 *
 * The panel this file describes is the first thing in this plugin that has to be
 * correct about KEYS rather than about text. A wizard of `dialog.select` calls
 * could only ever be wrong in ways a reader could see; a list of checkboxes that
 * one of them cannot reach is wrong in a way nothing reports, because the
 * unreachable row still renders, still reads correctly, and still passes a test
 * that asserts on the rendered frame. There is no TUI harness in this repository
 * to catch that (see the note on testing at the bottom of this file), so the
 * only place the guarantee can come from is a reducer that takes a key and a
 * state and returns a state, which a test can drive directly.
 *
 * So: no JSX, no host imports, no I/O. `src/tui.tsx` is the adapter that owns
 * the renderer, the keymap layer and the dialogs; everything that DECIDES
 * anything is here, exported, and testable with no terminal.
 *
 * ── BLOCKS ARE DISCOVERED, NOT LISTED ──
 *
 * `discoverPanel` walks the config object's own keys and each value's own shape.
 * It does not contain the words `budget`, `gitFlow` or `effort`. That is the
 * whole reason a block added to `NexusFullConfig` by somebody else shows up here
 * without a second edit — and the reason it is safe is in the three properties
 * below, which together mean a new block cannot be silently dropped, which is
 * the failure this file exists to make impossible:
 *
 *   1. TOTALITY OF THE KEY ENUMERATION. Blocks are `Object.keys(config)`, so a
 *      block that exists in the config cannot be absent from the panel. There is
 *      no allowlist to fall out of date.
 *   2. TOTALITY OF THE VALUE WALK. Every leaf is visited by `walkPanel`, and the
 *      walk is total: every JS value maps to exactly one row kind. A key whose
 *      value is something this file has no widget for still gets a row — an
 *      `opaque` one — rather than being skipped.
 *   3. NOTHING IS HIDDEN. An `opaque` row is rendered AND reported through
 *      `discovery.readonlyRows` with the reason it cannot be edited, and
 *      `test/tui-config-panel.test.ts` asserts the real config produces zero of
 *      them. So a new key of a shape nobody anticipated fails the suite instead
 *      of arriving in the panel as a value with no way to change it.
 *
 * The OTHER half of the honesty requirement — that a shown control actually
 * DOES something — is not this file's to prove. It is `test/config-knobs.test.ts`
 * and the `resolveGitFlow` gate: a checkbox here is a promise that some code
 * reads the key, and that is checked where the reading happens.
 */

// ── Shapes ──────────────────────────────────────────────────────────

import type { NexusFullConfig } from "./config"

/** Which file a save writes to. Chosen in the panel, honoured by the adapter. */
export type PanelScope = 'project' | 'global'

/** One step of a path into the config: a key, or an index into an array. */
export type PanelPathSegment = string | number

/**
 * The widget a row gets, chosen from the VALUE's type and never from its name.
 *
 * `model` is the one kind that is not purely structural: a string containing a
 * `/` opens the grouped provider picker instead of a free-text field. That is
 * the same rule `getModelForRole` uses when it warns about a missing provider
 * prefix, so the two agree on what a model reference looks like, and a value
 * without a slash degrades to a text field rather than being rejected.
 */
export type PanelFieldKind = 'boolean' | 'number' | 'text' | 'model' | 'list' | 'opaque'

/** One addressable line in the panel. */
export interface PanelRow {
  /** Where this value lives, from the config's own root. */
  readonly path: readonly PanelPathSegment[]
  /** The top-level config key this row belongs to — the block heading. */
  readonly block: string
  /** How the row is labelled, e.g. `maxTotalCost` or `customRoles[0].name`. */
  readonly label: string
  readonly kind: PanelFieldKind
  /** Whether pressing return on this row opens an editor. */
  readonly editable: boolean
  /**
   * Whether return on this row MOVES rather than edits. True for an array
   * header, whose children are ordinary rows: one `return` drops the cursor onto
   * `customRoles[0]`, and the rest of that array is then navigated and edited
   * like any other value, with no array-specific code anywhere.
   */
  readonly navigable: boolean
}

/** A top-level config key and the rows under it. */
export interface PanelBlock {
  readonly name: string
  readonly rows: readonly PanelRow[]
}

/** A row the panel shows but will not let you change, and why. */
export interface PanelReadonlyRow {
  readonly label: string
  readonly reason: string
}

export interface PanelDiscovery {
  readonly blocks: readonly PanelBlock[]
  /** Every row, blocks flattened, in the order the panel walks them. */
  readonly rows: readonly PanelRow[]
  /** Rows that cannot be edited. Empty for every block shipped today. */
  readonly readonlyRows: readonly PanelReadonlyRow[]
}

/**
 * The panel's working copy of the config.
 *
 * `Record<string, unknown>` rather than `NexusFullConfig` because a write has
 * to be made at a path that is only known at RUNTIME, and `NexusFullConfig`'s
 * nested blocks are fixed-shape interfaces that a runtime path-walk cannot
 * satisfy without `any` or a lie. Everything crossing this boundary is checked
 * in one place instead: `createPanelState` takes a real `NexusFullConfig` and
 * `panelSaveUpdate` returns a real `Partial<NexusFullConfig>`, so the two casts
 * that convert between the two live in the two functions that bracket the panel,
 * and `src/tui.tsx` needs no cast at all to use either.
 */
export type PanelDraft = Record<string, unknown>

/** What the panel is doing, which is what decides which keys mean what. */
export type PanelMode =
  /** Walking rows. */
  | 'browse'
  /** A text or number cell is open for editing. */
  | 'edit'
  /** Escape was pressed with unsaved edits; the panel is asking. */
  | 'discard'

export interface PanelState {
  readonly scope: PanelScope
  /** The config as it was when the panel opened — what `revert` restores. */
  readonly base: PanelDraft
  /** The working copy. What `save` writes. */
  readonly draft: PanelDraft
  /** Index into `discoverPanel(config).rows`. */
  readonly cursor: number
  readonly mode: PanelMode
  /** The text in the cell being edited. */
  readonly buffer: string
  /** Set when a commit was REJECTED. Rendered, and never cleared silently. */
  readonly error: string | undefined
  /** A transient, non-blocking message. Cleared by the next accepted action. */
  readonly notice: string | undefined
  readonly closed: boolean
}

/**
 * A key, normalised.
 *
 * Not `KeyEvent`: this is the three fields the panel actually branches on, so a
 * test can write `{ name: 'down' }` and an adapter can map a host event onto it
 * with `panelKeyFrom`. Key names are the host's own — verified against
 * `@opentui/core`'s `parseKeypress`, where `'\r'` is `return`, `'\x1b'` is
 * `escape`, `' '` is `space`, `'\t'` is `tab`, `'\x7f'` is `backspace`, `'G'`
 * is `name: 'g'` with `shift: true` (so a `G` binding cannot be told from a `g`
 * one without the flag), and `ctrl+s` is `name: 's'` with `ctrl: true`.
 */
export interface PanelKey {
  readonly name: string
  readonly ctrl: boolean
  readonly shift: boolean
}

/**
 * Something the panel's pure logic wants the HOST to do.
 *
 * The reducer cannot open a dialog, write a file or close a panel, so it returns
 * an intent and `src/tui.tsx` carries it out. This is what keeps every decision
 * testable: the reducer's whole output is a state plus at most one effect, and
 * both are plain data.
 */
export type PanelEffect =
  /** Open the grouped model picker for the row at this path. */
  | { readonly kind: 'pick-model'; readonly path: readonly PanelPathSegment[]; readonly current: string; readonly title: string }
  /** Write the draft to the config manager and persist it at `state.scope`. */
  | { readonly kind: 'save' }
  /** Leave the panel. `discarded` says whether edits were thrown away. */
  | { readonly kind: 'close'; readonly discarded: boolean }

export interface PanelOutcome {
  readonly state: PanelState
  readonly effect?: PanelEffect
}

// ── Discovery ───────────────────────────────────────────────────────

/** A value whose own properties are config keys, as opposed to a leaf. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * A model reference, by the same rule `getModelForRole` applies: a `provider/id`
 * pair. See `PanelFieldKind` for why the panel uses it to pick a widget.
 */
function looksLikeModelRef(value: string): boolean {
  return value.includes('/') && value.indexOf('/') > 0 && value.length > 1
}

const OPAQUE_REASON =
  'no editor for a value of this type — shown so it cannot go missing, not editable here'

/**
 * Walk one value, appending a row for every leaf.
 *
 * TOTAL, which is the property the whole discovery story rests on: `boolean`,
 * `number` and `string` are leaves; an array is a `list` header plus a
 * recursive walk of its elements; a plain object is walked property by
 * property; and anything else — `null`, `undefined`, a `Date`, a function — is
 * an `opaque` row. There is no branch that appends nothing, so there is no key
 * this can swallow.
 *
 * The `label` is the last path segment spelled out, so a nested row is
 * identifiable in a test failure without reconstructing its whole path.
 */
function walkPanel(
  value: unknown,
  path: readonly PanelPathSegment[],
  label: string,
  rows: PanelRow[]
): void {
  const base = { path, block: String(path[0] ?? ''), label }
  if (typeof value === 'boolean') {
    rows.push({ ...base, kind: 'boolean', editable: true, navigable: false })
    return
  }
  if (typeof value === 'number') {
    rows.push({ ...base, kind: 'number', editable: true, navigable: false })
    return
  }
  if (typeof value === 'string') {
    const kind: PanelFieldKind = looksLikeModelRef(value) ? 'model' : 'text'
    rows.push({ ...base, kind, editable: true, navigable: false })
    return
  }
  if (Array.isArray(value)) {
    // The header is a cursor stop that expands into the elements' own rows, so
    // an array is navigable without this file knowing anything about arrays.
    rows.push({ ...base, kind: 'list', editable: false, navigable: true })
    value.forEach((element, index) => {
      walkPanel(element, [...path, index], `${label}[${index}]`, rows)
    })
    return
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      walkPanel(child, [...path, key], key, rows)
    }
    return
  }
  rows.push({ ...base, kind: 'opaque', editable: false, navigable: false })
}

/**
 * Every block, row and non-editable row in `config`.
 *
 * Blocks are `Object.keys(config)` grouped by each row's first path segment, so
 * the heading order is the config's own key order and a block added to
 * `NexusFullConfig` appears with no edit here. See the note at the top of this
 * file for why that is safe rather than merely convenient.
 */
export function discoverPanel(config: PanelDraft): PanelDiscovery {
  const rows: PanelRow[] = []
  for (const [key, value] of Object.entries(config)) {
    walkPanel(value, [key], key, rows)
  }

  const names = Object.keys(config)
  const blocks: PanelBlock[] = names.map(name => ({
    name,
    rows: rows.filter(row => row.block === name)
  }))

  const readonlyRows: PanelReadonlyRow[] = []
  for (const row of rows) {
    if (row.editable) continue
    readonlyRows.push({
      label: row.label,
      reason: row.kind === 'list' ? 'array header — return opens its entries' : OPAQUE_REASON
    })
  }

  return { blocks, rows, readonlyRows }
}

/** The row list alone, for callers that do not need the block grouping. */
export function panelRows(config: PanelDraft): readonly PanelRow[] {
  return discoverPanel(config).rows
}

/**
 * A path as the config file spells it: `gitFlow.enabled`, `customRoles[0].name`.
 *
 * Needed because `PanelRow.label` is NOT unique and cannot be treated as an
 * address. Five separate blocks each have a field called `enabled` — and the
 * parallel effort change added a sixth — so "the row labelled `enabled`" names
 * five different settings. Anything that needs to identify a row to a human
 * (a notice, a test, an error) uses the path; only the panel's own left-hand
 * column uses the short label, where the block heading above it supplies the
 * missing context.
 */
export function panelPathLabel(path: readonly PanelPathSegment[]): string {
  let out = ''
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`
    else out += out === '' ? segment : `.${segment}`
  }
  return out
}

// ── Reading and writing values ──────────────────────────────────────

/** The value at `path`, or `undefined` if the path does not resolve. */
export function panelValueAt(config: PanelDraft, path: readonly PanelPathSegment[]): unknown {
  let cursor: unknown = config
  for (const segment of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<PanelPathSegment, unknown>)[segment]
  }
  return cursor
}

/**
 * A copy of `config` with `path` set to `value`.
 *
 * Copies each container along the path and shares everything off it, so the
 * caller's config is not mutated and a discarded draft cannot have leaked into
 * the live one. A path that does not resolve returns the config UNCHANGED
 * rather than inventing the containers: a row and its path are both produced by
 * `discoverPanel`, so an unresolvable path means the two disagree, and quietly
 * growing an object to paper over that would hide it.
 */
export function setPanelValue(
  config: PanelDraft,
  path: readonly PanelPathSegment[],
  value: unknown
): PanelDraft {
  if (path.length === 0) return config
  const [head, ...rest] = path as [PanelPathSegment, ...PanelPathSegment[]]
  const container = config[head]
  if (rest.length === 0) return { ...config, [head]: value }
  if (Array.isArray(container)) {
    const index = rest[0]
    // `Number.isInteger` and not just `typeof === 'number'`: the walker only ever
    // emits a whole-number index, so a fractional or string one is a path that
    // disagrees with it, and guessing where it meant to land is how a field ends
    // up written somewhere the user did not ask for.
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= container.length) {
      return config
    }
    const next = container.slice()
    if (rest.length === 1) {
      next[index] = value
      return { ...config, [head]: next }
    }
    // Recurse into the ELEMENT, not into a spread of the array. Spreading an
    // array into an object literal copies every element in as a numeric key, so
    // `customRoles[1].name` would come back as an object holding the whole
    // array under `0`, `1`, … — the write would read back correctly and the
    // element's other fields would be gone. An element that is not a plain
    // object has no fields to address, so the path does not resolve.
    const element = next[index]
    if (!isPlainObject(element)) return config
    next[index] = setPanelValue(element, rest.slice(1), value)
    return { ...config, [head]: next }
  }
  if (isPlainObject(container)) {
    return { ...config, [head]: setPanelValue(container, rest, value) }
  }
  return config
}

/**
 * Structural equality, so `dirty` does not depend on key ORDER.
 *
 * `JSON.stringify` would be shorter and would be wrong: two configs can be equal
 * with their keys inserted in a different order, and a `dirty` flag that
 * flickers on a reorder is a flag the user learns to ignore.
 */
function panelSameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((element, index) => panelSameValue(element, b[index]))
  }
  if (typeof a === 'object') {
    const left = a as Record<string, unknown>
    const right = b as Record<string, unknown>
    const leftKeys = Object.keys(left)
    if (leftKeys.length !== Object.keys(right).length) return false
    return leftKeys.every(
      key => Object.hasOwn(right, key) && panelSameValue(left[key], right[key])
    )
  }
  return false
}

/** Whether the draft differs from the config the panel opened with. */
export function panelIsDirty(state: PanelState): boolean {
  return !panelSameValue(state.base, state.draft)
}

// ── Number cells ────────────────────────────────────────────────────

export type PanelNumberResult =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly message: string }

/**
 * A number cell's text, or the reason it is not a number.
 *
 * The old `handleConfigDialog` prompt parsed with `parseFloat` and, on `NaN`,
 * fell through and reported NOTHING: the dialog closed, the value was
 * unchanged, and the only evidence was that nothing had happened. A user who
 * typed `abc` and pressed return had no way to tell a rejected value from a
 * keyboard that missed. This returns a message instead, `applyPanelKey` puts it
 * in `state.error`, the panel renders it in place, and the cell stays open so
 * the value can be corrected — a rejection that is silent is a rejection the
 * user will repeat.
 *
 * Rejects, deliberately: empty text, anything that is not a finite number
 * (`parseFloat`'s trailing-garbage behaviour means `parseFloat("12abc")` is 12,
 * which is a different number from the one typed), and negatives — every
 * numeric key in the config today is a cost, a retry count, a delay in ms, a
 * threshold or a port, none of which is negative.
 */
export function parsePanelNumber(text: string): PanelNumberResult {
  const trimmed = text.trim()
  if (trimmed === '') return { ok: false, message: 'Enter a number.' }
  // `Number` and not `parseFloat`: `Number` rejects trailing garbage outright,
  // so what is committed is the whole of what was typed or none of it.
  const value = Number(trimmed)
  if (!Number.isFinite(value)) {
    return { ok: false, message: `"${trimmed}" is not a number.` }
  }
  if (value < 0) return { ok: false, message: 'Enter zero or a positive number.' }
  return { ok: true, value }
}

// ── State ───────────────────────────────────────────────────────────

/**
 * A fresh panel state over `config`.
 *
 * The one cast in this file's read path: `NexusFullConfig` is a fixed-shape
 * interface and the panel's walker addresses values by runtime path, so the two
 * representations are bridged here — at the boundary — rather than throughout
 * the logic that needs the loose one. Nothing about the config is trusted: the
 * walk below is total, and an unexpected shape becomes an `opaque` row that is
 * both rendered and reported.
 */
export function createPanelState(
  config: NexusFullConfig,
  scope: PanelScope,
  options: { readonly closed?: boolean } = {}
): PanelState {
  // Through `unknown`, deliberately and visibly. `NexusFullConfig` declares no
  // index signature, so the widening a runtime path-walk needs is not a cast
  // TypeScript will make on its own — and the two-step form is the honest one
  // here: it says "the static shape is being erased on purpose", rather than
  // dressing a compile error up as a conversion. Nothing is lost, because
  // `discoverPanel` reads the value back out of this same object and reports
  // anything it cannot type.
  const draft = config as unknown as PanelDraft
  return {
    scope,
    base: draft,
    draft,
    cursor: 0,
    mode: 'browse',
    buffer: '',
    error: undefined,
    notice: undefined,
    closed: options.closed ?? false
  }
}

/** The rows the state is navigating, derived from the config it opened with. */
export function stateRows(state: PanelState): readonly PanelRow[] {
  return panelRows(state.base)
}

/** The row under the cursor, or `undefined` when there are no rows at all. */
export function currentRow(state: PanelState): PanelRow | undefined {
  return stateRows(state)[state.cursor]
}

/** The value under the cursor. */
export function currentValue(state: PanelState): unknown {
  const row = currentRow(state)
  return row === undefined ? undefined : panelValueAt(state.draft, row.path)
}

/**
 * What `save` hands the config manager.
 *
 * The WHOLE draft, not the changed paths, and that is load-bearing rather than
 * lazy. `updateStorageConfig` REPLACES the blocks it names with freshly built
 * literals, and for `selfHealing` it falls back to `DEFAULT_CONFIG` for three of
 * its four fields rather than to the project/global levels — so a call that
 * mentioned only `budget` would pin the backoff base and the two toggles to
 * their defaults and shadow the user's `nexus.jsonc`. Sending the whole merged
 * draft means every block arrives with the value `getConfig()` already resolved
 * for it, which is what makes the save a no-op for every key the user did not
 * touch.
 */
export function panelSaveUpdate(state: PanelState): Partial<NexusFullConfig> {
  return state.draft as Partial<NexusFullConfig>
}

// ── Scrolling ───────────────────────────────────────────────────────

/**
 * The slice of rows to render, as `[start, end)`.
 *
 * The panel scrolls ITSELF instead of putting the list in the host's
 * `scrollbox`, and that is a deliberate trade. A host scroll container takes the
 * viewport out of the plugin's hands, so "is this row on screen when the cursor
 * is on it" is no longer a question this repository's tests can ask — and that
 * question is the one a keyboard-only user actually needs answered, because a
 * control below the fold that no key scrolls to is a control that does not
 * exist. Owning the window makes it a pure function of
 * `(cursor, total, height)`, so the guarantee is testable.
 *
 * STICKY, not centred: `previousStart` is honoured unless the cursor has left
 * the window, so ordinary movement does not make the list jump under the cursor.
 *
 * The final re-clamp of `start` is a NORMALISATION, not a second bound, and it
 * was previously described here as "load-bearing" — which it is not, and saying
 * so was a lie a future maintainer would act on. Deleting it leaves the suite
 * green: the two lines above it have already moved `start` into `[0, limit]`
 * from any input, because `previousStart` is clamped into range on the way in
 * and the cursor adjustment can only move it further toward the cursor, which
 * `clampCursor` has already bounded. It is kept for one reason: it makes the
 * postcondition a property of the RETURN rather than of the sequence that
 * produced it, so a future change to the sticky logic cannot quietly break the
 * invariant this function exists to hold. Cheap, total, and honest about being
 * redundant — which is a better reason than a false one about being necessary.
 */
export function panelWindow(
  cursor: number,
  total: number,
  height: number,
  previousStart = 0
): { readonly start: number; readonly end: number } {
  if (total <= 0) return { start: 0, end: 0 }
  const size = Math.max(1, Math.min(Math.floor(height), total))
  const limit = total - size
  let start = Math.min(Math.max(Math.floor(previousStart), 0), limit)
  if (cursor < start) start = cursor
  else if (cursor >= start + size) start = cursor - size + 1
  start = Math.min(Math.max(start, 0), limit)
  return { start, end: start + size }
}

// ── The reducer ─────────────────────────────────────────────────────

/** Clamp `index` into `[0, total)`, or 0 when there is nothing to point at. */
function clampCursor(index: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(Math.max(index, 0), total - 1)
}

/** A state with the same shape and the given overrides. */
function withPanel(state: PanelState, patch: Partial<PanelState>): PanelState {
  return { ...state, ...patch }
}

/**
 * Accept a key. Returns the next state and, occasionally, an effect for the
 * host to carry out.
 *
 * EVERY key the panel binds goes through here, and the keymap in `src/tui.tsx`
 * is generated from the same table, so a binding the tests exercise and a
 * binding a user can press are the same list. Keys with no meaning in the
 * current mode fall through to `state` UNCHANGED rather than doing something
 * approximate — which is why `j` does not move the cursor while a cell is open
 * for editing, and why `s` does not save from the discard prompt.
 */
export function applyPanelKey(state: PanelState, key: PanelKey): PanelOutcome {
  if (state.closed) return { state }
  switch (state.mode) {
    case 'edit':
      return applyEditKey(state, key)
    case 'discard':
      return applyDiscardKey(state, key)
    case 'browse':
      return applyBrowseKey(state, key)
  }
}

function applyDiscardKey(state: PanelState, key: PanelKey): PanelOutcome {
  // Only these two mean anything, and the prompt renders both of them. Anything
  // else is ignored rather than guessed at — a stray `s` must not save a config
  // the user was about to throw away.
  if (key.name === 'y' && !key.ctrl) {
    return { state: withPanel(state, { closed: true, mode: 'browse' }), effect: { kind: 'close', discarded: true } }
  }
  if (key.name === 'n' && !key.ctrl || key.name === 'escape') {
    return { state: withPanel(state, { mode: 'browse', notice: 'Kept your changes. Nothing was written.' }) }
  }
  return { state }
}

function applyEditKey(state: PanelState, key: PanelKey): PanelOutcome {
  // Character entry is the host `<input>`'s job — see `src/tui.tsx`. Only the
  // two decisions belong here, and every other key is inert so that navigation
  // letters cannot move the cursor out from under an open cell.
  if (key.name === 'escape') {
    return { state: withPanel(state, { mode: 'browse', buffer: '', error: undefined, notice: 'Edit cancelled.' }) }
  }
  if (key.name !== 'return') return { state }

  const row = currentRow(state)
  if (row === undefined) return { state: withPanel(state, { mode: 'browse' }) }

  if (row.kind === 'number') {
    const parsed = parsePanelNumber(state.buffer)
    if (!parsed.ok) {
      // Stay in the cell, with the reason on screen and the text still there to
      // correct. Closing here is what the old prompt effectively did.
      return { state: withPanel(state, { error: parsed.message, notice: undefined }) }
    }
    return {
      state: withPanel(state, {
        draft: setPanelValue(state.draft, row.path, parsed.value),
        mode: 'browse',
        buffer: '',
        error: undefined,
        notice: `${panelPathLabel(row.path)} = ${parsed.value}`
      })
    }
  }

  if (row.kind === 'text' || row.kind === 'model') {
    const value = state.buffer
    return {
      state: withPanel(state, {
        draft: setPanelValue(state.draft, row.path, value),
        mode: 'browse',
        buffer: '',
        error: undefined,
        notice: value === '' ? `${panelPathLabel(row.path)} cleared` : `${panelPathLabel(row.path)} = ${value}`
      })
    }
  }

  return { state }
}

function applyBrowseKey(state: PanelState, key: PanelKey): PanelOutcome {
  const rows = stateRows(state)
  const total = rows.length
  const move = (delta: number): PanelOutcome => ({
    state: withPanel(state, { cursor: clampCursor(state.cursor + delta, total), error: undefined, notice: undefined })
  })

  switch (key.name) {
    case 'up':
    case 'k':
      if (key.ctrl) return { state }
      return move(-1)
    case 'down':
    case 'j':
      if (key.ctrl) return { state }
      return move(1)
    case 'home':
      return { state: withPanel(state, { cursor: 0, error: undefined, notice: undefined }) }
    case 'end':
      return {
        state: withPanel(state, { cursor: clampCursor(total - 1, total), error: undefined, notice: undefined })
      }
  }

  // `g`/`G` TOGETHER, and after the switch rather than in it: `G` arrives as
  // `name: 'g'` with `shift: true`, because `@opentui/core`'s `parseKeypress`
  // lowercases the name and reports the modifier separately. A `case 'g'`
  // alongside `home` would therefore answer "first row" for `G` as well, and
  // `end` would be a binding with no key behind it.
  if (key.name === 'g' && !key.ctrl) {
    const cursor = key.shift ? clampCursor(total - 1, total) : 0
    return { state: withPanel(state, { cursor, error: undefined, notice: undefined }) }
  }

  // Return and space both toggle a boolean. Space on a non-boolean does
  // nothing: silently treating it as "move down" would make a checkbox feel
  // like it had been switched off.
  if (key.name === 'return' || key.name === 'space') {
    const row = currentRow(state)
    if (row === undefined) return { state }
    if (row.kind === 'boolean') {
      const next = !panelValueAt(state.draft, row.path)
      return {
        state: withPanel(state, {
          draft: setPanelValue(state.draft, row.path, next),
          error: undefined,
          notice: `${panelPathLabel(row.path)} = ${next}`
        })
      }
    }
    if (row.navigable) {
      // An array header: step onto its first element if it has one. An empty
      // array has no row to move to, so the notice says so rather than the key
      // appearing to do nothing at all.
      const first = total > 0 ? rows.findIndex((candidate, index) => index > state.cursor && isChild(candidate, row.path)) : -1
      if (first !== -1) return { state: withPanel(state, { cursor: first, error: undefined, notice: undefined }) }
      return { state: withPanel(state, { notice: `${panelPathLabel(row.path)} is empty — nothing to edit.` }) }
    }
    if (!row.editable) {
      return { state: withPanel(state, { notice: `${panelPathLabel(row.path)} is not editable here.` }) }
    }
    if (row.kind === 'model') {
      return {
        state,
        effect: {
          kind: 'pick-model',
          path: row.path,
          current: String(currentValue(state) ?? ''),
          // The full path, not the short label: the picker is a separate modal
          // with the panel's block headings out of sight, so a title of `enabled`
          // would name a setting the user cannot place.
          title: panelPathLabel(row.path)
        }
      }
    }
    return {
      state: withPanel(state, {
        mode: 'edit',
        buffer: String(currentValue(state) ?? ''),
        error: undefined,
        notice: undefined
      })
    }
  }

  if (key.name === 'tab' && !key.ctrl) {
    return {
      state: withPanel(state, {
        scope: state.scope === 'project' ? 'global' : 'project',
        error: undefined,
        notice: `Saving to ${state.scope === 'project' ? 'global' : 'project'} — nothing is written until you save.`
      })
    }
  }

  if (key.name === 'escape') {
    // Escape NEVER discards silently. With edits pending it opens a prompt that
    // names both answers; with none there is nothing to lose, so it closes.
    if (panelIsDirty(state)) return { state: withPanel(state, { mode: 'discard', error: undefined }) }
    return { state: withPanel(state, { closed: true }), effect: { kind: 'close', discarded: false } }
  }

  if (key.name === 'r' && !key.ctrl) {
    return {
      state: withPanel(state, {
        draft: state.base,
        mode: 'browse',
        buffer: '',
        error: undefined,
        notice: panelIsDirty(state) ? 'Reverted every change in this panel.' : 'Nothing to revert.'
      })
    }
  }

  // `ctrl+s` and a bare `s` both save, because a terminal user expects the
  // former and the panel's own footer advertises the latter.
  if (key.name === 's' && !key.shift) {
    if (state.mode === 'edit') return { state }
    return { state: withPanel(state, { error: undefined }), effect: { kind: 'save' } }
  }

  return { state }
}

/** Whether `candidate` is a strict descendant of `ancestor`. */
function isChild(candidate: PanelRow, ancestor: readonly PanelPathSegment[]): boolean {
  if (candidate.path.length <= ancestor.length) return false
  return ancestor.every((segment, index) => candidate.path[index] === segment)
}

/**
 * Apply a model the picker returned.
 *
 * Separate from `applyPanelKey` because the picker is a host dialog whose result
 * arrives out of band: the reducer never sees the key that produced it, so a
 * caller that folded this into the key handler would have a path no key reaches.
 * `""` is the picker's reset value and is stored as written — the same value
 * `handleModelSelect` has always passed to `setModel`, and the same one
 * `getModelForRole` treats as "use the default".
 */
export function applyPanelChoice(state: PanelState, path: readonly PanelPathSegment[], value: string): PanelState {
  return withPanel(state, {
    draft: setPanelValue(state.draft, path, value),
    mode: 'browse',
    buffer: '',
    error: undefined,
    notice: value === '' ? 'Reset to the default model.' : `Model set to ${value}.`
  })
}

/** Record a message from the host — a failed save, a picker that could not open. */
export function panelNotice(state: PanelState, notice: string): PanelState {
  return withPanel(state, { notice })
}

// ── Bindings ────────────────────────────────────────────────────────

/**
 * One thing the user can press.
 *
 * `bind` is the host's own binding string, passed straight to
 * `keymap.layer({ commands: [{ bind }] })`; `key` is what the reducer sees. Both
 * are stated here rather than parsed from one another because a parser is a
 * second place for the two to disagree — and `G` is exactly the case that would
 * disagree, arriving as `name: 'g', shift: true`.
 */
export interface PanelBinding {
  readonly id: string
  /** The string given to the host keymap layer. */
  readonly bind: string
  /** The key as `applyPanelKey` receives it. */
  readonly key: PanelKey
  /** Shown in the host's keyboard-help UI. */
  readonly title: string
  /**
   * The modes this binding is LIVE in, and the host registers one keymap layer
   * per mode out of this table rather than retyping the split.
   *
   * Navigation, toggling, scope, revert and save are `browse` only, which is
   * load-bearing rather than tidy: they must not be dispatched while a cell is
   * open, or `j` would move the cursor out from under the cell and `s` would
   * save a value the user had not finished typing. The reducer refuses them in
   * `edit` too, but that guard is defence in depth — this is what makes the keys
   * not be delivered.
   *
   * `return` is live in `edit` as well, and it is the ONLY way a cell is
   * committed. The open cell is a host `<input>`, so the characters live in that
   * renderable; `runPanelKey` reads the value off it before handing the key on.
   * There is deliberately no second commit path — no `onSubmit` handler — because
   * two of them race, and the loser lands in `browse` mode and re-opens the cell
   * seeded with the value that was just saved.
   *
   * `escape` is live everywhere, because it means the same thing in all three:
   * leave the cell, answer the prompt, or close.
   */
  readonly modes: readonly PanelMode[]
}

/**
 * The panel's complete keymap.
 *
 * Exported as the single source of truth for THREE consumers, which is the point
 * of it being data rather than a `commands:` array written inline:
 *
 *   - `src/tui.tsx`, which generates the keymap layers from it, so a binding the
 *     tests drive is a binding a user can press;
 *   - the reachability test, which searches the panel's state space using ONLY
 *     these keys — so a row nobody bound is a failing test rather than a control
 *     that silently cannot be reached;
 *   - the footer the panel renders, so what the panel says it responds to and
 *     what it responds to cannot drift apart.
 *
 * `y`/`n` are here although they only mean something in the discard prompt: they
 * are in the table, they are rendered in the prompt, and the reachability search
 * needs no special-casing to try them.
 */
export const PANEL_BINDINGS: readonly PanelBinding[] = [
  { id: 'up', bind: 'up', key: { name: 'up', ctrl: false, shift: false }, title: 'Previous setting', modes: ['browse'] },
  { id: 'down', bind: 'down', key: { name: 'down', ctrl: false, shift: false }, title: 'Next setting', modes: ['browse'] },
  { id: 'first', bind: 'home', key: { name: 'home', ctrl: false, shift: false }, title: 'First setting', modes: ['browse'] },
  { id: 'last', bind: 'end', key: { name: 'end', ctrl: false, shift: false }, title: 'Last setting', modes: ['browse'] },
  { id: 'toggle', bind: 'return', key: { name: 'return', ctrl: false, shift: false }, title: 'Toggle, or edit', modes: ['browse', 'edit'] },
  { id: 'space', bind: 'space', key: { name: 'space', ctrl: false, shift: false }, title: 'Toggle a switch', modes: ['browse'] },
  { id: 'scope', bind: 'tab', key: { name: 'tab', ctrl: false, shift: false }, title: 'Switch project / global', modes: ['browse'] },
  { id: 'cancel', bind: 'escape', key: { name: 'escape', ctrl: false, shift: false }, title: 'Cancel, or close', modes: ['browse', 'edit', 'discard'] },
  { id: 'save', bind: 'ctrl+s', key: { name: 's', ctrl: true, shift: false }, title: 'Save', modes: ['browse'] },
  { id: 'up.vi', bind: 'k', key: { name: 'k', ctrl: false, shift: false }, title: 'Previous setting', modes: ['browse'] },
  { id: 'down.vi', bind: 'j', key: { name: 'j', ctrl: false, shift: false }, title: 'Next setting', modes: ['browse'] },
  { id: 'first.vi', bind: 'g', key: { name: 'g', ctrl: false, shift: false }, title: 'First setting', modes: ['browse'] },
  { id: 'last.vi', bind: 'G', key: { name: 'g', ctrl: false, shift: true }, title: 'Last setting', modes: ['browse'] },
  { id: 'revert', bind: 'r', key: { name: 'r', ctrl: false, shift: false }, title: 'Discard this session’s edits', modes: ['browse'] },
  { id: 'save.vi', bind: 's', key: { name: 's', ctrl: false, shift: false }, title: 'Save', modes: ['browse'] },
  { id: 'discard.yes', bind: 'y', key: { name: 'y', ctrl: false, shift: false }, title: 'Discard and close', modes: ['discard'] },
  { id: 'discard.no', bind: 'n', key: { name: 'n', ctrl: false, shift: false }, title: 'Keep the edits', modes: ['discard'] }
]

/**
 * One promise the panel's footer makes: this key, doing this.
 *
 * A hint here with no binding behind it is a lie told in the one place the user
 * is actually looking, and a binding here with no hint is a control nobody will
 * find. So the footer is RENDERED from this list rather than written out, and a
 * test asserts every hint resolves to a binding that is live in `browse`. The
 * `bind` is the binding's own string, not a spelling of it — that is what makes
 * the check able to fail.
 */
export interface PanelHint {
  readonly bind: string
  readonly label: string
}

/** The hints shown while browsing, in the order they are rendered. */
export const PANEL_FOOTER_HINTS: readonly PanelHint[] = [
  { bind: 'down', label: 'move' },
  { bind: 'j', label: 'move' },
  { bind: 'space', label: 'toggle' },
  { bind: 'return', label: 'edit' },
  { bind: 'tab', label: 'scope' },
  { bind: 's', label: 'save' },
  { bind: 'r', label: 'revert' },
  { bind: 'escape', label: 'close' }
]

// ── The keymap handshake ────────────────────────────────────────────

/**
 * The buffer the reducer should see for one key press.
 *
 * ── WHY THIS IS A FUNCTION AND NOT A LINE IN THE ADAPTER ──
 *
 * In `edit` the characters the user typed live in the host `<input>`, not in the
 * panel state, so `return` has to commit the value the input actually holds. A
 * reducer that received `state.buffer` instead would commit the value the cell
 * was SEEDED with — which typechecks, renders correctly, and silently discards
 * every keystroke. That mutation survived the whole suite before this existed,
 * because the line lived in a closure inside `src/tui.tsx` that no test could
 * reach.
 *
 * The asymmetry is the other half: only `return` reads the input. Every other
 * key in `edit` must NOT, because the input is uncontrolled after mount and
 * re-rendering it from state on each keystroke is a fight over the caret. That
 * is a rule with a failure mode, so it is a rule with a test rather than a
 * comment.
 *
 * `inputValue` is `undefined` when the input is not mounted, and then the seeded
 * buffer stands — a cell that somehow has no input still commits what it was
 * given rather than committing `undefined`.
 */
export function panelKeyBuffer(
  state: PanelState,
  key: PanelKey,
  inputValue: string | undefined
): string {
  return state.mode === 'edit' && key.name === 'return'
    ? (inputValue ?? state.buffer)
    : state.buffer
}

/**
 * The two renderables the keymap layer can target. Generic and opaque on
 * purpose: this file imports nothing from the host, so it cannot know what a
 * `BoxRenderable` is, and typing the fields as `unknown` would force a cast at
 * the call site. The caller supplies whatever its host uses and gets the same
 * object back out of `target()`.
 */
export interface PanelLayerTargets<TRoot, TInput> {
  readonly root: TRoot
  readonly input: TInput
}

/** One command the host keymap should register, as plain data. */
export interface PanelLayerCommand {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly group: string
  readonly bind: string
  readonly run: () => void
}

/** What `src/tui.tsx` hands to `context.keymap.layer`. */
export interface PanelLayerSpec<TRoot, TInput> {
  /**
   * WHICH renderable receives the keys, read fresh on every dispatch.
   *
   * A function rather than a value for the same reason the panel's own `target`
   * is one: the host asks at key-press time, and by then the mode may have
   * changed. Capturing the mode when the spec was built would send `esc` to a
   * renderable that is no longer on screen.
   */
  readonly target: () => TRoot | TInput | null
  readonly priority: number
  readonly enabled: () => boolean
  readonly commands: readonly PanelLayerCommand[]
}

/**
 * Build the panel's keymap layer DESCRIPTOR FACTORY, for `context.keymap.layer`.
 *
 * ── WHY A FACTORY AND NOT A DESCRIPTOR ──
 *
 * The host is handed a function, and the honest thing is to return the same
 * shape: a function from which the host asks for a fresh spec. Two of the three
 * fields are thunks (`target`, `enabled`) because the host reads them at
 * key-dispatch time, long after the spec was built. `commands` cannot be a
 * thunk of that kind — it is an array — and freezing it at build time is a real
 * bug rather than a style choice: the mode the array was filtered by is the
 * mode at BUILD time, so a layer built while browsing and dispatched while a
 * cell is open would offer the browse commands, and `esc` would be missing from
 * the one mode where it is the only way out.
 *
 * Whether the host re-invokes the outer function per dispatch is not something
 * this repository can observe, so the shape does not depend on the answer.
 *
 * ── WHAT THIS MAKES TESTABLE ──
 *
 * Three decisions, all previously inside a closure in `src/tui.tsx` and all
 * invisible to the suite:
 *
 *   1. WHICH renderable is targeted. The root while browsing, the `<input>`
 *      while a cell is open, and `null` while the panel is closed. The middle
 *      one is not cosmetic: a focused `<input>` consumes the whole keyboard, so
 *      targeting the root unconditionally makes `esc` unable to leave a cell —
 *      a cell you can enter and only leave by killing the panel.
 *   2. WHICH commands are live. `PANEL_BINDINGS` FILTERED BY MODE, so the keys
 *      a user can press and the keys the reachability test drives are the same
 *      list by construction rather than two lists kept in step by hand.
 *   3. `enabled`, which is what keeps a closed panel from answering anything at
 *      all.
 *
 * `run` is injected rather than imported so this stays a pure function of its
 * arguments: the tests assert WHICH key reaches the reducer and in which mode,
 * without a reducer, a keymap or a terminal.
 *
 * `getTargets` is a FUNCTION for the same reason `getState` is: `src/tui.tsx`
 * assigns `panelRoot` and `panelInput` from the render's `ref` callbacks, which
 * run after this layer is registered. A plain object would capture both as
 * `undefined` and every key would be dispatched to nothing.
 */
export function panelLayerSpec<TRoot, TInput>(
  getState: () => PanelState,
  getTargets: () => PanelLayerTargets<TRoot | undefined, TInput | undefined>,
  run: (key: PanelKey) => void
): () => PanelLayerSpec<TRoot | undefined, TInput | undefined> {
  return () => {
    const state = getState()
    return {
      // `closed` and `mode` are read BOTH here and inside the thunks below: here
      // to build the command list, there to answer a dispatch that happens after
      // the mode has changed again.
      target: () => {
        const live = getState()
        if (live.closed) return null
        const { root, input } = getTargets()
        return live.mode === 'edit' ? input : root
      },
      priority: 20,
      enabled: () => !getState().closed,
      commands: PANEL_BINDINGS
        .filter(binding => binding.modes.includes(state.mode))
        .map(binding => ({
          id: `nexus.config.panel.${binding.id}`,
          title: binding.title,
          description: `Nexus configuration panel: ${binding.title}`,
          group: 'Nexus configuration',
          bind: binding.bind,
          run: () => { run(binding.key) }
        }))
    }
  }
}
