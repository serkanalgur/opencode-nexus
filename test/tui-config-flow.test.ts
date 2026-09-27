import { describe, it, expect, afterAll, mock } from 'bun:test'
import * as realOs from 'node:os'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { blankNonCode, interfaceFieldNames, matchBrace, readSourceFile } from './helpers/dashboard-page'

// `NexusConfigManager`'s constructor seeds from `homedir()`, so the module is
// sandboxed rather than the environment — the same pattern, and the same
// reason, as `test/config-knobs.test.ts` and as the panel test file this
// replaces. A REAL temp dir, because CI is ubuntu and a home-relative fixture
// has shipped a test that passed on darwin and failed on both ubuntu legs.
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'nexus-flow-'))
mock.module('node:os', () => ({ ...realOs, default: realOs, homedir: () => SANDBOX_HOME }))

const { NexusConfigManager } = await import('../src/config')
const {
  blockOptions,
  booleanOptions,
  commitConfigModel,
  commitConfigText,
  commitConfigToggle,
  configFieldsScreen,
  configIsDirty,
  configOptionDescription,
  configOptionDisabled,
  configOptionTitle,
  configPathLabel,
  configPromptDescription,
  configSaveUpdate,
  configScreenOptions,
  configSelect,
  configUp,
  configValueAt,
  describeConfigValue,
  discoverConfig,
  editorFor,
  fieldOptions,
  parseConfigNumber,
  setConfigValue
} = await import('../src/config-flow')

// Types are erased, so they are imported statically even though the values
// above have to be awaited (the `node:os` mock must be in place first).
import type { ConfigDraft, ConfigField, ConfigScreen } from '../src/config-flow'

afterAll(() => {
  mock.module('node:os', () => realOs)
})

// ── Fixtures ────────────────────────────────────────────────────────

/** The real merged config — the flow's actual input, not a hand-written one. */
function realConfig(): ConfigDraft {
  return new NexusConfigManager().getConfig() as unknown as ConfigDraft
}

function realDiscovery() {
  return discoverConfig(realConfig())
}

/** A field addressed BY PATH, which is the only unique address in the config. */
function fieldAt(discovery: ReturnType<typeof discoverConfig>, dotted: string): ConfigField {
  const found = discovery.fields.find(field => field.path.join('.') === dotted)
  if (found === undefined) throw new Error(`no field at ${dotted}`)
  return found
}

/**
 * Every primitive leaf in `config`, walked WITHOUT the module's own walker.
 *
 * The independence is the point. `discoverConfig`'s tests are about `discoverConfig`
 * against itself, which cannot fail for a reason a user would recognise; this
 * walk shares no code with it, so a leaf the flow's walker stopped visiting shows
 * up here as a leaf with no dialog row.
 */
function independentLeaves(config: ConfigDraft): string[] {
  const leaves: string[] = []
  const walk = (value: unknown, path: string[]): void => {
    if (value === null || typeof value !== 'object') {
      leaves.push(path.join('.'))
      return
    }
    if (Array.isArray(value)) {
      value.forEach((element, index) => walk(element, [...path, String(index)]))
      return
    }
    for (const [key, child] of Object.entries(value)) walk(child, [...path, key])
  }
  walk(config, [])
  return leaves
}

/**
 * Every screen reachable from the hub, breadth-first.
 *
 * The popup equivalent of the panel's key-reachability search, and the same
 * shape of argument: the ONLY edges are the flow's own — one per row
 * `configScreenOptions` offers, carried out by `configSelect`, plus `configUp`
 * for the escape key the host owns. A screen this cannot enter is a control no
 * user can reach, and the question "which screens can a user be in" is the same
 * question the panel's version asked about cursor positions.
 *
 * Breadth-first so the set is closed under the edge set rather than depending on
 * the order rows happen to be tried. The cap is a backstop against a state space
 * that grew unexpectedly, and it THROWS rather than truncating, so a search that
 * stopped early is a failure rather than a smaller answer that looks like
 * success.
 */
function reachableScreens(
  initial: ConfigScreen,
  discovery: ReturnType<typeof discoverConfig>,
  config: ConfigDraft,
  scope: 'project' | 'global',
  cap = 5000
): ConfigScreen[] {
  const key = (screen: ConfigScreen): string =>
    screen.kind === 'blocks'
      ? 'blocks'
      : screen.kind === 'fields'
        ? `fields:${screen.block}`
        : `editor:${screen.field.path.join('.')}`

  const seen = new Map<string, ConfigScreen>([[key(initial), initial]])
  const queue: ConfigScreen[] = [initial]
  const current = (field: ConfigField): unknown => configValueAt(config, field.path)
  while (queue.length > 0) {
    const screen = queue.shift() as ConfigScreen
    const next: ConfigScreen[] = []
    for (const option of configScreenOptions(screen, discovery, scope, current)) {
      const outcome = configSelect(screen, option)
      if (outcome.kind === 'to') next.push(outcome.screen)
    }
    // The escape key, which the host owns and this flow has to place.
    const up = configUp(screen)
    if (up !== undefined) next.push(up)
    for (const screen2 of next) {
      const id = key(screen2)
      if (seen.has(id)) continue
      seen.set(id, screen2)
      queue.push(screen2)
      if (seen.size > cap) throw new Error(`flow state space exceeded ${cap} screens`)
    }
  }
  return [...seen.values()]
}

// ── Discovery ───────────────────────────────────────────────────────

