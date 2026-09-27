/**
 * The configuration dialog flow's decision logic.
 *
 * ── WHY DIALOGS, AND WHY THIS IS A SEPARATE FILE ──
 *
 * The fullscreen panel this replaces was rendered by this plugin over
 * `ui.panel.open(..., { presentation: "fullscreen" })`, with its own checkbox
 * component, its own `session.panel` claim and its own keymap layer. The user
 * asked for the popup mode back, so the route is now the host's: `ui.dialog`
 * only. That route has a much smaller vocabulary — `select` is single-select,
 * `prompt` takes one line of text, and there is no checkbox, no multi-select, no
 * form and no number input — so the interesting question is no longer "does the
 * keyboard reach this row" but "is every setting OFFERED somewhere, and does
 * every escape route lead somewhere real".
 *
 * That is still a decision, and it is still not the adapter's to make: the
 * adapter in `src/tui.tsx` owns the host calls, and everything that DECIDES is
 * here, exported, and testable with no terminal. So: no JSX, no host imports, no
 * I/O.
 *
 * ── THE FLOW IS THREE LEVELS, NOT A MARCH ──
 *
 * The wizard this ultimately replaces asked its questions one dialog at a time:
 * a scope question, then six model questions, then a budget prompt. Adding the
 * blocks' nine switches would have made it about twenty-four sequential
 * questions about a tree of settings, and a linear sequence of questions is the
 * complaint. So the flow is a tree the user descends and climbs:
 *
 *   1. `blocks`  — one row per config block, plus the save scope, plus save and
 *                  close. The hub: nothing is written until `save` is chosen.
 *   2. `fields`  — one row per field of the block you entered, each labelled
 *                  with its CURRENT value, plus a row back to the hub.
 *   3. `editor`  — the widget for one field: a two-row `select` for a boolean, a
 *                  `prompt` for a number or a string, the grouped provider
 *                  picker for a model reference.
 *
 * ESCAPE IS "GO UP ONE LEVEL", EVERYWHERE, AND IT NEVER DISCARDS SILENTLY — the
 * draft lives in memory and nothing has been written, so escaping from an editor
 * returns to the block, escaping from a block returns to the hub, and escaping
 * from the hub leaves with the file untouched. There is no third outcome to
 * forget. `configUp` is the whole of that policy, in one function.
 *
 * ── BLOCKS ARE DISCOVERED, NOT LISTED ──
 *
 * `discoverConfig` walks the config object's own keys and each value's own
 * shape. It does not contain the words `budget`, `gitFlow` or `effort`. That is
 * the whole reason a block added to `NexusFullConfig` by somebody else shows up
 * without a second edit — and the reason it is safe is in the three properties
 * below, which together mean a new block cannot be silently dropped, which is
 * the failure this file exists to make impossible:
 *
 *   1. TOTALITY OF THE KEY ENUMERATION. Blocks are `Object.keys(config)`, so a
 *      block that exists in the config cannot be absent from the flow. There is
 *      no allowlist to fall out of date.
 *   2. TOTALITY OF THE VALUE WALK. Every leaf is visited by `walkConfig`, and
 *      the walk is total: every JS value maps to exactly one field kind. A key
 *      whose value is something this file has no editor for still gets a field
 *      — an `opaque` one — and is offered in its block's list as a `disabled`
 *      row rather than skipped.
 *   3. NOTHING IS HIDDEN. A `disabled` row is a host feature, not a lie: the
 *      host renders it and refuses it, and `discovery.uneditableFields` names
 *      every one of them, and `test/tui-config-flow.test.ts` asserts the real
 *      config produces zero. So a new key of a shape nobody anticipated fails
 *      the suite instead of arriving as a value with no way to change it.
 *
 * The OTHER half of the honesty requirement — that an offered control actually
 * DOES something — is not this file's to prove. It is `test/config-knobs.test.ts`
 * and the `resolveGitFlow` gate: a row here is a promise that some code reads
 * the key, and that is checked where the reading happens.
 */

import type { NexusFullConfig } from "./config"

// ── Shapes ──────────────────────────────────────────────────────────

/** Which file a save writes to. Chosen in the hub, honoured by the adapter. */
export type ConfigScope = 'project' | 'global'

/** One step of a path into the config: a key, or an index into an array. */
export type ConfigPathSegment = string | number

