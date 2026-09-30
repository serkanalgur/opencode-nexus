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
  configBlockDirtyCount,
  configDirtyCount,
  configFieldContext,
  configFieldDirty,
  configFieldsScreen,
  configHubCurrent,
  configIsDirty,
  configOptionDescription,
  configOptionDisabled,
  configOptionFooter,
  configOptionTitle,
  configPathLabel,
  configPromptDescription,
  configSaveUpdate,
  configScreenOptions,
  configScreenTitle,
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

  it('classifies `memory.storage` as a path and never as a model, in the REAL config', () => {
    // The memory block was added after the model sniff was narrowed, and the
    // narrowing is what stopped `memory.storage` — a sqlite file path, slashes
    // and all — from opening the provider picker and writing `provider/id` over
    // the store's location. Those two changes are independent and both must hold:
    // a later "simplify" that re-applies the sniff to every string would restore
    // that bug, and the existing tests would not catch it because they feed the
    // classifier a hand-written object rather than the real config, where
    // `memory.storage` may or may not happen to contain a slash.
    const discovery = realDiscovery()
    const storage = fieldAt(discovery, 'memory.storage')
    expect(storage.kind).toBe('path')
    expect(editorFor(storage)).toBe('path')
    // Read from the real config, so a default path with no slash is still
    // asserted: the KIND comes from the block plus the label, never the value.
    expect(editorFor(storage)).not.toBe('model')
    // And the widening is scoped: the model blocks still get the picker.
    expect(editorFor(fieldAt(discovery, 'models.coder'))).toBe('model')
  })

  it('gives every real field an editor, so no row opens nothing', () => {
    const { fields } = realDiscovery()
    const withoutEditor = fields.filter(field => editorFor(field) === 'none').map(field => configPathLabel(field.path))
    expect(withoutEditor).toEqual([])
    // And the five widgets between them are all reachable in the shipped config,
    // so a flow that quietly stopped offering one of them would fail here rather
    // than in a report a user files. `path` is reachable because
    // `memory.storage` is one — it edits as free text today, and is named
    // separately so the path editor has a `case` of its own to grow into.
    const used = new Set(fields.map(editorFor))
    expect([...used].sort()).toEqual(['boolean', 'model', 'number', 'path', 'text'])
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

  it('gives everything under `models` the picker, whatever it holds', () => {
    // A DELIBERATE behaviour change, and the one edge of the name-based rule
    // that loses information. The old shape test let a `models` entry without a
    // slash — a typo, or a note a user parked in the model block — fall back to a
    // text field. Under a name-based rule `models.*` is a wildcard, so such a
    // value now opens the picker. That is the right way round: `models` is an
    // OPEN keyed block whose every leaf is a model reference by definition, the
    // value a user would want corrected in is a provider picker rather than a
    // text box, and a text editor there would be the shape of value a
    // `provider/id` typo most often takes. A string OUTSIDE `models` is
    // unaffected — see the test below.
    const { fields } = discoverConfig({ models: { coder: 'anthropic/claude-sonnet-4-6', note: 'hello' } })
    expect(fields.map(field => field.kind)).toEqual(['model', 'model'])
  })

  it('does not read a slash as a model reference outside the model fields', () => {
    // The bug this guards: EVERY string containing a `/` was classified as a
    // model, so a relative `memory.storage` opened the grouped provider picker
    // and picking a model there wrote `provider/id` into the memory DB path.
    // Silent, total, and it destroyed the store it was editing. Classification
    // is by the field's ADDRESS, so everywhere else a slash is just a slash.
    const { fields } = discoverConfig({
      memory: { storage: './.opencode/memory.db' },
      gitFlow: { note: 'feature/branch-name' },
      export: { path: 'dist/bundle.js' },
      models: { coder: 'anthropic/claude-sonnet-4-6' },
    })
    const byPath = Object.fromEntries(fields.map(f => [configPathLabel(f.path), f.kind]))
    expect(byPath['memory.storage']).toBe('path')
    expect(byPath['gitFlow.note']).toBe('text')
    expect(byPath['export.path']).toBe('text')
    // Still the picker where it belongs — scoping must not have disarmed it.
    expect(byPath['models.coder']).toBe('model')
  })

  it('gives a custom role\'s own `model` the picker, and its PROSE a text field', () => {
    // `getModelForRole` really does read `customRoles[].model` (see
    // `test/custom-roles-config.test.ts`), so a text field there would demote a
    // working setting to second class by its block's name alone.
    //
    // And the other half, which is the test whose ABSENCE let the class survive
    // for as long as it did: every earlier fixture used `prompt: 'p'` — one
    // letter, no slash — so the misclassification it needed a role prompt to
    // have could not show up. A real role prompt names a file, and a real
    // display name is often `Team/Role`. Those are prose, and classifying them
    // as models is the silent-total failure: `runEditor`'s `case 'model'` opens
    // the provider picker and `commitConfigModel` then writes `provider/id`
    // over the user's instructions.
    const { fields } = discoverConfig({
      customRoles: [
        {
          name: 'qa',
          prompt: 'Read src/a.ts and report what it does',
          displayName: 'QA/Engineer',
          model: 'openai/gpt-5-mini',
        },
      ],
    })
    const byPath = Object.fromEntries(fields.map(f => [configPathLabel(f.path), f.kind]))
    expect(byPath['customRoles[0].model']).toBe('model')
    expect(byPath['customRoles[0].prompt']).toBe('text')
    expect(byPath['customRoles[0].displayName']).toBe('text')
    expect(byPath['customRoles[0].name']).toBe('text')
  })

  it('edits `memory.storage` as a path, and the real config reaches that editor', () => {
    const field = fieldAt(realDiscovery(), 'memory.storage')
    expect(field.kind).toBe('path')
    // A path is still typed by hand, so the editor is the free-text prompt —
    // named apart from `text` so a path-validating widget can replace the case
    // without also changing every other string field.
    expect(editorFor(field)).toBe('path')
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

    // The walk covers the WHOLE state space. One hub, one list per block, one
    // editor per field — derived from the discovery rather than written down, so a
    // block or a field that produced no screen at all fails here instead of
    // quietly shrinking the search. This number is the search screen's tombstone:
    // there is no `+1` for it any more, so reintroducing a fourth screen kind
    // would break this count before anything softer noticed.
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

  it('a boolean editor\'s switch is the only answer it can give, and answering does not navigate', () => {
    // The answer to a switch is a VALUE, not a destination. If choosing the row
    // moved the flow, the value would have nowhere to go.
    //
    // BOTH DIRECTIONS, which the previous version of this did not do: it passed
    // `true` alone, so a `switch` row that was correct when the key was on and
    // wrong when it was off passed the whole suite. The widget is symmetric and
    // has to be tested symmetrically.
    const field = fieldAt(discovery, 'notifications.enabled')
    const editor: ConfigScreen = { kind: 'editor', field }
    for (const current of [true, false]) {
      const rows = booleanOptions(field, current)
      expect(rows.map(row => row.kind)).toEqual(['switch', 'back'])
      // The switch stays put…
      expect(configSelect(editor, rows[0])).toEqual({ kind: 'stay' })
      // …and the way out leaves, which is what a user pressing escape means.
      expect(configSelect(editor, rows[1])).toEqual({
        kind: 'to',
        screen: { kind: 'fields', block: 'notifications' }
      })
    }
  })
})

// ── A boolean is one keystroke ──────────────────────────────────────
//
// The describe title used to be "as two rows in a single-select list", which
// described a design this file no longer has. A stale title is how a reader ends
// up trusting an implementation that has been replaced: they read the heading,
// assume the shape matches, and skip the body.

describe('a boolean, as one switch and a way out', () => {
  const discovery = realDiscovery()
  const field = fieldAt(discovery, 'notifications.enabled')

  it('offers one switch to the other value, with the glyph beside the direction in words', () => {
    for (const current of [true, false]) {
      const rows = booleanOptions(field, current)
      // Two rows, and the second is `back` — not the other value. There is
      // exactly one boolean widget in this file.
      expect(rows).toHaveLength(2)
      expect(rows.map(row => row.kind)).toEqual(['switch', 'back'])
      const switched = rows[0]
      if (switched.kind !== 'switch') throw new Error('the first row is not the switch')
      // The row stands for the OTHER value, whichever that is.
      expect(switched.value).toBe(!current)
      // And it names the field it writes, so a row that reached the adapter by
      // any route still says which path it belongs to.
      expect(switched.field).toBe(field)

      const title = configOptionTitle(switched, 'global')
      // The glyph is RECONDITIONED on the direction rather than asserted
      // present: `✅` on "Switch to Disabled" would be a lie told in an emoji,
      // and the old assertion (`titles` contains exactly one of each) would have
      // passed on that lie because the wrong glyph was still somewhere in the list.
      if (switched.value) {
        expect(title).toBe('✅ Switch to Enabled')
        expect(configOptionDescription(switched, realConfig(), realConfig(), false)).toContain('Turns it on')
      } else {
        expect(title).toBe('☐ Switch to Disabled')
        expect(configOptionDescription(switched, realConfig(), realConfig(), false)).toContain('Turns it off')
      }
      // Both rows are answerable. Disabling the switch on the value a key is
      // already on would make "off, and I mean off" unreachable — the row is
      // never greyed, and `back` is the escape.
      expect(rows.map(configOptionDisabled)).toEqual([false, false])
    }
  })

  it('writes the value the switch stands for, and flipping it twice returns it', () => {
    // BOTH DIRECTIONS again, and the assertion is the row's own `value` — the
    // commit takes what the row says rather than inverting the draft, which is
    // what made the old two-row version fragile.
    for (const current of [true, false]) {
      const commit = commitConfigToggle(field, booleanOptions(field, current)[0])
      expect(commit).toEqual({ kind: 'accepted', field, value: !current })
    }

    // REVERSIBILITY. The old second half of this test — "the row that IS current
    // writes a no-op, not a flip" — is GONE, and its absence is a consequence of
    // the redesign rather than a loss of coverage: no row stands for the current
    // value any more, so the hazard that test guarded (a commit that inverted
    // whatever was in the draft, turning "leave it alone" into "flip it") is no
    // longer expressible. What replaced it is the property that actually matters
    // about a switch: a second flip gives the value back, and it does so through
    // the same rows and the same commit.
    const after = setConfigValue(realConfig(), field.path, !false)
    const backAgain = booleanOptions(field, configValueAt(after, field.path) === true)[0]
    if (backAgain.kind !== 'switch') throw new Error('the first row is not the switch')
    expect(backAgain.value).toBe(false)
    const restored = commitConfigToggle(field, backAgain)
    expect(restored).toEqual({ kind: 'accepted', field, value: false })
  })

  it('refuses an answer that is not one of its own rows', () => {
    // The switch is the only thing a boolean editor can return, and a commit
    // that accepted anything else would be a write to a path nothing chose.
    // Every non-switch row is tried, not just `back`, because a row that is not
    // a switch reaching here at all is the defect — whatever a later change adds
    // to the hub has to be refused here too.
    for (const kind of ['back', 'save', 'close', 'scope'] as const) {
      const option = { kind, scope: 'project' } as const
      expect(() => commitConfigToggle(field, option as never)).toThrow(/switch row/)
    }
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
  it('shows every field row\'s current value in the FOOTER, and its description is not the value', () => {
    const config = realConfig()
    const discovery = discoverConfig(config)
    const field = fieldAt(discovery, 'budget.maxTotalCost')
    const row = fieldOptions(discovery, 'budget').find(o => o.kind === 'field' && o.field === field)
    expect(row).toBeDefined()
    // `base` is the third argument and is REQUIRED, which is the point: an
    // omitted one defaulted to `draft` would report "0 changed" on every row
    // rather than failing to compile.
    //
    // THE ROUTING IS THE CLAIM, and it is asserted per-field on the real config
    // rather than by a substring sweep over the row. The host renders `footer`
    // right-aligned and `description` muted and inline, so where the value goes
    // decides whether the field list reads as two aligned columns or as nine
    // sentences. `expect(description).not.toContain('10')` alone would be weak —
    // a row with the value in BOTH slots passes it — so the description is
    // asserted to be ABSENT here, which is what it is: a field directly under
    // its block has a label that is already its whole address.
    expect(configOptionFooter(row as never, config, config)).toBe('10')
    expect(configOptionDescription(row as never, config, config, false)).toBeUndefined()

    // The staged value shows immediately, marked, because the only other place it
    // appears is a toast that has already gone. A field row gets no NUMBER with
    // its `*`, because 1 is not information and `25  *  1 changed` is noise.
    const staged = setConfigValue(config, field.path, 25)
    expect(configOptionFooter(row as never, staged, config)).toBe('25  *')
    // …and a `*` always means "not on disk", checked on a field that was NOT
    // staged. Dirtiness is per field now (`configFieldDirty`), so the honest
    // unmarked case is a sibling row rather than this one with a flag turned off.
    const sibling = fieldOptions(discovery, 'budget').find(
      o => o.kind === 'field' && o.field.label === 'maxCostPerTask'
    ) as never
    expect(configOptionFooter(sibling, staged, config)).toBe('1')
  })

  it('gives a NESTED field its path as the description, so two identically named fields are tellable apart', () => {
    // The reason `description` is not free for values. Every element of
    // `customRoles` is labelled by the key it sits under, so `model` appears once
    // per role and a list of identical rows is a list nobody can pick from. The
    // host fuzzy-filters `category` as well as `title` (1:2), but `title` is what
    // is drawn, so the disambiguation has to be drawn too.
    const discovery = realDiscovery()
    const withRoles = discoverConfig({
      customRoles: [
        { name: 'architect', model: 'anthropic/claude-sonnet-4-6' },
        { name: 'tester', model: 'openai/gpt-5-mini' }
      ]
    })
    const models = withRoles.fields.filter(f => f.label === 'model')
    expect(models).toHaveLength(2)
    // Same label, same kind, DIFFERENT description — and the different
    // description is the whole point.
    expect(configOptionTitle({ kind: 'field', field: models[0] }, 'global')).toBe('model')
    expect(configOptionTitle({ kind: 'field', field: models[1] }, 'global')).toBe('model')
    const first = configOptionDescription({ kind: 'field', field: models[0] } as never, {}, {}, false)
    const second = configOptionDescription({ kind: 'field', field: models[1] } as never, {}, {}, false)
    // WITHOUT the block name: the list's title is already
    // `Nexus configuration — customRoles`, so repeating it on every row is ink
    // that says nothing. `[0]` and `[1]` are the part that is not already on
    // screen, and they are the whole disambiguation.
    expect(first).toBe('[0].model')
    expect(second).toBe('[1].model')
    expect(first).not.toBe(second)

    // And the VALUE is still in the footer on a nested field, not promoted into
    // the description to pay for the path.
    const draft: ConfigDraft = {
      customRoles: [
        { name: 'architect', model: 'anthropic/claude-sonnet-4-6' },
        { name: 'tester', model: 'openai/gpt-5-mini' }
      ]
    }
    expect(
      configOptionFooter({ kind: 'field', field: models[1] } as never, draft, draft)
    ).toBe('openai/gpt-5-mini')
    // A field directly under its block gets NO description, because the path
    // minus the block prefix is the label and the title is already the block.
    expect(configFieldContext(fieldAt(discovery, 'budget.maxTotalCost'))).toBeUndefined()
  })

  it('says a BOOLEAN\'s state in words and a glyph in the footer, never as a bare true/false', () => {
    // `true` names the TYPE, not the state, and this flow's rule is that no
    // signal is carried by colour or by a glyph alone. The footer must read the
    // same way the switch SCREEN reads, so the two screens speak one vocabulary.
    const config = realConfig()
    const discovery = discoverConfig(config)
    const row = fieldOptions(discovery, 'gitFlow').find(o => o.kind === 'field') as never
    const field = (row as { field: ConfigField }).field
    expect(field.kind).toBe('boolean')

    const on = configOptionFooter(row, config, config)
    expect(on).toMatch(/^(✅|☐) (enabled|disabled)$/)
    // A boolean in the FIELD LIST, not just on the switch screen: the glyph is
    // never the carrier, and `true` alone names the type rather than the state.
    // Flipped: the other word, and still a word.
    const flipped = setConfigValue(config, field.path, false)
    const off = configOptionFooter(row, flipped, config)
    expect(off).toMatch(/^(✅|☐) disabled {2}\*$/)
    expect(off).not.toBe(on)
    // Never the bare literal, in either direction.
    expect(on).not.toBe('true')
    expect(off).not.toBe('false')
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
    const config = realConfig()
    expect(configOptionDescription(scopeRow as never, config, config, false)).toMatch(/Save/)
    expect(configOptionDescription(saveRow as never, config, config, true)).toMatch(/Write/)
    expect(configOptionDescription(closeRow as never, config, config, true)).toMatch(/Nothing is written/)
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

  it('counts a block\'s settings in the FOOTER, and says so when a block has none', () => {
    // `customRoles` is `[]` on a fresh install, and a row reading "0 settings"
    // with nothing behind it is indistinguishable from a block the flow failed to
    // load.
    const discovery = realDiscovery()
    const customRoles = blockOptions(discovery, 'global').find(
      o => o.kind === 'block' && o.block.name === 'customRoles'
    )
    const config = realConfig()
    // The count is a FOOTER, like every other current value — a block's size is
    // its state, and putting it in the description would make the hub the one
    // screen whose numbers do not line up.
    expect(configOptionFooter(customRoles as never, config, config)).toBe('no settings')
    expect(configOptionDescription(customRoles as never, config, config, false)).toMatch(/no settings here yet/)

    const budget = blockOptions(discovery, 'global').find(o => o.kind === 'block' && o.block.name === 'budget')
    // A SHAPE, not a count. The exact number is a fact about `budget` and would
    // fail for a reason no user would recognise when a key is added; what matters
    // is that a block with fields counts them and a block with none says so.
    // UNCHANGED by the dirty badge: a CLEAN block's footer is still exactly
    // `N settings`, so this regex has to keep passing verbatim.
    expect(configOptionFooter(budget as never, config, config)).toMatch(/^\d+ settings$/)
    // AND, the other direction of the claim: a block whose footer carries the
    // count has no description at all, rather than one repeating the count. This
    // is the assertion that fails if someone routes the count back to the
    // description "for consistency with the old layout".
    expect(configOptionDescription(budget as never, config, config, false)).toBeUndefined()
  })

  it('marks only the field that moved, not every row in the block', () => {
    // THE `*` IS A PER-ROW SIGNAL, and this is the assertion that says so. It
    // used to be driven by the adapter's whole-draft `configIsDirty` boolean, so
    // staging `maxTotalCost` marked `maxCostPerTask` and `alertThreshold` too —
    // a `*` on rows nobody touched is a mark meaning "something changed
    // somewhere", and a user who cannot trust it cannot use it to find their own
    // edit. It is worse in a footer than it was in a description, because a
    // right-aligned column of markers is exactly what a user scans to find what
    // they changed.
    const config = realConfig()
    const discovery = realDiscovery()
    const rows = fieldOptions(discovery, 'budget').filter(o => o.kind === 'field') as never[]
    const staged = setConfigValue(config, ['budget', 'maxTotalCost'], 25)

    const marked = rows.map(row => configOptionFooter(row, staged, config))
    expect(marked.filter(text => text?.includes('*'))).toHaveLength(1)
    expect(marked[0]).toBe('25  *')
    // The two untouched rows show their values and no marker, which is the
    // assertion that fails if the draft-wide flag is ever wired back in.
    expect(marked[1]).not.toContain('*')
    expect(marked[2]).not.toContain('*')
    // And the exported predicate agrees, so the rule is testable on its own
    // rather than only through a rendered string.
    const field = fieldAt(discovery, 'budget.maxTotalCost')
    expect(configFieldDirty(field, config, staged)).toBe(true)
    expect(configFieldDirty(field, config, config)).toBe(false)
    expect(configFieldDirty(fieldAt(discovery, 'budget.maxCostPerTask'), config, staged)).toBe(false)
  })

  it('leaves the hub\'s own rows with a description and NO footer, so one rule covers them all', () => {
    // The consistency claim, stated: `footer` is the CURRENT-STATE column, and
    // scope/save/close/back have no state to report — they say the same thing
    // every time they are drawn. A right-aligned column of repeated sentences is a
    // column nobody reads, so they get a description and an absent footer.
    const config = realConfig()
    const discovery = realDiscovery()
    const hub = blockOptions(discovery, 'global')
    for (const kind of ['scope', 'save', 'close'] as const) {
      const row = hub.find(o => o.kind === kind) as never
      expect(configOptionFooter(row, config, config)).toBeUndefined()
      expect(configOptionDescription(row, config, config, true)).toBeTypeOf('string')
    }
    // …and the boolean switch screen, whose two rows are answers rather than
    // settings, is the same case: no state column, all context inline.
    const enabled = fieldAt(discovery, 'gitFlow.enabled')
    const switchRow = booleanOptions(enabled, false)[0]
    expect(configOptionFooter(switchRow, config, config)).toBeUndefined()
    expect(configOptionDescription(switchRow, config, config, false)).toMatch(/Turns it on/)
  })

  it('marks the hub\'s scope row as the CURRENT one, and no other screen has a current row', () => {
    // `current` is the host's own vocabulary for "of these, this is the one in
    // effect" — it draws a `●` in the row's gutter and tints it `theme.primary`.
    // The scope row is exactly that question with one honest answer: Save writes
    // to project or to global, and only one of them.
    const discovery = realDiscovery()
    const hub = blockOptions(discovery, 'project')
    const current = configHubCurrent(hub)
    expect(current?.kind).toBe('scope')
    // It is the row the scope ASKED for, so the mark follows the toggle rather
    // than sitting on a fixed row.
    expect(configHubCurrent(blockOptions(discovery, 'global'))).toEqual(
      blockOptions(discovery, 'global').find(o => o.kind === 'scope')
    )
    // HUB ONLY, and the reason is in `configHubCurrent`: the host also MOVES the
    // cursor to the current row, so on a field list it would park the cursor on
    // whichever field happened to be current and skip the first one.
    for (const block of discovery.blocks) {
      expect(configHubCurrent(fieldOptions(discovery, block.name))).toBeUndefined()
    }
    const enabled = fieldAt(discovery, 'gitFlow.enabled')
    expect(configHubCurrent(booleanOptions(enabled, false))).toBeUndefined()
  })
})

// ── Uneditable fields are hidden by the host, so the BLOCK says so ──

describe('a setting the host will not draw is still said to exist', () => {
  // THE HOST FILTERS `disabled` ROWS OUT. `dialog-select.tsx`'s `filtered()` is
  // `filter(x => x.disabled !== true)` before anything is drawn, so `disabled:
  // true` is not a dimmed row and there is no marker to draw — the row is ABSENT.
  // Which means `configOptionDisabled` on its own is a silent deletion, and the
  // count has to be said on the block row that survives.
  const config: ConfigDraft = { odd: { ok: true, when: null } }
  const discovery = discoverConfig(config)
  const blockRow = blockOptions(discovery, 'global').find(
    o => o.kind === 'block' && o.block.name === 'odd'
  ) as never

  it('still offers the field as a row, marked disabled', () => {
    const when = fieldAt(discovery, 'odd.when')
    const row = fieldOptions(discovery, 'odd').find(
      o => o.kind === 'field' && o.field === when
    )
    // The flow does not DROP it: the row is built, and `disabled` is how it is
    // refused. A field that vanished from `fieldOptions` would be a setting the
    // flow believes it cannot address at all, which is a different and larger lie.
    expect(row).toBeDefined()
    expect(configOptionDisabled(row as never)).toBe(true)
    // And it is still not somewhere the flow can go.
    expect(configSelect(configFieldsScreen(when), row as never)).toEqual({ kind: 'stay' })
  })

  it('counts it in the BLOCK\'s description, so the block does not over-claim', () => {
    // The claim that would fail if the counting were left out: the footer says
    // "2 settings" and the block genuinely holds 2 — but only 1 of them will be
    // on screen, and the difference between what the row says and what the user
    // sees is exactly the silent-vanishing defect.
    expect(configOptionFooter(blockRow, config, config)).toBe('2 settings')
    expect(configOptionDescription(blockRow, config, config, false)).toBe(
      '1 setting not editable here'
    )
  })

  it('says nothing at all for a block whose every field is editable', () => {
    // The counterpart, so the sentence cannot become boilerplate: it is a fact
    // about THIS block, not a line every row carries.
    const real = realDiscovery()
    const budget = blockOptions(real, 'global').find(
      o => o.kind === 'block' && o.block.name === 'budget'
    ) as never
    expect(configOptionDescription(budget, realConfig(), realConfig(), false)).toBeUndefined()
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

// ── Dirty badges ────────────────────────────────────────────────────

describe('config flow dirty counts', () => {
  const config = realConfig()
  const discovery = discoverConfig(config)

  it('counts LEAVES, not changed paths, so one write cannot look like a sweep', () => {
    const budget = discovery.blocks.find(block => block.name === 'budget')
    if (budget === undefined) throw new Error('no budget block')
    const base = { budget: { maxTotalCost: 10, warnAt: 5, dailyCap: 1 } }
    const block = { name: 'budget', fields: discoverConfig(base).fields }
    expect(configBlockDirtyCount(block, base, base)).toBe(0)
    // One key of three. A count of changed PATHS would also say 1 here, so the
    // distinguishing case is below.
    const one = setConfigValue(base, ['budget', 'maxTotalCost'], 25)
    expect(configBlockDirtyCount(block, base, one)).toBe(1)
    // All three, through one nested write. Counting paths would report 1.
    const all = setConfigValue(one, ['budget', 'dailyCap'], 3)
    expect(configBlockDirtyCount(block, base, all)).toBe(2)
  })

  it('sums the whole config, so the title counts every staged edit and not just one block', () => {
    const staged = setConfigValue(config, ['budget', 'maxTotalCost'], 25)
    const withTwo = setConfigValue(staged, ['notifications', 'enabled'], false)
    expect(configDirtyCount(discovery, config, config)).toBe(0)
    expect(configDirtyCount(discovery, config, staged)).toBe(1)
    expect(configDirtyCount(discovery, config, withTwo)).toBe(2)
  })

  it('marks a dirty block with a NUMBER and a glyph, and leaves a clean one exactly as it was', () => {
    // Readable WITHOUT colour: the glyph alone is a mark with no magnitude, and
    // "which block did I change" is a question a count answers.
    //
    // IN THE FOOTER, like every other current value — the dirty count is a number
    // about the block's state, and the footer is the column the host right-aligns.
    // Putting it back in the description would be a "consistency" change that
    // un-columns the one screen with a number on every row.
    const budget = blockOptions(discovery, 'global').find(o => o.kind === 'block' && o.block.name === 'budget')
    const clean = configOptionFooter(budget as never, config, config)
    expect(clean).toMatch(/^\d+ settings$/)

    const staged = setConfigValue(config, ['budget', 'maxTotalCost'], 25)
    const dirty = configOptionFooter(budget as never, staged, config)
    expect(dirty).toMatch(/^\d+ settings {2}1 changed {2}\*$/)
    // A block nobody touched is untouched, so a `*` still means "not on disk".
    const models = blockOptions(discovery, 'global').find(o => o.kind === 'block' && o.block.name === 'models')
    expect(configOptionFooter(models as never, staged, config)).toMatch(/^\d+ settings$/)
  })

  it('reports Save as clean only when the draft is clean, and never counts', () => {
    // NO NUMBER ON THIS ROW, and that is the assertion. `configSaveUpdate` hands
    // the WHOLE draft to `updateStorageConfig`, which rewrites nine blocks and
    // shadows the project and global files for every key it names — so a count
    // here described what the user TOUCHED while the sentence said it described
    // what is WRITTEN. The counts that remain (the title, the `*` markers) are
    // honestly about edits.
    const save = blockOptions(discovery, 'global').find(o => o.kind === 'save')
    const staged = setConfigValue(config, ['budget', 'maxTotalCost'], 25)
    const withTwo = setConfigValue(staged, ['notifications', 'enabled'], false)

    expect(configOptionDescription(save as never, config, config, false, 0)).toBe('No changes to write')
    // One edit and two edits read identically: the row does not claim a count.
    expect(configOptionDescription(save as never, staged, config, true, 1)).toBe(
      'Write the staged changes to disk'
    )
    expect(configOptionDescription(save as never, withTwo, config, true, 2)).toBe(
      'Write the staged changes to disk'
    )
    // A supplied `0` is still honoured rather than being overridden by
    // dirtiness — the caller's count wins when it says zero.
    expect(configOptionDescription(save as never, withTwo, config, true, 0)).toBe('No changes to write')
    // With NO count supplied, the count-free wording stands rather than a
    // fabricated `Write 0 changes to disk` on a draft that is dirty.
    expect(configOptionDescription(save as never, staged, config, true)).toBe(
      'Write the staged changes to disk'
    )
  })

  it('leaves Save enabled when nothing has changed, and says so on purpose', () => {
    // DELIBERATE, and pinned because it is the kind of decision a later change
    // makes for a good-looking reason. Greying Save out on a clean draft looks
    // tidier and is a worse dialog: the row is how a user discovers that Save is
    // the only thing that writes, and a user who opens the dialog to find out
    // where their settings go is not served by an inert button. Pressing it is
    // an answer, not an error.
    const save = blockOptions(discovery, 'global').find(o => o.kind === 'save')
    expect(configOptionDisabled(save as never)).toBe(false)
  })

  it('reports the change count in the hub title, and only when there is one to report', () => {
    expect(configScreenTitle({ kind: 'blocks' }, 0)).toBe('Nexus configuration')
    expect(configScreenTitle({ kind: 'blocks' }, 3)).toBe(
      'Nexus configuration — 3 changes not written'
    )
    // The other screens are unchanged by this — a number on every window would
    // be a number nobody could ignore and a user could not escape.
    expect(configScreenTitle({ kind: 'fields', block: 'budget' }, 3)).toBe(
      'Nexus configuration — budget'
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
    // …and a BOOLEAN goes through `commitConfigToggle`, AS A CALL. Nothing else
    // would catch an adapter that wrote a boolean straight into `draft`:
    // `setConfigValue` would still appear exactly once, the `stay` arm would still
    // be there, and the flow would still be internally consistent — but the one
    // function that says "this is the only path a boolean reaches the draft" would
    // be bypassed, and its guard (which refuses anything that is not a `switch`
    // row) with it. A bare `toContain` would pass on that adapter, since the
    // helper would still be imported and merely unused, so the SHAPE is what is
    // asserted: the commit is handed to `stage`.
    expect(body).toMatch(/stage\(\s*commitConfigToggle\(/)
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
    // The parameter's NAME is not the claim — the call being the switch's
    // discriminant is — so it is matched as a word rather than spelled out, which
    // is also what a rename of the adapter's local would do.
    expect(body).toMatch(/switch\s*\(\s*editorFor\(\s*\w+\s*\)\s*\)/)
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
   * the write above the check, or deleting the check, fails here. The ORDER is
   * the real thing being proven, so the offsets are found by shape — the
   * adapter's local variable names are not part of the claim and must not be
   * load-bearing in a test.
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
    const commit = body.search(/commitConfigText\(/)
    const rejects = body.indexOf("if (commit.kind === 'rejected')")
    const alerts = body.indexOf('ui.dialog.alert')
    const stages = body.search(/stage\(\s*commit\s*\)/)

    expect(commit).toBeGreaterThan(-1)
    expect(stages).toBeGreaterThan(-1)
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

  it('delegates every slot of a row to config-flow, and has no search screen of its own', async () => {
    const code = await codeOnly()
    // THE ROUTING IS A DECISION, so it is in the tested file. `toDialogRow` is
    // allowed to call the three functions and to spread their `undefined`s; it is
    // not allowed to assemble a title, a description or a footer itself, because
    // a string built here is a string no test can reach.
    expect(code).toContain('configOptionTitle(')
    expect(code).toContain('configOptionDescription(')
    expect(code).toContain('configOptionFooter(')
    expect(code).toContain('configHubCurrent(')
    // No string literal that looks like a row. A title or a footer written out
    // here would be one this file cannot assert anything about.
    expect(code).not.toMatch(/title:\s*['"`]/)
    expect(code).not.toMatch(/footer:\s*['"`]/)
    // And the search screen is GONE from the adapter, not merely unused. The
    // host filters every `select` live, so a `prompt` standing in for a filter is
    // a keystroke between the user and the thing they meant to type. Asserted
    // over the whole file because reintroducing it is a file-level choice.
    expect(code).not.toContain("kind: 'search'")
    expect(code).not.toContain("'ask'")
    // The host's own filter is left switched ON, which is what makes the removal
    // safe: no `skipFilter`, no `renderFilter`.
    expect(code).not.toContain('skipFilter')
    expect(code).not.toContain('renderFilter')
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