describe('config flow discovery', () => {
  it('offers a block for every key the config actually has, with no list of its own', () => {
    const config = realConfig()
    const { blocks } = discoverConfig(config)
    // Derived from the config object, not restated: a block added to
    // `NexusFullConfig` appears here without this test being edited.
    expect(blocks.map(block => block.name).sort()).toEqual(Object.keys(config).sort())
  })

  /**
   * THE reachability guarantee, in the form a dialog flow can honestly state.
   *
   * The panel's version asked "can the cursor get to this row"; the host owns
   * the cursor in a `select`, so that question has no meaning here. The one that
   * does is "does SOME dialog offer this key", and this is it: for every leaf of
   * an independently-walked merged config, some block's field list must carry a
   * row for exactly that path.
   *
   * A block dropped from the hub fails it. A field dropped from its own block's
   * list fails it. A field that lost its kind, and with it its editor, fails it —
   * because the assertion is over EVERY leaf, not over the fields the flow says
   * it has.
   */
  it('offers a row for EVERY leaf of the real config, in some block dialog', () => {
    const config = realConfig()
    const discovery = discoverConfig(config)
    const leaves = independentLeaves(config)
    expect(leaves.length).toBeGreaterThan(0)

    // Which block each leaf belongs to, read off the config rather than off
    // `discovery`, so a field filed under the wrong block fails too.
    const owner: Record<string, string> = {}
    const collect = (value: unknown, path: string[]): void => {
      if (value === null || typeof value !== 'object') {
        owner[path.join('.')] = path[0] ?? ''
        return
      }
      if (Array.isArray(value)) {
        value.forEach((element, index) => collect(element, [...path, String(index)]))
        return
      }
      for (const [key, child] of Object.entries(value)) collect(child, [...path, key])
    }
    collect(config, [])

    const offered = new Map<string, boolean>()
    for (const block of discovery.blocks) {
      for (const option of fieldOptions(discovery, block.name)) {
        if (option.kind !== 'field') continue
        offered.set(option.field.path.join('.'), configOptionDisabled(option))
      }
    }

    const missing = leaves.filter(leaf => !offered.has(leaf))
    const refused = leaves.filter(leaf => offered.get(leaf) === true)
    expect({ missing, refused }).toEqual({ missing: [], refused: [] })
    // The block is load-bearing: a field offered under a DIFFERENT block is a row
    // the user reaches from the wrong heading, so the row and its block must
    // agree. Checked by path prefix rather than by re-walking, so it cannot pass
    // because two walks agree with each other.
    for (const block of discovery.blocks) {
      for (const option of fieldOptions(discovery, block.name)) {
        if (option.kind !== 'field') continue
        expect(owner[option.field.path.join('.')]).toBe(block.name)
      }
    }
  })

  it('gives every real field an editor, so no row opens nothing', () => {
    const { fields } = realDiscovery()
    const withoutEditor = fields.filter(field => editorFor(field) === 'none').map(field => configPathLabel(field.path))
    expect(withoutEditor).toEqual([])
    // And the four widgets between them are all reachable in the shipped config,
    // so a flow that quietly stopped offering one of them would fail here rather
    // than in a report a user files.
    const used = new Set(fields.map(editorFor))
    expect([...used].sort()).toEqual(['boolean', 'model', 'number', 'text'])
  })

  it('reports no value it has no editor for, rather than hiding it', () => {
    // `null` is a value with no widget here. It still gets a field, the field
    // still gets a row, and the row is `disabled` — which the host renders and
    // refuses — and it is reported by `uneditableFields`. A new key of a shape
    // nobody anticipated should fail a test rather than arrive as a value nobody
    // can change, and it should not arrive as a value nobody can FIND either.
    const discovery = discoverConfig({ odd: { when: null, ok: true } })
    expect(discovery.fields.map(field => field.label)).toEqual(['when', 'ok'])
    expect(discovery.fields.map(field => field.kind)).toEqual(['opaque', 'boolean'])
    expect(discovery.uneditableFields).toEqual(['odd.when'])

    const rows = fieldOptions(discovery, 'odd')
    expect(rows.map(row => row.kind)).toEqual(['field', 'field', 'back'])
    // Offered, and refused. Dropping the row instead would make a setting look
    // non-existent rather than unchangeable, which is the same defect as a dead
    // knob — the thing this file exists to make impossible.
    expect(rows.map(configOptionDisabled)).toEqual([true, false, false])
  })

  it('shows a block the flow was never told about, with no edit to the flow', () => {
    // Stands in for any block a later change adds: a name and a shape this file
    // contains no mention of, dropped into the config.
    const withNewBlock = { ...realConfig(), telemetry: { enabled: true, sample: 3, label: 'x' } }
    const discovery = discoverConfig(withNewBlock)
    const telemetry = discovery.blocks.find(block => block.name === 'telemetry')

    expect(telemetry).toBeDefined()
    expect(telemetry?.fields.map(field => field.kind).sort()).toEqual(['boolean', 'number', 'text'])
    expect(blockOptions(discovery, 'global').some(o => o.kind === 'block' && o.block.name === 'telemetry')).toBe(true)
  })

  it('gives a model reference the picker and a plain string the text field', () => {
    const { fields } = discoverConfig({ models: { coder: 'anthropic/claude-sonnet-4-6', note: 'hello' } })
    expect(fields.map(field => field.kind)).toEqual(['model', 'text'])
  })

  it('treats an array element as an ordinary field of its block, with no array code', () => {
    // The panel needed a navigable array header to step onto `customRoles[0]`;
    // a dialog has no cursor to park one on, and the element rows ARE the
    // entries. This is the shape that removes that concept.
    const discovery = discoverConfig({ customRoles: [{ name: 'a', prompt: 'p' }] })
    expect(discovery.blocks.map(block => block.name)).toEqual(['customRoles'])
    expect(discovery.fields.map(field => configPathLabel(field.path))).toEqual([
      'customRoles[0].name',
      'customRoles[0].prompt'
    ])
    expect(fieldOptions(discovery, 'customRoles').map(row => row.kind)).toEqual(['field', 'field', 'back'])
  })
})