/**
 * The widget a field gets, chosen from the VALUE's type and never from its name.
 *
 * `model` is the one kind that is not purely structural: a string containing a
 * `/` opens the grouped provider picker instead of a free-text field. That is
 * the same rule `getModelForRole` uses when it warns about a missing provider
 * prefix, so the two agree on what a model reference looks like, and a value
 * without a slash degrades to a text field rather than being rejected.
 */
export type ConfigFieldKind = 'boolean' | 'number' | 'text' | 'model' | 'opaque'

/** One addressable value in the config. */
export interface ConfigField {
  /** Where this value lives, from the config's own root. */
  readonly path: readonly ConfigPathSegment[]
  /** The top-level config key this field belongs to — the block it sits in. */
  readonly block: string
  /** How the field is labelled in its block's list, e.g. `maxTotalCost`. */
  readonly label: string
  readonly kind: ConfigFieldKind
}

/** A top-level config key and the fields under it. */
export interface ConfigBlock {
  readonly name: string
  readonly fields: readonly ConfigField[]
}

export interface ConfigDiscovery {
  readonly blocks: readonly ConfigBlock[]
  /** Every field, blocks flattened, in the order the walk visits them. */
  readonly fields: readonly ConfigField[]
  /**
   * Fields the flow offers but will not let you change, by path. Empty for
   * every block shipped today; asserted empty in the test suite.
   */
  readonly uneditableFields: readonly string[]
}

/**
 * The flow's working copy of the config.
 *
 * `Record<string, unknown>` rather than `NexusFullConfig` because a write has
 * to be made at a path that is only known at RUNTIME, and `NexusFullConfig`'s
 * nested blocks are fixed-shape interfaces that a runtime path-walk cannot
 * satisfy without `any` or a lie. Everything crossing this boundary is checked
 * in one place instead: the adapter takes a real `NexusFullConfig` and
 * `configSaveUpdate` returns a real `Partial<NexusFullConfig>`, so the two casts
 * that convert between the two live in the two functions that bracket the flow,
 * and `src/tui.tsx` needs no cast at all to use either.
 */
export type ConfigDraft = Record<string, unknown>

/**
 * Where the flow is.
 *
 * `blocks` is the hub, `fields` is inside one block, and `editor` is the widget
 * for one field. An `editor` is a screen rather than an instant because the
 * question "can the user get out of here" has to be answerable, and it cannot
 * be answered for something that is not a state.
 */
export type ConfigScreen =
  | { readonly kind: 'blocks' }
  | { readonly kind: 'fields'; readonly block: string }
  | { readonly kind: 'editor'; readonly field: ConfigField }

// ── Discovery ───────────────────────────────────────────────────────

/** A value whose own properties are config keys, as opposed to a leaf. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * A model reference, by the same rule `getModelForRole` applies: a `provider/id`
 * pair. See `ConfigFieldKind` for why the flow uses it to pick a widget.
 */
function looksLikeModelRef(value: string): boolean {
  return value.includes('/') && value.indexOf('/') > 0 && value.length > 1
}

/**
 * Walk one value, appending a field for every leaf.
 *
 * TOTAL, which is the property the whole discovery story rests on: `boolean`,
 * `number` and `string` are leaves; an array is walked element by element, each
 * element recursively, and an element's fields are ordinary fields of the same
 * block — so `customRoles` needs no array-specific code anywhere, and
 * `customRoles[0].name` is offered in the `customRoles` block's list exactly
 * like `budget.maxTotalCost`; a plain object is walked property by property;
 * and anything else — `null`, `undefined`, a `Date`, a function — is an `opaque`
 * field. There is no branch that appends nothing, so there is no key this can
 * swallow.
 *
 * The array HEADER is not a field. It is a value, not a setting, and in a dialog
 * there is no cursor to park a header on: the element rows ARE the entries, and
 * the one thing a header would have told a user — that the array is empty — is
 * said by the block's own list (see `fieldOptions`).
 */