// ── Reachability: the guarantee this feature is really about ────────

describe('config flow reachability', () => {
  it('reaches every field\'s editor from the hub, using only the flow\'s own rows and its escape key', () => {
    const config = realConfig()
    const discovery = discoverConfig(config)
    const reached = reachableScreens({ kind: 'blocks' }, discovery, config, 'global')
    const visited = new Set(
      reached
        .filter((screen): screen is Extract<ConfigScreen, { kind: 'editor' }> => screen.kind === 'editor')
        .map(screen => screen.field.path.join('.'))
    )

    // Compared against the INDEPENDENT walk, not against `discovery.fields`. A
    // field the walk finds and the search cannot reach fails this; a field the
    // walk does not find is not this test's business.
    const leaves = independentLeaves(config)
    const unreachable = leaves.filter(leaf => !visited.has(leaf))
    expect(unreachable).toEqual([])
  })

  it('reaches every block\'s field list too, so no block is a dead heading on the hub', () => {
    const config = realConfig()
    const discovery = discoverConfig(config)
    const reached = reachableScreens({ kind: 'blocks' }, discovery, config, 'global')
    const blocks = new Set(
      reached.filter((s): s is Extract<ConfigScreen, { kind: 'fields' }> => s.kind === 'fields').map(s => s.block)
    )
    expect([...blocks].sort()).toEqual(Object.keys(config).sort())
  })

  /**
   * No dead ends, and no trap at the bottom.
   *
   * Every screen that is not the hub has a way UP, and the hub has a way OUT.
   * A screen a user can enter and not leave is the dialog-flow version of the
   * panel bug its `keymap.layer` docs warn about — an `<input>` that consumes
   * the keyboard, so `esc` never arrives.
   */
  it('gives every screen a way back, and the hub a way out', () => {
    const config = realConfig()
    const discovery = discoverConfig(config)
    const reached = reachableScreens({ kind: 'blocks' }, discovery, config, 'global')

    // The search covered the WHOLE state space, not a subset of it. One hub, one
    // list per block, one editor per field — and the count is derived from the
    // discovery rather than written down, so a block or a field that produced no
    // screen at all fails here instead of quietly shrinking the search.
    expect(reached).toHaveLength(1 + discovery.blocks.length + discovery.fields.length)

    for (const screen of reached) {
      const up = configUp(screen)
      if (screen.kind === 'blocks') {
        expect(up).toBeUndefined()
        continue
      }
      // Defined, and a real screen rather than the one we came from.
      expect(up).toBeDefined()
      expect(up).not.toEqual(screen)
    }
  })

  it('offers a way out of every list, and a save and a close only on the hub', () => {
    const config = realConfig()
    const discovery = discoverConfig(config)
    const hub = blockOptions(discovery, 'global')

    // The hub: save and close are rows, not the absence of a selection, so
    // "press escape" and "throw it away" are not the same key at the top.
    expect(hub.filter(option => option.kind === 'save')).toHaveLength(1)
    expect(hub.filter(option => option.kind === 'close')).toHaveLength(1)
    expect(hub.filter(option => option.kind === 'scope')).toHaveLength(1)

    // Every block's list ends with a way back — including a block with no fields
    // at all, which is `customRoles` on a fresh install and would otherwise be a
    // screen holding nothing.
    for (const block of discovery.blocks) {
      const rows = fieldOptions(discovery, block.name)
      expect(rows.filter(row => row.kind === 'back')).toHaveLength(1)
      expect(rows.filter(row => row.kind === 'save')).toHaveLength(0)
      expect(rows.filter(row => row.kind === 'close')).toHaveLength(0)
    }
  })

  it('a disabled row is not a place the flow can go, and cannot become a write', () => {
    // The host refuses a `disabled` row, but a refusal is a UI affordance and
    // not a guarantee about the code behind it. The flow must not navigate to a
    // value it cannot edit even if the row comes back.
    const discovery = discoverConfig({ odd: { when: null, ok: true } })
    const when = fieldAt(discovery, 'odd.when')
    const listScreen = configFieldsScreen(when)
    const row = fieldOptions(discovery, 'odd').find(o => o.kind === 'field')

    expect(configSelect(listScreen, row as never)).toEqual({ kind: 'stay' })
    // And it is not a write either. `save` is a hub row and the hub row is not
    // offered below the hub — checked where that is actually decided, in the
    // "save and a close only on the hub" test above, rather than re-derived here
    // from a union of rows the flow never shows together.
  })
})

// ── Escaping partway ────────────────────────────────────────────────

describe('config flow escape', () => {
  const config = realConfig()
  const discovery = discoverConfig(config)

  it('goes up one level from a field, and to its own block from an editor', () => {
    const field = fieldAt(discovery, 'budget.maxTotalCost')
    expect(configUp(configFieldsScreen(field))).toEqual({ kind: 'blocks' })
    expect(configUp({ kind: 'editor', field })).toEqual({ kind: 'fields', block: 'budget' })
  })

  it('leaves from the hub, which writes nothing — the only exit that does', () => {
    // `configUp` returning `undefined` at the hub IS the "leave, having written
    // nothing" decision: the file is only written by the `save` outcome, and
    // every path to that outcome goes through a hub row.
    expect(configUp({ kind: 'blocks' })).toBeUndefined()

    const screens: ConfigScreen[] = [
      { kind: 'fields', block: 'budget' },
      { kind: 'editor', field: fieldAt(discovery, 'budget.maxTotalCost') }
    ]
    for (const screen of screens) {
      for (const option of configScreenOptions(screen, discovery, 'global', f => configValueAt(config, f.path))) {
        expect(configSelect(screen, option).kind).not.toBe('save')
      }
    }
  })

  it('reaches the hub from every screen in at most two escapes, so nothing traps the user', () => {
    // The concrete property, not "an exit exists somewhere": following the escape
    // key from any screen a user can ENTER lands on the hub within two presses.
    // A `configUp` that returned the same screen, or a three-level-deep tree,
    // fails this — and a screen the host shows and nothing can leave does not.
    const reached = reachableScreens({ kind: 'blocks' }, discovery, config, 'global')
    const belowHub = reached.filter(screen => screen.kind !== 'blocks')
    expect(belowHub.length).toBeGreaterThan(0)

    for (const screen of belowHub) {
      const hops: ConfigScreen[] = []
      let cursor: ConfigScreen | undefined = screen
      while (cursor !== undefined && cursor.kind !== 'blocks') {
        const next: ConfigScreen | undefined = configUp(cursor)
        // Defined on the way IN is the assertion; a screen whose only escape is
        // undefined would exit the flow from two levels down and strand the edits
        // staged for the block the user was in.
        expect(next).toBeDefined()
        if (next === undefined) break
        hops.push(next)
        // A cycle would be a screen that escapes to itself.
        expect(hops.length).toBeLessThanOrEqual(2)
        cursor = next
      }
      expect(cursor).toEqual({ kind: 'blocks' })
    }
  })

  it('a boolean editor\'s two rows are the only things it can answer with, and neither navigates', () => {
    // The answer to a switch is a VALUE, not a destination. If choosing a row
    // moved the flow, the value would have nowhere to go.
    const field = fieldAt(discovery, 'notifications.enabled')
    const editor: ConfigScreen = { kind: 'editor', field }
    for (const row of booleanOptions(true)) {
      expect(configSelect(editor, row).kind).toBe('stay')
    }
  })
})

// ── A boolean is two rows ───────────────────────────────────────────

describe('a boolean, as two rows in a single-select list', () => {
  it('offers both values with the glyph in the row title, whichever is current', () => {
    for (const current of [true, false]) {
      const rows = booleanOptions(current)
      // Two rows, both values, both glyphs — and no third row and no disabled
      // one, because the host has no checkbox to put here instead.
      expect(rows).toHaveLength(2)
      expect(rows.map(row => (row.kind === 'toggle' ? row.value : null)).sort()).toEqual([false, true])
      const titles = rows.map(row => configOptionTitle(row, 'global'))
      expect(titles.filter(title => title.includes('✅'))).toHaveLength(1)
      expect(titles.filter(title => title.includes('☐'))).toHaveLength(1)
      // The current row is named, and it is the one the host opens on, so the
      // user does not have to read both rows to know where they are.
      expect(titles.filter(title => title.includes('(current)'))).toHaveLength(1)
      // And neither is refused: choosing the row a key is already on is how a
      // user says "off, and I mean off".
      expect(rows.map(configOptionDisabled)).toEqual([false, false])
    }
  })

  it('writes the value the chosen row stands for, not the inverse of what was there', () => {
    const discovery = realDiscovery()
    const field = fieldAt(discovery, 'notifications.enabled')
    const rows = booleanOptions(false)

    const off = commitConfigToggle(field, rows.find(r => r.kind === 'toggle' && r.value === false) as never)
    expect(off).toEqual({ kind: 'accepted', field, value: false })

    // And the row that IS current is a no-op change, not a flip. Inverting here
    // would make "choose the row I am already on" mean the opposite of what it
    // says, which is the one thing a two-row switch must not do.
    const current = commitConfigToggle(field, rows.find(r => r.kind === 'toggle' && r.value === true) as never)
    const after = setConfigValue(realConfig(), field.path, current.kind === 'accepted' ? current.value : undefined)
    expect(configValueAt(after, field.path)).toBe(true)
  })

  it('refuses an answer that is not one of its own two rows', () => {
    // The two rows are the only things a boolean editor can return, and a commit
    // that accepted anything else would be a write to a path nothing chose.
    const field = fieldAt(realDiscovery(), 'notifications.enabled')
    expect(() => commitConfigToggle(field, { kind: 'back' })).toThrow(/toggle row/)
  })
})

// ── A number that will not parse says so ────────────────────────────