function walkConfig(
  value: unknown,
  path: readonly ConfigPathSegment[],
  label: string,
  fields: ConfigField[]
): void {
  const base = { path, block: String(path[0] ?? ''), label }
  if (typeof value === 'boolean') {
    fields.push({ ...base, kind: 'boolean' })
    return
  }
  if (typeof value === 'number') {
    fields.push({ ...base, kind: 'number' })
    return
  }
  if (typeof value === 'string') {
    const kind: ConfigFieldKind = looksLikeModelRef(value) ? 'model' : 'text'
    fields.push({ ...base, kind })
    return
  }
  if (Array.isArray(value)) {
    value.forEach((element, index) => walkConfig(element, [...path, index], `${label}[${index}]`, fields))
    return
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      walkConfig(child, [...path, key], key, fields)
    }
    return
  }
  fields.push({ ...base, kind: 'opaque' })
}

/**
 * Every block and field in `config`.
 *
 * Blocks are `Object.keys(config)` grouped by each field's first path segment, so
 * the hub's order is the config's own key order and a block added to
 * `NexusFullConfig` appears with no edit here. See the note at the top of this
 * file for why that is safe rather than merely convenient.
 */
export function discoverConfig(config: ConfigDraft): ConfigDiscovery {
  const fields: ConfigField[] = []
  for (const [key, value] of Object.entries(config)) {
    walkConfig(value, [key], key, fields)
  }

  const blocks: ConfigBlock[] = Object.keys(config).map(name => ({
    name,
    fields: fields.filter(field => field.block === name)
  }))

  const uneditableFields = fields
    .filter(field => field.kind === 'opaque')
    .map(field => configPathLabel(field.path))

  return { blocks, fields, uneditableFields }
}

/** The field list alone, for callers that do not need the block grouping. */
export function configFields(config: ConfigDraft): readonly ConfigField[] {
  return discoverConfig(config).fields
}

/**
 * A path as the config file spells it: `gitFlow.enabled`,
 * `customRoles[0].name`.
 *
 * Needed because `ConfigField.label` is NOT unique and cannot be treated as an
 * address. Seven separate blocks have a field called `enabled` — and the
 * parallel effort change added an eighth — so "the field labelled `enabled`"
 * names seven different settings. Anything that needs to identify a field to a
 * human (a dialog title, a toast, a test, an error) uses the path; a block's
 * own list uses the short label, where the block's name in the dialog's title
 * supplies the missing context.
 */
export function configPathLabel(path: readonly ConfigPathSegment[]): string {
  let out = ''
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`
    else out += out === '' ? segment : `.${segment}`
  }
  return out
}

// ── Reading and writing values ──────────────────────────────────────

/** The value at `path`, or `undefined` if the path does not resolve. */
export function configValueAt(config: ConfigDraft, path: readonly ConfigPathSegment[]): unknown {
  let cursor: unknown = config
  for (const segment of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<ConfigPathSegment, unknown>)[segment]
  }
  return cursor
}

/**
 * A copy of `config` with `path` set to `value`.
 *
 * Copies each container along the path and shares everything off it, so the
 * caller's config is not mutated and a discarded draft cannot have leaked into
 * the live one. A path that does not resolve returns the config UNCHANGED
 * rather than inventing the containers: a field and its path are both produced
 * by `discoverConfig`, so an unresolvable path means the two disagree, and
 * quietly growing an object to paper over that would hide it.
 */
export function setConfigValue(
  config: ConfigDraft,
  path: readonly ConfigPathSegment[],
  value: unknown
): ConfigDraft {
  if (path.length === 0) return config
  const [head, ...rest] = path as [ConfigPathSegment, ...ConfigPathSegment[]]
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
    next[index] = setConfigValue(element, rest.slice(1), value)
    return { ...config, [head]: next }
  }
  if (isPlainObject(container)) {
    return { ...config, [head]: setConfigValue(container, rest, value) }
  }
  return config
}

/**
 * Structural equality, so "has anything changed" does not depend on key ORDER.
 *
 * `JSON.stringify` would be shorter and would be wrong: two configs can be equal
 * with their keys inserted in a different order, and a dirty flag that flickers
 * on a reorder is a flag the user learns to ignore.
 */
export function configIsDirty(base: ConfigDraft, draft: ConfigDraft): boolean {
  return !configSameValue(base, draft)
}

function configSameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((element, index) => configSameValue(element, b[index]))
  }
  if (typeof a === 'object') {
    const left = a as Record<string, unknown>
    const right = b as Record<string, unknown>
    const leftKeys = Object.keys(left)
    if (leftKeys.length !== Object.keys(right).length) return false
    return leftKeys.every(
      key => Object.hasOwn(right, key) && configSameValue(left[key], right[key])
    )
  }
  return false
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
export function configSaveUpdate(draft: ConfigDraft): Partial<NexusFullConfig> {
  return draft as Partial<NexusFullConfig>
}

// ── Widget choice ───────────────────────────────────────────────────

/**
 * The widget a field opens, or `none` for a value this flow cannot edit.
 *
 * ONE function, so "what happens when I pick this row" is a question with one
 * answer, and the test that every real field has one is an assertion about this
 * rather than about a rendering.
 */
export type ConfigEditor = 'boolean' | 'number' | 'text' | 'model' | 'none'

/** The editor for a field. `opaque` is the only kind with none. */
export function editorFor(field: ConfigField): ConfigEditor {
  return field.kind === 'opaque' ? 'none' : field.kind
}

// ── Number fields ───────────────────────────────────────────────────

export type ConfigNumberResult =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly message: string }

/**
 * A number field's text, or the reason it is not a number.
 *
 * The budget prompt this flow's ancestor used parsed with `parseFloat` and, on
 * `NaN`, fell through and reported NOTHING: the dialog closed, the value was
 * unchanged, and the only evidence was that nothing had happened. A user who
 * typed `abc` and pressed return had no way to tell a rejected value from a
 * keyboard that missed. This returns a message instead, and the adapter shows it
 * — a rejection that is silent is a rejection the user will repeat.
 *
 * Rejects, deliberately: empty text, anything that is not a finite DECIMAL
 * number, and negatives — every numeric key in the config today is a cost, a
 * retry count, a delay in ms, a threshold or a port, none of which is negative.
 *
 * The decimal SHAPE is the check that does the work, and it is worth being exact
 * about which guard rejects what, because the obvious reading of this function
 * is wrong. `Number("12abc")` is `NaN` and `Number("0x10")` is 16: the first
 * would be caught by the `isFinite` check and the second is NOT caught by
 * anything, because `Number` accepts the alternate-radix prefixes. So the shape
 * test is what rejects both `12abc` and `0x10`, and a user who types `0x10`
 * into a port or a cost ceiling would otherwise get 16 written to their file
 * with no complaint — the same defect as `parseFloat("12abc")` being 12,
 * arrived at from the other direction.
 *
 * A CONSEQUENCE WORTH KNOWING BEFORE SIMPLIFYING: because the shape test rejects
 * everything that is not a pure decimal literal, and `Number` and `parseFloat`
 * agree on every string that IS one, swapping `Number` for `parseFloat` here is
 * an EQUIVALENT mutation — it survives the whole suite. That is a property of
 * the pair, not a gap in the tests: there is no input that reaches a parse where
 * the two functions disagree. `Number` is kept because it is the primitive that
 * fails closed on a string it does not understand, so the function does not
 * depend on the shape test being the first line rather than the third.
 */
export function parseConfigNumber(text: string): ConfigNumberResult {
  const trimmed = text.trim()
  if (trimmed === '') return { ok: false, message: 'Enter a number.' }
  const value = Number(trimmed)
  if (!Number.isFinite(value)) {
    return { ok: false, message: `"${trimmed}" is not a number.` }
  }
  // The radix half. A leading sign is allowed so the negativity check below is
  // the thing that rejects it, with its own message; an exponent is allowed
  // because `1e3` is a number a user may reasonably mean.
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) {
    return { ok: false, message: `"${trimmed}" is not a plain decimal number.` }
  }
  if (value < 0) return { ok: false, message: 'Enter zero or a positive number.' }
  return { ok: true, value }
}

// ── Committing a typed value ────────────────────────────────────────

/**
 * The outcome of a `prompt` or a model picker returning.
 *
 * `rejected` is a first-class outcome rather than an exception or a `null`,
 * because the bug it fixes was a rejection with no representation at all: the
 * old budget prompt parsed with `parseFloat`, and on `NaN` fell through to no
 * branch whatsoever, so the dialog closed and nothing said why. A flow whose
 * only way to say "that is not a number" is to return nothing is a flow that
 * cannot say it, and the adapter is obliged by this type to handle the case.
 *
 * `dismissed` is separate because the two are different outcomes: a dismissed
 * picker is the user declining, and declining must not write the empty string
 * that "Use default" would have written.
 */
export type ConfigCommit =
  | { readonly kind: 'accepted'; readonly field: ConfigField; readonly value: unknown }
  | { readonly kind: 'rejected'; readonly field: ConfigField; readonly message: string }
  | { readonly kind: 'dismissed'; readonly field: ConfigField }

/**
 * A `prompt` for `field` returning `text`.
 *
 * A number is parsed and a rejection is a `rejected` commit carrying the reason.
 * A text — including a model reference, when one is typed rather than picked —
 * is taken as written, INCLUDING the empty string, because clearing a setting
 * is a real edit: `models.coder: ""` is what `getModelForRole` reads as "use the
 * default", and the picker's own "Use default" row relies on the same string.
 */
export function commitConfigText(field: ConfigField, text: string): ConfigCommit {
  if (field.kind === 'number') {
    const parsed = parseConfigNumber(text)
    return parsed.ok
      ? { kind: 'accepted', field, value: parsed.value }
      : { kind: 'rejected', field, message: parsed.message }
  }
  return { kind: 'accepted', field, value: text }
}

/**
 * The grouped model picker returning `choice`, or `undefined` for a dismissal.
 *
 * Separate from `commitConfigText` because the picker's result arrives out of
 * band — the user can leave the flow entirely to choose it, and a dismissal
 * means something different from an empty string here. Folding it into
 * `commitConfigText` would make "escaped out of the provider picker" and
 * "chose Use default" the same value, and one of them writes a change the user
 * never made.
 */
export function commitConfigModel(
  field: ConfigField,
  choice: string | undefined
): ConfigCommit {
  if (choice === undefined) return { kind: 'dismissed', field }
  return { kind: 'accepted', field, value: choice }
}

// ── How a row is written ────────────────────────────────────────────

/**
 * A value as a field list should show it.
 *
 * `""` is shown as `(default)` rather than as nothing, because an empty string
 * is a real value here: `models.coder: ""` is what `getModelForRole` reads as
 * "use the default model", and a row whose value cell is blank is
 * indistinguishable from a row the flow failed to fill in. `undefined` — a path
 * that does not resolve, which `setConfigValue` would also have refused — is
 * `(unset)` for the same reason.
 *
 * A block with no fields at all (`customRoles: []` on a fresh install) is
 * reported by `configOptionDescription` as having none, rather than opening on
 * a list holding nothing but a "back" row — which reads as a screen that failed
 * to load.
 */
export function describeConfigValue(value: unknown): string {
  if (typeof value === 'string') return value === '' ? '(default)' : value
  if (value === undefined) return '(unset)'
  return String(value)
}

/** What a row is called. The block's name, the scope's target, or a field's label. */
export function configOptionTitle(option: ConfigOption, scope: ConfigScope): string {
  switch (option.kind) {
    case 'scope':
      return scope === 'project'
        ? '📁 Save to this project (.opencode/nexus.jsonc)'
        : '🌍 Save to global (~/.config/opencode/nexus.jsonc)'
    case 'block':
      return option.block.name
    case 'field':
      return option.field.label
    case 'toggle':
      return option.title
    case 'back':
      return '← Back'
    case 'save':
      return '💾 Save and close'
    case 'close':
      return '✕ Close without saving'
  }
}

/**
 * What a row says underneath itself, which is where the CURRENT value lives.
 *
 * A block's row counts its fields, because a list of eight block names tells a
 * user nothing about which one holds the setting they are looking for. A field's
 * row shows its value AND whether it has been changed since the flow opened —
 * the dialog equivalent of the panel's `*`, and the only way a staged edit is
 * visible before the save that commits it.
 */
export function configOptionDescription(
  option: ConfigOption,
  draft: ConfigDraft,
  dirty: boolean
): string {
  switch (option.kind) {
    case 'scope':
      return 'Nothing is written until you choose Save'
    case 'block': {
      const count = option.block.fields.length
      // The empty case is said out loud. `customRoles` is empty on a fresh
      // install, and a list holding nothing but "← Back" reads as a screen that
      // failed to load rather than as a block with nothing in it.
      return count === 0
        ? 'no settings here yet — add custom roles in nexus.jsonc'
        : `${count} ${count === 1 ? 'setting' : 'settings'}`
    }
    case 'field': {
      const value = describeConfigValue(configValueAt(draft, option.field.path))
      return dirty ? `${value}  *` : value
    }
    case 'toggle':
      return ''
    case 'back':
      return 'Your changes are kept — nothing is written yet'
    case 'save':
      return dirty ? 'Write the staged changes to disk' : 'No changes to write'
    case 'close':
      return 'Leave. Nothing is written'
  }
}

/**
 * The line of help under a `prompt`'s title, or nothing.
 *
 * A decision rather than a string, and it lives here for the same reason every
 * other one does: the adapter should not be the place that knows a number wants
 * different words from a host name. `undefined` means the host's own prompt shows
 * no description at all, which is right for a text — there is nothing to warn a
 * user about typing into a free-text field.
 */
export function configPromptDescription(field: ConfigField): string | undefined {
  return field.kind === 'number' ? 'A number. No trailing text.' : undefined
}

/**
 * Whether the host should refuse this row.
 *
 * Only one case: a value this flow has no editor for. It is still LISTED —
 * omitting it would make a setting look non-existent rather than unchangeable,
 * which is the same defect as a dead knob — and the host's `disabled` flag
 * renders it and refuses it, which is a real host feature rather than a
 * hand-rolled grey row. A boolean's own two rows are never disabled, whatever
 * the current value: choosing the row a key is already on is a way to leave it
 * alone, and disabling it would make "off, and I mean off" unreachable.
 */
export function configOptionDisabled(option: ConfigOption): boolean {
  return option.kind === 'field' && editorFor(option.field) === 'none'
}

// ── Screens and their rows ──────────────────────────────────────────

/**
 * One rendered row, in the shape the host's `DialogSelectOption` expects.
 *
 * Declared here rather than imported: `@opencode/plugin/tui` re-exports only
 * `Plugin`, the solid provider and the hook — `DialogSelectOption` lives in
 * `dist/tui/context.d.ts` and is not part of the public entry, and the adapter
 * must not reach into `dist/` for it. This is a structural SUBSET of that
 * interface (title, value, description?, disabled?), so an array of these is
 * assignable to what `ui.dialog.select` asks for, and the check is the
 * compiler's rather than this comment's.
 */
export interface ConfigRow<Option> {
  readonly title: string
  readonly value: Option
  readonly description?: string
  readonly disabled?: boolean
}

/** One row in one of the flow's lists. The host's `select` returns one of these. */
export type ConfigOption =
  /** The save scope. A leaf: choosing it does not navigate. */
  | { readonly kind: 'scope'; readonly scope: ConfigScope }
  /** A config block. Choosing it enters that block's field list. */
  | { readonly kind: 'block'; readonly block: ConfigBlock }
  /** One field. Choosing it opens that field's editor. */
  | { readonly kind: 'field'; readonly field: ConfigField }
  /** One of a boolean's two rows. */
  | { readonly kind: 'toggle'; readonly value: boolean; readonly title: string }
  /** Go back up one level. */
  | { readonly kind: 'back' }
  /** Write the draft. Only on the hub. */
  | { readonly kind: 'save' }
  /** Leave without writing. Only on the hub. */
  | { readonly kind: 'close' }

/**
 * The hub's rows: the save scope, then every block, then save and close.
 *
 * `save` and `close` are rows rather than the absence of a selection, because
 * "press escape to leave" and "press escape to throw your changes away" are the
 * same key and only one of them is what a user means at the hub — where there is
 * nothing staged to throw away in the first place, since nothing is written
 * until save.
 */
export function blockOptions(
  discovery: ConfigDiscovery,
  scope: ConfigScope
): readonly ConfigOption[] {
  return [
    { kind: 'scope', scope },
    ...discovery.blocks.map(block => ({ kind: 'block' as const, block })),
    { kind: 'save' as const },
    { kind: 'close' as const }
  ]
}

/**
 * A block's rows: every field in it, then a way back.
 *
 * The block's own name is not repeated on every row, so a field labelled
 * `enabled` is unambiguous here in a way it is not across the whole config — the
 * dialog's title names the block.
 */
export function fieldOptions(discovery: ConfigDiscovery, block: string): readonly ConfigOption[] {
  const found = discovery.blocks.find(candidate => candidate.name === block)
  if (found === undefined) return []
  return [
    ...found.fields.map(field => ({ kind: 'field' as const, field })),
    { kind: 'back' as const }
  ]
}

/**
 * `✅ Enabled` / `☐ Disabled`, and the reason it is shaped like that.
 *
 * The host's `ui` object has no checkbox, no multi-select and no form:
 * `DialogSelectOption` carries only `title`, `value`, `description?`, `footer?`,
 * `category?` and `disabled?`, and `dialog.select` resolves a SINGLE value, so a
 * switch in a list can only be two rows you pick between. That is a real
 * limitation of the host and this workaround is honest — the glyph is part of
 * the row's own title, the other row is the other value, and the row the key is
 * already on is named as current so the host opens there rather than at the top.
 *
 * The CURRENT row is placed first, which is also why the order is computed
 * rather than written out: a two-row list whose order depended on the value
 * would be two lists, and the one test here has to be about both of them.
 */
export function booleanOptions(current: boolean): readonly ConfigOption[] {
  const rows: readonly { value: boolean; title: string }[] = [
    { value: true, title: '✅ Enabled' },
    { value: false, title: '☐ Disabled' }
  ]
  return rows
    .map(row => ({
      kind: 'toggle' as const,
      value: row.value,
      title: row.value === current ? `${row.title}  (current)` : row.title
    }))
    .sort((a, b) => Number(b.value === current) - Number(a.value === current))
}

/**
 * Every option reachable from `screen` — every row the flow can show there.
 *
 * The flow's own state space, for the reachability search in the test suite: a
 * screen the search cannot ENTER is a control no user can reach, and an
 * `editor` for a boolean that listed neither row would be a switch with no
 * answers.
 *
 * AN EDITOR FOR A NUMBER, A TEXT OR A MODEL HAS NO ROWS HERE, and that is a
 * statement about the host rather than a gap: those open `ui.dialog.prompt` (or
 * the provider picker), and their rows are the host's — one input line, or a
 * list of models — and are not this flow's to enumerate. An empty list on such a
 * screen means "the answer is the host's widget", and the reachability search
 * treats it as a screen with a way out rather than a dead end. The BOOLEAN case
 * is the opposite and that is the distinction worth testing: its rows are
 * this flow's, because this flow built them.
 */
export function configScreenOptions(
  screen: ConfigScreen,
  discovery: ConfigDiscovery,
  scope: ConfigScope,
  current: (field: ConfigField) => unknown
): readonly ConfigOption[] {
  if (screen.kind === 'blocks') return blockOptions(discovery, scope)
  if (screen.kind === 'fields') return fieldOptions(discovery, screen.block)
  return screen.field.kind === 'boolean' ? booleanOptions(current(screen.field) === true) : []
}

// ── Navigation ──────────────────────────────────────────────────────

/**
 * What choosing `option` on `screen` does.
 *
 * Deliberately small: `to` navigates, `stay` is a row that changes a variable
 * the adapter holds, or that is an answer rather than a destination, and
 * `save`/`close` end the flow. There is no `set` and no `pick-model` here,
 * because a staged edit is NEVER the result of choosing a row on a list — it is
 * the result of answering an editor, and the answer arrives from the host rather
 * than from a row this function is handed. Folding those into one step would
 * have meant this function returning "open a prompt, and while you are there,
 * also write the value", which is the shape that made the old budget prompt's
 * `parseFloat` fall-through untestable.
 */
export type ConfigSelect =
  | { readonly kind: 'to'; readonly screen: ConfigScreen }
  | { readonly kind: 'stay' }
  | { readonly kind: 'save' }
  | { readonly kind: 'close' }

/**
 * Act on a chosen row.
 *
 * EVERY EDITABLE FIELD'S ROW OPENS ITS EDITOR, uniformly, whichever widget that
 * editor turns out to be. That uniformity is what makes the flow's state space a
 * graph a test can walk: a field is a place the flow can BE, reached the same
 * way whether its answer is two rows, a line of text, or a list of models.
 * Splitting the four widgets into four different transitions would have made
 * "can the user reach this setting" a different question for each, and the
 * number and text cases are exactly the two that regress silently.
 *
 * The scope row is `stay` rather than `to`: it changes a variable the ADAPTER
 * holds, and routing that through a screen would mean a screen per scope
 * (`blocks/project`, `blocks/global`) differing in nothing but a label. The
 * `back` row is `to` the hub, so a block's list can offer it without the flow
 * needing a second concept for "up".
 */
export function configSelect(screen: ConfigScreen, option: ConfigOption): ConfigSelect {
  switch (option.kind) {
    case 'scope':
      return { kind: 'stay' }
    case 'save':
      return { kind: 'save' }
    case 'close':
      return { kind: 'close' }
    case 'block':
      return { kind: 'to', screen: { kind: 'fields', block: option.block.name } }
    case 'field': {
      // A value with no editor gets no screen, so a `disabled` row the host let
      // through anyway cannot become a place the flow goes and a path it writes
      // to. It stays where it was.
      if (editorFor(option.field) === 'none') return { kind: 'stay' }
      return { kind: 'to', screen: { kind: 'editor', field: option.field } }
    }
    case 'toggle':
      // A toggle row is only ever on a boolean's editor screen, and choosing it
      // is an ANSWER, not a destination: the flow does not move, and the adapter
      // commits it with `commitConfigToggle` and returns to the field's list.
      return { kind: 'stay' }
    case 'back': {
      const up = configUp(screen)
      // Unreachable from any list the flow builds — `back` is only ever offered
      // inside a block — but total rather than a lie: a `to` with no screen to
      // go to would be a lie about where the user ends up.
      return { kind: 'to', screen: up ?? { kind: 'blocks' } }
    }
  }
}

/** The field whose editor `screen` is, or `undefined` for the two lists. */
export function configScreenField(screen: ConfigScreen): ConfigField | undefined {
  return screen.kind === 'editor' ? screen.field : undefined
}

/**
 * The screen one level up, or `undefined` at the hub.
 *
 * `undefined` at the hub is the whole escape semantics: there is nothing above
 * the hub, so escaping from it leaves the flow, and since nothing is written
 * until `save` that leaves the user's file untouched. Escaping from an editor or
 * a block's list goes UP rather than closing, which is the difference between a
 * flow you can back out of and one you either finish or abandon.
 *
 * There is no second question here — "are there unsaved edits?" — because the
 * answer is always no. An edit is staged in memory and the file is written only
 * by `configSelect`'s `save`, so the most a user can lose by escaping is a
 * dialog they chose to leave. The panel this replaces DID have to ask, because
 * its `r` and its draft were the only two ways back and a stale draft could
 * outlive the session.
 */
export function configUp(screen: ConfigScreen): ConfigScreen | undefined {
  if (screen.kind === 'blocks') return undefined
  if (screen.kind === 'fields') return { kind: 'blocks' }
  return { kind: 'fields', block: screen.field.block }
}

/** The block a screen is inside, or `undefined` at the hub. */
export function configScreenBlock(screen: ConfigScreen): string | undefined {
  switch (screen.kind) {
    case 'blocks':
      return undefined
    case 'fields':
      return screen.block
    case 'editor':
      return screen.field.block
  }
}

/**
 * The screen a field's editor returns to, which is the block's own field list.
 *
 * One function rather than a literal at each call site, because the block a
 * field belongs to is carried on the field itself (`ConfigField.block`) and a
 * caller that has to reach up the path to rediscover it is a caller that can put
 * the two out of step.
 */
export function configFieldsScreen(field: ConfigField): ConfigScreen {
  return { kind: 'fields', block: field.block }
}

/**
 * Commit a boolean's answer, given the row the user chose.
 *
 * A separate function because the boolean's two rows carry the value they stand
 * for and there is no text to parse: choosing `☐ Disabled` writes `false`, and
 * choosing the row the key is ALREADY on writes that same value — which is how a
 * user says "off, and I mean off" without needing a separate cancel. The
 * assignment is deliberately NOT an inversion of what was there: inverting would
 * make "choose the row that is already current" mean "flip it", the opposite of
 * what the row says.
 */
export function commitConfigToggle(field: ConfigField, chosen: ConfigOption): ConfigCommit {
  if (chosen.kind !== 'toggle') {
    throw new Error(
      `a boolean editor was answered with a ${chosen.kind} row, not a toggle row`
    )
  }
  return { kind: 'accepted', field, value: chosen.value }
}