describe('a number that will not parse is rejected VISIBLY', () => {
  const discovery = realDiscovery()

  it('does not read 12abc as 12, and says what was wrong', () => {
    // The bug being fixed, pinned first so the fix cannot quietly reintroduce it:
    // the old budget prompt used `parseFloat`, and on `NaN` fell through to
    // NOTHING — the dialog closed, the value did not change, and a rejection was
    // indistinguishable from a keypress that missed.
    expect(parseFloat('12abc')).toBe(12)

    const result = parseConfigNumber('12abc')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('12abc was accepted as a number')
    // The message NAMES what was typed, so a user can see which of two rejected
    // values they are looking at.
    expect(result.message).toContain('12abc')
  })

  it('rejects a number-shaped commit rather than dropping it, and carries no value', () => {
    // The load-bearing assertion is the SHAPE of the outcome. A commit that
    // returned `accepted` with the old value, or returned nothing at all, is the
    // silent discard this exists to prevent — and "returned nothing" is a type no
    // test can catch by looking at a value, only by noticing the outcome is
    // absent. So both are checked: there IS an outcome, it says `rejected`, it
    // carries a message, and it carries no `value` at all.
    const field = fieldAt(discovery, 'budget.maxTotalCost')
    const commit = commitConfigText(field, '12abc')

    expect(commit.kind).toBe('rejected')
    expect('value' in commit).toBe(false)
    if (commit.kind !== 'rejected') throw new Error('a bad number was not rejected')
    expect(commit.message.length).toBeGreaterThan(0)
    expect(commit.field).toEqual(field)

    // And nothing was written, which is the other half: a rejection that changed
    // the value would be worse than a silent one.
    const draft = realConfig()
    expect(configValueAt(draft, field.path)).toBe(10)
  })

  it('rejects empty text, negatives, non-decimal radix and infinities', () => {
    // `0x10` is in this list because `Number("0x10")` IS 16: the alternate-radix
    // prefixes are the same class of bug as `parseFloat`'s trailing garbage, from
    // the other direction, and a port or a cost ceiling silently written as 16
    // is the failure this parse exists to prevent.
    expect(Number('0x10')).toBe(16)
    const rejected = ['', '   ', 'abc', '12abc', '1,000', '-1', '1e999', 'NaN', '0x10', '0b101', '0o17', 'Infinity', '1 000']
    for (const text of rejected) {
      expect({ text, ok: parseConfigNumber(text).ok }).toEqual({ text, ok: false })
    }
  })

  it('accepts zero, decimals, surrounding space and an exponent', () => {
    // Every numeric key in the config today is a cost, a retry count, a delay in
    // ms, a threshold or a port — none of which is negative, and zero is a real
    // value for a ceiling.
    const accepted: Record<string, number> = { '0': 0, '1.5': 1.5, ' 42 ': 42, '1e3': 1000, '0.0': 0, '.5': 0.5 }
    for (const [text, value] of Object.entries(accepted)) {
      expect({ text, parsed: parseConfigNumber(text) }).toEqual({ text, parsed: { ok: true, value } })
    }
  })

  it('takes a text as written, INCLUDING the empty string, which is a real edit', () => {
    // `models.coder: ""` is what `getModelForRole` reads as "use the default", and
    // the picker's own "Use default" row relies on the same string — so a prompt
    // that rejected an empty answer would be refusing to clear a setting.
    const models = fieldAt(discovery, 'models.coder')
    const host = fieldAt(discovery, 'dashboard.host')

    expect(commitConfigText(host, '')).toEqual({ kind: 'accepted', field: host, value: '' })
    expect(commitConfigText(host, 'example.com')).toEqual({ kind: 'accepted', field: host, value: 'example.com' })
    // A model reference typed rather than picked goes down the same path.
    expect(commitConfigText(models, 'openai/gpt-5-mini')).toEqual({
      kind: 'accepted',
      field: models,
      value: 'openai/gpt-5-mini'
    })
    // A NUMBER field never takes text as written, whatever it looks like.
    const number = fieldAt(discovery, 'selfHealing.retryDelay')
    expect(commitConfigText(number, '4321').kind).toBe('accepted')
  })
})

// ── The model picker still does the model choice ────────────────────

describe('the models block still routes through the grouped picker', () => {
  it('gives every models entry the model editor, so the flow opens the provider picker', () => {
    const discovery = realDiscovery()
    const models = discovery.fields.filter(field => field.block === 'models')
    const roles = new NexusConfigManager().getRoles()
    expect(models).toHaveLength(roles.length)
    // Every one of them, and NOT a text prompt: the picker is the widget that
    // carries provider headings and the price column, and a free-text field
    // would quietly drop both.
    expect(models.map(field => editorFor(field))).toEqual(models.map(() => 'model'))
  })

  it('takes a model as a `ConfigCommit`, and a dismissal is not "Use default"', () => {
    const field = fieldAt(realDiscovery(), 'models.coder')
    // "Use default" is the empty string, and it is an accepted edit.
    expect(commitConfigModel(field, '')).toEqual({ kind: 'accepted', field, value: '' })
    expect(commitConfigModel(field, 'openai/gpt-5-mini')).toEqual({
      kind: 'accepted',
      field,
      value: 'openai/gpt-5-mini'
    })
    // A dismissal is a THIRD outcome. Folding it into the empty string would
    // write "use the default" to every role whose picker the user escaped out
    // of — the exact silent write this flow is built not to do.
    expect(commitConfigModel(field, undefined)).toEqual({ kind: 'dismissed', field })
  })

  it('shows an empty model as (default), because a blank row reads as a broken row', () => {
    expect(describeConfigValue('')).toBe('(default)')
    expect(describeConfigValue(0)).toBe('0')
    expect(describeConfigValue(false)).toBe('false')
    expect(describeConfigValue(undefined)).toBe('(unset)')
  })
})

// ── Rows carry the current value and a staged-change mark ───────────

describe('config flow rows', () => {
  it('shows every field row\'s current value, and marks the ones that differ from disk', () => {
    const config = realConfig()
    const discovery = discoverConfig(config)
    const field = fieldAt(discovery, 'budget.maxTotalCost')
    const row = fieldOptions(discovery, 'budget').find(o => o.kind === 'field' && o.field === field)
    expect(row).toBeDefined()
    expect(configOptionDescription(row as never, config, false)).toBe('10')

    // The staged value shows immediately, marked, because the only other place it
    // appears is a toast that has already gone.
    const staged = setConfigValue(config, field.path, 25)
    expect(configOptionDescription(row as never, staged, true)).toBe('25  *')
    // …and an UNSTAGED value is not marked, so a `*` always means "not on disk".
    expect(configOptionDescription(row as never, staged, false)).toBe('25')
  })

  it('says plainly that nothing is written until Save, on the two rows that decide it', () => {
    const discovery = realDiscovery()
    const hub = blockOptions(discovery, 'project')
    const scopeRow = hub.find(o => o.kind === 'scope')
    const saveRow = hub.find(o => o.kind === 'save')
    const closeRow = hub.find(o => o.kind === 'close')

    // The scope row names the FILE it writes to, which is the one thing a user
    // cannot check afterwards.
    expect(configOptionTitle(scopeRow as never, 'project')).toContain('.opencode/nexus.jsonc')
    expect(configOptionTitle(scopeRow as never, 'global')).toContain('~/.config/opencode/nexus.jsonc')
    expect(configOptionDescription(scopeRow as never, realConfig(), false)).toMatch(/Save/)
    expect(configOptionDescription(saveRow as never, realConfig(), true)).toMatch(/Write/)
    expect(configOptionDescription(closeRow as never, realConfig(), true)).toMatch(/Nothing is written/)
  })

  it('warns under a number prompt and stays quiet under a text one', () => {
    // Extracted from the adapter so this is assertable at all — and so the
    // adapter has no `field.kind` comparison left in it, which the source-level
    // guard above checks.
    const discovery = realDiscovery()
    expect(configPromptDescription(fieldAt(discovery, 'budget.maxTotalCost'))).toBe('A number. No trailing text.')
    // A text gets no line rather than a misleading one: there is nothing to warn
    // a user about typing into a free-text field.
    expect(configPromptDescription(fieldAt(discovery, 'dashboard.host'))).toBeUndefined()
    // And a model reference is a text as far as the prompt is concerned — the
    // picker is a different widget entirely.
    expect(configPromptDescription(fieldAt(discovery, 'models.coder'))).toBeUndefined()
  })

  it('counts a block\'s settings, and says so when a block has none', () => {    // `customRoles` is `[]` on a fresh install, and a row reading "0 settings"
    // with nothing behind it is indistinguishable from a block the flow failed to
    // load.
    const discovery = realDiscovery()
    const customRoles = blockOptions(discovery, 'global').find(
      o => o.kind === 'block' && o.block.name === 'customRoles'
    )
    expect(configOptionDescription(customRoles as never, realConfig(), false)).toMatch(/no settings here yet/)

    const budget = blockOptions(discovery, 'global').find(o => o.kind === 'block' && o.block.name === 'budget')
    // A SHAPE, not a count. The exact number is a fact about `budget` and would
    // fail for a reason no user would recognise when a key is added; what matters
    // is that a block with fields counts them and a block with none says so.
    expect(configOptionDescription(budget as never, realConfig(), false)).toMatch(/^\d+ settings$/)
  })
})

// ── Value paths ─────────────────────────────────────────────────────

describe('config flow value paths', () => {
  it('leaves the input alone and copies along the path', () => {
    const config: ConfigDraft = { a: { b: { c: 1 } }, d: 2 }
    const next = setConfigValue(config, ['a', 'b', 'c'], 9)
    expect(configValueAt(next, ['a', 'b', 'c'])).toBe(9)
    expect(configValueAt(config, ['a', 'b', 'c'])).toBe(1)
    // Off-path values are shared, not cloned — a deep copy of the whole config
    // on every edit would be the alternative.
    expect(next.d).toBe(config.d)
  })

  it('refuses a path that does not resolve rather than inventing the containers', () => {
    const config: ConfigDraft = { a: 1, list: [{ name: 'x' }] }
    expect(setConfigValue(config, ['nope', 'deeper'], 9)).toBe(config)
    expect(setConfigValue(config, ['a', 'deeper'], 9)).toBe(config)
    expect(setConfigValue(config, ['a', 5], 9)).toBe(config)
    expect(setConfigValue(config, ['list', 9], 'y')).toBe(config)
    expect(setConfigValue(config, ['list', 0, 'name'], 'y')).not.toBe(config)
  })

  it('writes into an array ELEMENT without swallowing the array', () => {
    // Spreading an array into an object literal copies every element in as a
    // numeric key, so `customRoles[0].name` would come back as an object holding
    // the whole array — reading back correctly with the element's other fields
    // gone.
    const config: ConfigDraft = { customRoles: [{ name: 'a', prompt: 'p' }] }
    const next = setConfigValue(config, ['customRoles', 0, 'name'], 'b')
    expect(Array.isArray(next.customRoles)).toBe(true)
    expect(next.customRoles).toEqual([{ name: 'b', prompt: 'p' }])
  })

  it('is dirty only when a value really differs, and not when keys are reordered', () => {
    const base: ConfigDraft = { a: 1, b: { c: 2, d: 3 } }
    expect(configIsDirty(base, { ...base })).toBe(false)
    expect(configIsDirty(base, { b: { d: 3, c: 2 }, a: 1 })).toBe(false)
    expect(configIsDirty(base, { a: 1, b: { c: 2, d: 4 } })).toBe(true)
    expect(configIsDirty(base, { a: 1 })).toBe(true)
  })
})

// ── The save path keeps every block ─────────────────────────────────

describe('config flow save path', () => {
  /**
   * `getSaveableConfig()` is a hand-written list of blocks, and
   * `saveProjectConfig` writes its RETURN VALUE AS THE WHOLE FILE. A block
   * missing from that list is therefore not left alone — it is DELETED from the
   * user's `nexus.jsonc` the first time they save anything at all, which is what
   * makes a config surface (whose whole job is saving) the place this bites.
   *
   * The list of blocks is read out of the `NexusFullConfig` declaration rather
   * than written here, so a block added to the config interface fails this test
   * until `getSaveableConfig` mentions it. That is the only version of the check
   * that can notice a block nobody thought to list.
   *
   * KEPT VERBATIM from the panel test file, and it is the reason this file
   * replaces that one rather than simply deleting it: this is about the CONFIG
   * SURFACE, not about the panel, and it is the guard the panel's save path
   * needed too.
   */
  it('writes every block NexusFullConfig declares, so no block is dropped on save', async () => {
    const source = await readSourceFile('config')
    const declared = interfaceFieldNames(source, 'NexusFullConfig')
    expect(declared.length).toBeGreaterThan(0)

    const manager = new NexusConfigManager()
    const config = manager.getConfig()
    for (const block of declared) {
      expect(Object.hasOwn(config, block)).toBe(true)
    }

    // `getSaveableConfig` is private, so it is reached the way the product
    // reaches it: through the public save, by reading the file back. The file is
    // JSONC — `writeJsoncFile` writes a `//` header above the body — so the
    // header lines are dropped before parsing, which is all the comment syntax
    // this writer emits.
    const dir = mkdtempSync(join(tmpdir(), 'nexus-flow-save-'))
    const configManager = new NexusConfigManager()
    configManager.loadFromPath(dir)
    configManager.updateStorageConfig(config)
    configManager.saveProjectConfig(dir)

    const body = readFileSync(join(dir, '.opencode', 'nexus.jsonc'), 'utf-8')
      .split('\n')
      .filter(line => !line.trimStart().startsWith('//'))
      .join('\n')
    const written = JSON.parse(body) as Record<string, unknown>

    const missing = declared.filter(block => !Object.hasOwn(written, block))
    expect(missing).toEqual([])
  })

  /**
   * The flow hands the manager the WHOLE draft, never the changed paths, and this
   * is the test for why — a ROUND TRIP through the public save, not an assertion
   * about the draft's own keys.
   *
   * `updateStorageConfig` REPLACES the blocks it names with freshly built
   * literals, and for `selfHealing` it falls back to `DEFAULT_CONFIG` for three
   * of its four fields rather than to the project/global levels — so a call
   * mentioning only `budget` would pin `retryDelay` and the two toggles to their
   * defaults and shadow the user's `nexus.jsonc`. The test the previous version of
   * this file wanted to write could not catch that: it compared the draft's own
   * keys with the config's, which `configSaveUpdate` makes identical by
   * construction. Reading the FILE back is the only thing that can.
   */
  it('saves the whole draft, so an edit to one block cannot reset another', () => {
    const config = realConfig()
    // The user changed a budget ceiling and a backoff base in one visit.
    const staged = setConfigValue(config, ['budget', 'maxTotalCost'], 25)
    const withRetry = setConfigValue(staged, ['selfHealing', 'retryDelay'], 4321)

    const dir = mkdtempSync(join(tmpdir(), 'nexus-flow-draft-'))
    const manager = new NexusConfigManager()
    manager.loadFromPath(dir)
    manager.updateStorageConfig(configSaveUpdate(withRetry))
    manager.saveProjectConfig(dir)

    const body = readFileSync(join(dir, '.opencode', 'nexus.jsonc'), 'utf-8')
      .split('\n')
      .filter(line => !line.trimStart().startsWith('//'))
      .join('\n')
    const written = JSON.parse(body) as ConfigDraft

    // Both staged edits are on disk…
    expect(configValueAt(written, ['budget', 'maxTotalCost'])).toBe(25)
    expect(configValueAt(written, ['selfHealing', 'retryDelay'])).toBe(4321)
    // …and a key in a THIRD block that nobody touched is still the file's value,
    // not a default the writer rebuilt it from. `effort` is the one to check: it
    // is the block a parallel change added, and the omission this repository has
    // been bitten by twice.
    expect(configValueAt(written, ['effort', 'maxEffort'])).toBe(
      configValueAt(config, ['effort', 'maxEffort'])
    )
    expect(configValueAt(written, ['gitFlow', 'conventionalCommits'])).toBe(
      configValueAt(config, ['gitFlow', 'conventionalCommits'])
    )
  })
})

// ── The adapter, which no harness can drive ─────────────────────────
//
// There is no TUI harness in this repository, so `runConfigFlow` in
// `src/tui.tsx` is the one part of this feature no test can execute. Its
// decisions are all in this file and are tested above; what is left is whether
// the adapter ROUTES to them or quietly does its own thing beside them, and
// these are source-level guards for exactly that.
//
// `blankNonCode` blanks comments and string literals, so a match below is code
// and not a docstring describing code. That distinction is the whole reason the
// helper exists and the reason these assertions are not the grep-and-hope shape
// this repository has deleted twice: the words `parseFloat` and `ui.panel.open`
// appear in the file's PROSE and must not satisfy these tests.

describe('the config flow adapter in src/tui.tsx', () => {
  const source = async (): Promise<string> =>
    Bun.file(join(import.meta.dir, '..', 'src', 'tui.tsx')).text()

  /**
   * Comments blanked, STRING LITERALS KEPT.
   *
   * Two blankings, because there are two kinds of question and one of them is
   * invisible under the other. A guard that asks "is this identifier used in
   * code?" must blank strings, or the file's own prose about `parseFloat`
   * satisfies it. A guard that asks "is this string compared against?" must KEEP
   * them, or `=== 'scope'` is blanked to `=== '   '` and the question cannot be
   * asked at all — which is how the first version of this block failed, twice,
   * for reasons that had nothing to do with the code under test.
   */
  const withStrings = async (): Promise<string> => blankNonCode(await source(), false)

  /** Comments AND strings blanked: the right view for "is this identifier used in code?". */
  const codeOnly = async (): Promise<string> => blankNonCode(await source())

  /**
   * `runConfigFlow`'s body, by brace counting — and nothing else.
   *
   * SCOPED, and the first version of this was not. A file-wide "no `Number(`"
   * check fails on `handleWebDashboard`'s port parser, which is a different
   * feature, parses a port rather than a config value, and has its own tests. A
   * guard that fails for a reason no maintainer can act on gets deleted rather
   * than fixed, so the guard has to be about the code it names.
   */
  const flow = async (): Promise<string> => {
    const code = await withStrings()
    const start = code.indexOf('const runConfigFlow')
    expect(start).toBeGreaterThan(-1)
    const open = code.indexOf('{', start)
    return code.slice(start, matchBrace(code, open) + 1)
  }

  /**
   * The number fix, guarded at the layer the mutations could not reach.
   *
   * `parseConfigNumber` is tested directly, and a mutation of it is caught — but
   * a mutation that made the ADAPTER parse the number itself, with its own
   * `parseFloat` and no message, would pass every other test in this file. This
   * is the assertion that closes it, and it is worth having: it is exactly the
   * edit a future change would make while "just adding a field".
   */
  it('does not parse a number anywhere of its own', async () => {
    const code = await codeOnly()
    const body = await flow()
    expect(body).not.toContain('parseFloat')
    expect(body).not.toMatch(/\bNumber\s*\(/)
    // And it does go through the tested function, and writes through exactly one
    // call, so there is no second path to a value.
    expect(body).toContain('commitConfigText')
    expect(body.match(/setConfigValue\(/g)?.length).toBe(1)
  })

  it('reaches every config screen through the tested navigation, not its own', async () => {
    const body = await flow()
    expect(body).toContain('configScreenOptions')
    expect(body).toContain('configSelect')
    expect(body).toContain('configUp')
    // `editorFor` decides which widget a field opens. An adapter that switched on
    // `field.kind` itself would be a SECOND, untested answer to the same question
    // — and the one that matters, because that is the boolean/number/model split.
    // The other `kind` comparisons in here are on `screen.kind`, `chosen.kind` and
    // `commit.kind`, which are routing and contract checks rather than widget
    // choices, and they are left alone deliberately: counting them is what the
    // first version of this test did, and it counted six and meant nothing.
    expect(body).toContain('editorFor')
    expect(body).toMatch(/switch\s*\(\s*editorFor\(field\)\s*\)/)
    expect(body).not.toMatch(/field\.kind\s*===\s*'(boolean|number|model)'/)
    expect(body).not.toMatch(/field\.kind\s*===\s*"/)
  })

  /**
   * A rejected number is HANDLED, between the commit and the write.
   *
   * Added because a mutation made the adapter's `rejected` branch unreachable and
   * the whole suite stayed green — which is precisely the bug this feature exists
   * to not have, reintroduced through the one function no test can execute. The
   * guard is positional: `commitConfigText` produces the commit, the `rejected`
   * branch decides what happens to it, and only then does `stage` write. Moving
   * the write above the check, or deleting the check, fails here.
   *
   * WHAT THIS STILL CANNOT CATCH, stated rather than implied: a rejection
   * disabled by a condition no static reading can evaluate — `if (false)`, or a
   * flag a later edit sets. There is no TUI harness in this repository, so
   * "the adapter shows the error" is not executable here and this is the closest
   * honest approximation. What does hold it in place is the TYPE: `commit.message`
   * does not exist on the `accepted` or `dismissed` variants, so the alert body
   * cannot be written at all unless the branch is really reached.
   */
  it('handles a rejected commit before it can reach the draft', async () => {
    const body = await flow()
    const commit = body.indexOf('commitConfigText(field, typed)')
    const rejects = body.indexOf("if (commit.kind === 'rejected')")
    const alerts = body.indexOf('ui.dialog.alert')
    const stages = body.indexOf('stage(commit)')

    expect(commit).toBeGreaterThan(-1)
    expect(rejects).toBeGreaterThan(commit)
    expect(alerts).toBeGreaterThan(rejects)
    expect(stages).toBeGreaterThan(rejects)
    // `stage` refuses anything that is not `accepted`, so even a dropped
    // rejection cannot write; the alert is what makes it VISIBLE.
    expect(body).toMatch(/if \(commit\.kind !== 'accepted'\) return false/)
  })

  it('uses only the host dialogs, and no panel, a slot claim or a targeted keymap layer', async () => {
    const code = await codeOnly()
    // The three sanctioned widgets: two lists, a line of text, and a way to say
    // a value was refused.
    expect(code).toContain('ui.dialog.select')
    expect(code).toContain('ui.dialog.prompt')
    expect(code).toContain('ui.dialog.alert')
    // The panel route is gone for good, not merely unused. `ui.panel.open` and a
    // `session.panel` claim are the two things that made the configuration
    // surface need an open session, and both are what this revert removed. These
    // three are asserted over the WHOLE file, because a panel would be a
    // file-level fact and not a local one.
    expect(code).not.toContain('ui.panel.open')
    expect(code).not.toContain('session.panel')
    // The `app` slot's own keymap layer is still there — that is the command
    // layer, not the panel's — but nothing registers a TARGETED one any more,
    // which is the thing that used to claim `j` and `s` in a normal session.
    expect(code).not.toContain('keymap.layer(() => ({ target')
  })

  it('has exactly two write paths, and the flow\'s is the save branch', async () => {
    const code = await withStrings()
    // `persistConfig` is the only thing that writes a file. There are two call
    // sites and both are supposed to exist: `/nexus model <role>`, which has
    // always written immediately, and the flow's `save` branch. A THIRD call site
    // is a new write path, and a write path is the one thing in this feature that
    // can touch a user's file — so it fails here rather than being noticed later.
    expect(code.match(/persistConfig\(\)/g)?.length).toBe(2)
    expect(code).toMatch(/updateStorageConfig\(configSaveUpdate\(draft\)\)/)
    // …and the flow's is inside the branch the `save` outcome selects, BEFORE
    // the `close` branch, so "Close without saving" cannot reach it. A `return`
    // ends each branch, so the ordering is the whole argument: this is not a
    // count, it is a statement about which branch the write is in.
    const body = await flow()
    const save = body.indexOf("case 'save'")
    const close = body.indexOf("case 'close'")
    const write = body.indexOf('persistConfig()')
    expect(save).toBeGreaterThan(-1)
    expect(close).toBeGreaterThan(save)
    expect(write).toBeGreaterThan(save)
    expect(write).toBeLessThan(close)
  })
})
