import { describe, it, expect, afterAll, mock } from 'bun:test'
import * as realOs from 'node:os'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { blankNonCode, interfaceFieldNames, readSourceFile } from './helpers/dashboard-page'

// `NexusConfigManager`'s constructor seeds from `homedir()`, so the module is
// sandboxed rather than the environment — the same pattern, and the same
// reason, as `test/config-knobs.test.ts`. A REAL temp dir, because CI is
// ubuntu and a home-relative fixture has shipped a test that passed on darwin
// and failed on both ubuntu legs.
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'nexus-panel-'))
mock.module('node:os', () => ({ ...realOs, default: realOs, homedir: () => SANDBOX_HOME }))

const { NexusConfigManager } = await import('../src/config')
const {
  PANEL_BINDINGS,
  applyPanelChoice,
  applyPanelKey,
  createPanelState,
  discoverPanel,
  panelIsDirty,
  panelRows,
  panelSaveUpdate,
  panelValueAt,
  panelWindow,
  panelKeyBuffer,
  panelLayerSpec,
  parsePanelNumber,
  setPanelValue,
  stateRows,
  PANEL_FOOTER_HINTS
} = await import('../src/config-panel')

// Types are erased, so they are imported statically even though the values
// above have to be awaited (the `node:os` mock must be in place first).
import type { PanelDraft, PanelKey, PanelState } from '../src/config-panel'

afterAll(() => {
  mock.module('node:os', () => realOs)
})

// ── Fixtures ────────────────────────────────────────────────────────

/** The real merged config — the panel's actual input, not a hand-written one. */
function realConfig(): PanelDraft {
  return new NexusConfigManager().getConfig() as unknown as PanelDraft
}

/** A key, with only the fields a test means to vary. */
function key(name: string, modifiers: { ctrl?: boolean; shift?: boolean } = {}): PanelKey {
  return { name, ctrl: modifiers.ctrl ?? false, shift: modifiers.shift ?? false }
}

/** Press a sequence of keys, collecting the effect of each. */
function press(state: PanelState, ...keys: PanelKey[]): { state: PanelState; effects: unknown[] } {
  let current = state
  const effects: unknown[] = []
  for (const k of keys) {
    const outcome = applyPanelKey(current, k)
    current = outcome.state
    if (outcome.effect !== undefined) effects.push(outcome.effect)
  }
  return { state: current, effects }
}

/**
 * Move the cursor onto a row and return that state.
 *
 * BY INDEX, never by label: `label` is not a unique address. Five blocks each
 * have a field called `enabled` (and the parallel effort change added a sixth),
 * so `focusRow(state, 'enabled')` would land on `selfHealing.enabled` and a test
 * asserting on `dashboard.enabled` would pass for the wrong reason — or fail
 * confusingly. Taking the index the test already found makes the address
 * explicit.
 */
function focusRow(state: PanelState, index: number): PanelState {
  const rows = stateRows(state)
  expect(index).toBeGreaterThanOrEqual(0)
  expect(index).toBeLessThan(rows.length)
  let current = state
  while (current.cursor !== index) {
    const next = applyPanelKey(current, key('down')).state
    expect(next.cursor).not.toBe(current.cursor)
    current = next
  }
  return current
}

/** The index of the first row whose path spells out `dotted`. */
function indexOfPath(state: PanelState, dotted: string): number {
  return stateRows(state).findIndex(row => row.path.join('.') === dotted)
}

/**
 * A state's identity, for the state-space search.
 *
 * THE DRAFT IS DELIBERATELY NOT IN IT, and the omission is sound rather than
 * convenient: no transition in the reducer is gated on a draft VALUE. The draft
 * is read in exactly two places — seeding the edit buffer from the row's current
 * value, and inverting a boolean — and neither can change WHERE the cursor can
 * get to or which mode it can be in. The one thing a draft does affect is
 * whether `escape` prompts or closes, and that IS in the key, as `dirty`.
 *
 * Including it would multiply the space by every combination of every boolean
 * and number in the config — tens of thousands of states — and buy nothing: the
 * question being asked is which rows the cursor can reach, not which values the
 * config can take.
 */
function stateKey(state: PanelState): string {
  return JSON.stringify([
    state.scope,
    state.mode,
    state.cursor,
    state.closed,
    panelIsDirty(state)
  ])
}

/**
 * Every state reachable from `initial` by pressing keys from `keys`.
 *
 * Breadth-first, so the set is genuinely closed under the key set and the answer
 * does not depend on the order the keys happen to be tried in. The cap is a
 * backstop against a state space that grew unexpectedly: it is asserted on, so
 * a search that stopped early is a FAILURE rather than a smaller answer that
 * happens to look like success.
 */
function reachable(initial: PanelState, keys: readonly PanelKey[], cap = 20000): PanelState[] {
  const seen = new Map<string, PanelState>([[stateKey(initial), initial]])
  const queue: PanelState[] = [initial]
  while (queue.length > 0) {
    const current = queue.shift() as PanelState
    for (const k of keys) {
      const next = applyPanelKey(current, k).state
      const id = stateKey(next)
      if (seen.has(id)) continue
      seen.set(id, next)
      queue.push(next)
      if (seen.size > cap) {
        throw new Error(`panel state space exceeded ${cap} states — the search stopped early`)
      }
    }
  }
  return [...seen.values()]
}

const PANEL_KEYS = PANEL_BINDINGS.map(binding => binding.key)

// ── Discovery ───────────────────────────────────────────────────────

describe('config panel discovery', () => {
  it('finds a block for every key the config actually has, with no list of its own', async () => {
    const config = realConfig()
    const { blocks } = discoverPanel(config)
    // Derived from the config object, not restated: a block added to
    // `NexusFullConfig` appears here without this test being edited.
    expect(blocks.map(block => block.name).sort()).toEqual(Object.keys(config).sort())
  })

  it('reaches every leaf value in the config, so no key can go missing', () => {
    const config = realConfig()
    const rows = panelRows(config)
    const addressed = new Set(rows.map(row => row.path.join('.')))

    // Walk the config independently of the panel's own walker, and collect every
    // primitive leaf. A leaf the panel does not address is a control the user
    // cannot find.
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

    expect(leaves.filter(leaf => !addressed.has(leaf))).toEqual([])
    expect(leaves.length).toBeGreaterThan(0)
  })

  it('produces no row it cannot explain — every real value gets a real widget', () => {
    const { readonlyRows } = discoverPanel(realConfig())
    // The only non-editable rows allowed are array HEADERS, which are cursor
    // stops that expand into their entries' own editable rows. A single
    // `opaque` row here would be a value shown in the panel with no way to
    // change it, which is the failure this whole file is built to prevent.
    expect(readonlyRows.filter(row => !row.reason.startsWith('array header'))).toEqual([])
  })

  it('shows a block the panel was never told about, without any edit to the panel', () => {
    // Stands in for the effort block a parallel change may add: a name and a
    // shape this file contains no mention of, dropped into the config.
    const withNewBlock = { ...realConfig(), effort: { level: 'high', escalate: true, cap: 3 } }
    const { blocks, rows } = discoverPanel(withNewBlock)
    const effort = blocks.find(block => block.name === 'effort')

    expect(effort).toBeDefined()
    expect(rows.filter(row => row.block === 'effort').map(row => row.kind).sort()).toEqual([
      'boolean',
      'number',
      'text'
    ])
  })

  it('reports a value it has no editor for, rather than hiding it', () => {
    // `null` is a value with no widget here. It still gets a row, and the row is
    // reported, so a new key of a shape nobody anticipated fails a test instead
    // of arriving in the panel as a value nobody can change.
    const { rows, readonlyRows } = discoverPanel({ odd: { when: null, ok: true } })
    expect(rows.map(row => row.label)).toEqual(['when', 'ok'])
    expect(rows[0]?.kind).toBe('opaque')
    expect(rows[0]?.editable).toBe(false)
    expect(rows[1]?.kind).toBe('boolean')
    expect(readonlyRows).toEqual([
      { label: 'when', reason: 'no editor for a value of this type — shown so it cannot go missing, not editable here' }
    ])
  })

  it('gives a model reference the picker and a plain string the text field', () => {
    const { rows } = discoverPanel({ models: { coder: 'anthropic/claude-sonnet-4-6', note: 'hello' } })
    expect(rows.map(row => row.kind)).toEqual(['model', 'text'])
  })
})

// ── The binding table ───────────────────────────────────────────────

describe('config panel binding table', () => {
  it('binds every key exactly once', () => {
    const ids = PANEL_BINDINGS.map(binding => binding.id)
    const keys = PANEL_BINDINGS.map(binding => `${binding.key.name}:${binding.key.ctrl}:${binding.key.shift}`)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('is live in at least one mode, and only in real modes', () => {
    const modes = ['browse', 'edit', 'discard']
    for (const binding of PANEL_BINDINGS) {
      expect(binding.modes.length).toBeGreaterThan(0)
      for (const mode of binding.modes) expect(modes).toContain(mode)
    }
  })

  /**
   * `escape` is the universal cancel — leave a cell, answer the prompt, close.
   * If it is ever dropped from one of the three modes there is no longer a way
   * out of that mode, and no other test would notice: the mode is still
   * reachable, it just cannot be left.
   */
  it('keeps escape live in every mode, because it is the only way out of each', () => {
    // Named `escapeBinding`, not `escape`: the latter shadows the global
    // function of that name, which biome rightly treats as an error.
    const escapeBinding = PANEL_BINDINGS.find(binding => binding.bind === 'escape')
    expect(escapeBinding).toBeDefined()
    if (escapeBinding === undefined) throw new Error('the binding table has no escape')
    expect([...escapeBinding.modes].sort()).toEqual(['browse', 'discard', 'edit'])
  })

  /**
   * The invariant that stops `j` and `s` from firing while a cell is open. A
   * binding added to `edit` modes would be DELIVERED by the keymap layer, and the
   * reducer's own guard is defence in depth — so this is the assertion that says
   * the keys are not delivered, not merely that they do nothing.
   */
  it('does not deliver navigation or save keys while a cell is open', () => {
    for (const binding of PANEL_BINDINGS) {
      if (['up', 'down', 'home', 'end', 'k', 'j', 'g', 'G', 'tab', 'r', 's', 'ctrl+s'].includes(binding.bind)) {
        expect(binding.modes).not.toContain('edit')
      }
    }
  })

  /**
   * The footer is a promise to a user who cannot read this file, so every hint it
   * shows has to resolve to a binding that is actually live in `browse`. A hint
   * with nothing behind it is the most expensive kind of lie: the user reads it,
   * presses the key, and concludes the panel is broken.
   */
  it('resolves every key the footer advertises to a live binding', () => {
    const browseBinds = new Set(
      PANEL_BINDINGS.filter(binding => binding.modes.includes('browse')).map(binding => binding.bind)
    )
    expect(PANEL_FOOTER_HINTS.length).toBeGreaterThan(0)
    for (const hint of PANEL_FOOTER_HINTS) {
      expect(browseBinds).toContain(hint.bind)
    }
  })
})

// ── Reachability: the guarantee this feature is really about ────────

describe('config panel keyboard reachability', () => {
  it('reaches EVERY discovered row from the initial state, using only the bound keys', () => {
    const state = createPanelState(realConfig() as never, 'global')
    const rows = stateRows(state)
    const cursors = new Set(reachable(state, PANEL_KEYS).map(reached => reached.cursor))

    // The assertion is a comparison against the DISCOVERED rows, not against a
    // list of keys or row indices written here. A row nobody bound is a row
    // missing from `cursors`, and this fails.
    expect([...cursors].sort((a, b) => a - b)).toEqual(rows.map((_, index) => index))
  })

  it('reaches every BOOLEAN and can toggle each one both ways', () => {
    const initial = createPanelState(realConfig() as never, 'global')
    const booleans = stateRows(initial)
      .map((row, index) => ({ row, index }))
      .filter(entry => entry.row.kind === 'boolean')
    expect(booleans.length).toBeGreaterThan(1)

    for (const { row, index } of booleans) {
      const onRow = focusRow(initial, index)
      // The cursor really is on THIS row, not on some other block's `enabled`.
      expect(stateRows(onRow)[onRow.cursor]?.path).toEqual(row.path)
      const before = panelValueAt(onRow.draft, row.path)
      expect(typeof before).toBe('boolean')

      const after = press(onRow, key('return')).state
      expect(panelValueAt(after.draft, row.path)).toBe(!before)
      // Visible, not merely changed: the notice names the FULL path and the new
      // value, so a toggle that happened on a row called `enabled` is still
      // evidence about a specific setting.
      expect(after.notice).toBe(`${row.path.join('.')} = ${!before}`)

      // And back again, from wherever that left the cursor.
      const back = press(after, key('return')).state
      expect(panelValueAt(back.draft, row.path)).toBe(before)
    }
  })

  it('toggles a boolean with space as well as return', () => {
    const initial = createPanelState(realConfig() as never, 'global')
    const index = stateRows(initial).findIndex(row => row.kind === 'boolean')
    const onRow = focusRow(initial, index)
    const before = panelValueAt(onRow.draft, stateRows(onRow)[index]?.path as never)

    const after = press(onRow, key('space')).state
    expect(panelValueAt(after.draft, stateRows(onRow)[index]?.path as never)).toBe(!before)
  })

  it('scrolls every row into view: the cursor is always inside the rendered window', () => {
    const state = createPanelState(realConfig() as never, 'global')
    const rows = stateRows(state)

    // A viewport far shorter than the list, which is the case a value below the
    // fold falls into. The window is the panel's own, not a host scroll
    // container's, precisely so this can be asserted.
    const height = 8
    expect(rows.length).toBeGreaterThan(height)

    let start = 0
    for (let cursor = 0; cursor < rows.length; cursor++) {
      const window = panelWindow(cursor, rows.length, height, start)
      expect(window.start).toBeLessThanOrEqual(cursor)
      expect(cursor).toBeLessThan(window.end)
      start = window.start
    }
  })

  it('keeps the window valid for every cursor at every plausible height', () => {
    const total = stateRows(createPanelState(realConfig() as never, 'global')).length
    for (const height of [1, 2, 5, 12, total - 1, total, total + 10]) {
      for (let cursor = 0; cursor < total; cursor++) {
        for (const previous of [0, Math.floor(total / 2), total - 1]) {
          const window = panelWindow(cursor, total, height, previous)
          expect(window.start).toBeLessThanOrEqual(cursor)
          expect(cursor).toBeLessThan(window.end)
          expect(window.end - window.start).toBeGreaterThan(0)
        }
      }
    }
  })

  it('does not scroll out from under a cursor that stays put', () => {
    // A cursor already inside the window leaves the window alone — the panel
    // tracks the cursor, it does not re-centre on every move.
    expect(panelWindow(15, 40, 10, 12).start).toBe(12)
    // And a cursor OUTSIDE it is followed, which is the half that matters.
    expect(panelWindow(2, 40, 10, 12).start).toBe(2)
    expect(panelWindow(38, 40, 10, 12).start).toBe(29)
  })
})

// ── Navigation ──────────────────────────────────────────────────────

describe('config panel navigation', () => {
  const initial = () => createPanelState(realConfig() as never, 'global')

  it('does nothing at all while the panel is closed, and says so by staying closed', () => {
    // `applyPanelKey` opens with `if (state.closed) return { state }`, and until
    // now no test pressed a key in that state — so the guard was live code with
    // no coverage, and the panel is the ONE surface where a closed state is the
    // normal state: `createPanelState` seeds `closed: true` in
    // `context.storage.memory`, and `src/tui.tsx` returns `null` from the slot
    // render whenever it is set. A guard that returned the state for a closed
    // panel but processed keys for an open one would be a panel that navigates
    // itself before it is ever drawn.
    const closed = createPanelState(realConfig() as never, 'global', { closed: true })
    expect(closed.closed).toBe(true)

    // Every bound key, not a representative one. `PANEL_BINDINGS` is the table
    // the host keymap is generated from, so a key not in it is not reachable by
    // a user and cannot be pressed here either.
    for (const binding of PANEL_BINDINGS) {
      const key = { name: binding.key.name, ctrl: binding.key.ctrl, shift: binding.key.shift }
      const outcome = applyPanelKey(closed, key)
      // The same object back, not an equal one: `toEqual` would pass for a
      // reducer that rebuilt the state field by field, and a rebuilt state is
      // how a `notice` or a `mode` gets set on a panel nobody is looking at.
      expect({ key: binding.id, same: outcome.state === closed }).toEqual({ key: binding.id, same: true })
      // And no effect — `save` and `close` are the two keys with one, and
      // either firing here would write a file or close a panel that is not open.
      expect({ key: binding.id, effect: outcome.effect ?? null }).toEqual({ key: binding.id, effect: null })
    }
  })

  it('does nothing while closed even from a cell that was open when it closed', () => {
    // The state machine's least obvious corner: `closed` is independent of
    // `mode`, so a cell can be open on a closed panel. Routing by `mode` alone
    // would let `enter` commit a buffer and `y` discard a config the user is
    // not looking at.
    // Navigate to a NUMBER row rather than counting downs: the first row is a
    // `models` entry, and `return` on a model row asks the host for a model
    // instead of opening a cell, so a fixed count would silently stop testing
    // what this test is about.
    const opened = initial()
    const target = stateRows(opened).findIndex(row => row.kind === 'number')
    expect(target).toBeGreaterThan(0)
    const editing = press(opened, ...Array.from({ length: target }, () => key('down')), key('return'))
    expect(editing.state.mode).toBe('edit')
    const closedEdit = { ...editing.state, closed: true }

    const outcome = applyPanelKey(closedEdit, key('escape'))
    expect(outcome.state).toBe(closedEdit)
    expect(outcome.effect ?? null).toBeNull()
  })

  it('moves with arrows and with vi keys to the same place', () => {
    const arrow = press(initial(), key('down'), key('down')).state
    const vi = press(initial(), key('j'), key('j')).state
    expect(arrow.cursor).toBe(2)
    expect(vi.cursor).toBe(arrow.cursor)
  })

  it('clamps at both ends rather than wrapping, so the first row stays findable', () => {
    expect(press(initial(), key('up')).state.cursor).toBe(0)
    const rows = stateRows(initial())
    const atEnd = press(initial(), key('end')).state
    expect(atEnd.cursor).toBe(rows.length - 1)
    expect(press(atEnd, key('down')).state.cursor).toBe(rows.length - 1)
  })

  it('jumps to the first and last row with home/end and g/G', () => {
    const rows = stateRows(initial())
    expect(press(initial(), key('home')).state.cursor).toBe(0)
    expect(press(initial(), key('g')).state.cursor).toBe(0)
    expect(press(initial(), key('end')).state.cursor).toBe(rows.length - 1)
    // `G` arrives as `name: 'g'` with shift — if the reducer treated it as `g`,
    // this is the assertion that catches it.
    expect(press(initial(), key('g', { shift: true })).state.cursor).toBe(rows.length - 1)
  })

  it('crosses from one block into the next', () => {
    const rows = stateRows(initial())
    const lastBlock = rows[rows.length - 1]?.block
    const firstOfLast = rows.findIndex(row => row.block === lastBlock)
    expect(firstOfLast).toBeGreaterThan(0)

    const crossed = press(
      focusRow(initial(), 0),
      ...Array.from({ length: firstOfLast }, () => key('down'))
    ).state

    expect(crossed.cursor).toBe(firstOfLast)
    expect(stateRows(crossed)[crossed.cursor]?.block).toBe(lastBlock)
  })

  it('refuses to navigate while a cell is open, so a letter cannot move the cursor', () => {
    const opened = press(focusRow(initial(), indexOfPath(initial(), 'budget.maxTotalCost')), key('return')).state
    expect(opened.mode).toBe('edit')
    // A string that would be a save and a navigation letter, both inert here.
    const after = press(opened, key('j'), key('s'), key('g', { shift: true })).state
    expect(after.cursor).toBe(opened.cursor)
    expect(after.mode).toBe('edit')
  })
})

// ── Number and text cells ───────────────────────────────────────────

describe('config panel cells', () => {
  const initial = () => createPanelState(realConfig() as never, 'global')

  /** Open the cell at `dotted` path, set its contents, and press return. */
  function commit(dotted: string, typed: string): { state: PanelState; effects: unknown[] } {
    const base = initial()
    const opened = press(focusRow(base, indexOfPath(base, dotted)), key('return')).state
    expect(opened.mode).toBe('edit')
    // The host `<input>` is what fills the buffer in the real panel; the reducer
    // only ever sees the finished text, so the test supplies it directly.
    const outcome = applyPanelKey({ ...opened, buffer: typed }, key('return'))
    return { state: outcome.state, effects: outcome.effect === undefined ? [] : [outcome.effect] }
  }

  it('accepts a valid number and shows what it set', () => {
    const { state } = commit('budget.maxTotalCost', '42.5')
    expect(state.mode).toBe('browse')
    expect(state.error).toBeUndefined()
    expect(panelValueAt(state.draft, ['budget', 'maxTotalCost'])).toBe(42.5)
    expect(state.notice).toBe('budget.maxTotalCost = 42.5')
  })

  it('accepts zero, which is a real budget and not garbage', () => {
    const { state } = commit('budget.maxTotalCost', '0')
    expect(state.mode).toBe('browse')
    expect(panelValueAt(state.draft, ['budget', 'maxTotalCost'])).toBe(0)
  })

  // THE FIX. The old budget prompt parsed with `parseFloat` and, on a bad value,
  // fell through reporting nothing at all: the dialog closed, the value did not
  // change, and the user had no way to tell a rejection from a missed keypress.
  it.each([
    ['abc', 'not a number'],
    ['', 'Enter a number'],
    ['-5', 'zero or a positive'],
    ['12abc', 'not a number'],
    ['Infinity', 'not a number']
  ])('rejects %p VISIBLY, keeps the cell open and changes nothing', (typed, expected) => {
    const before = realConfig()
    const { state } = commit('budget.maxTotalCost', typed)

    expect(state.error).toContain(expected as string)
    // Still open, with the text still there to correct — a rejection that closes
    // the cell is a rejection the user repeats.
    expect(state.mode).toBe('edit')
    expect(state.buffer).toBe(typed)
    // And the draft is untouched: a rejected value never reaches the config.
    expect(panelValueAt(state.draft, ['budget', 'maxTotalCost'])).toBe(
      panelValueAt(before, ['budget', 'maxTotalCost'])
    )
  })

  it('clears the error only when the value is finally accepted', () => {
    const rejected = commit('budget.maxTotalCost', 'abc').state
    expect(rejected.error).toBeDefined()
    const accepted = applyPanelKey({ ...rejected, buffer: '7' }, key('return')).state
    expect(accepted.error).toBeUndefined()
    expect(accepted.mode).toBe('browse')
    expect(panelValueAt(accepted.draft, ['budget', 'maxTotalCost'])).toBe(7)
  })

  it('parses a number or says why, never silently', () => {
    expect(parsePanelNumber('3')).toEqual({ ok: true, value: 3 })
    expect(parsePanelNumber(' 3.5 ')).toEqual({ ok: true, value: 3.5 })
    expect(parsePanelNumber('0')).toEqual({ ok: true, value: 0 })
    for (const bad of ['', ' ', 'x', '1x', '-1', 'NaN', 'Infinity', '1e']) {
      expect(parsePanelNumber(bad).ok).toBe(false)
    }
  })

  it('edits a text value, and can clear one', () => {
    const { state } = commit('dashboard.host', '0.0.0.0')
    expect(panelValueAt(state.draft, ['dashboard', 'host'])).toBe('0.0.0.0')
    expect(state.notice).toBe('dashboard.host = 0.0.0.0')

    const cleared = commit('dashboard.host', '').state
    expect(panelValueAt(cleared.draft, ['dashboard', 'host'])).toBe('')
    expect(cleared.notice).toBe('dashboard.host cleared')
  })

  it('asks the host for a model rather than editing it as text', () => {
    const onRow = focusRow(initial(), indexOfPath(initial(), 'models.coder'))
    const outcome = applyPanelKey(onRow, key('return'))
    expect(outcome.state.mode).toBe('browse')
    expect(outcome.effect).toEqual({
      kind: 'pick-model',
      path: ['models', 'coder'],
      current: 'anthropic/claude-sonnet-4-6',
      title: 'models.coder'
    })
  })

  it('stores the model the picker returned, including the reset value', () => {
    const onRow = focusRow(initial(), indexOfPath(initial(), 'models.coder'))
    const chosen = applyPanelChoice(onRow, ['models', 'coder'], 'opencode-go/space-bunny-free')
    expect(panelValueAt(chosen.draft, ['models', 'coder'])).toBe('opencode-go/space-bunny-free')
    expect(chosen.notice).toContain('opencode-go/space-bunny-free')

    // `""` is the picker's "Use default" row, and it is what `getModelForRole`
    // already treats as "fall back". Storing it verbatim keeps the panel and the
    // standalone `/nexus model` command meaning the same thing.
    const reset = applyPanelChoice(onRow, ['models', 'coder'], '')
    expect(panelValueAt(reset.draft, ['models', 'coder'])).toBe('')
    expect(reset.notice).toContain('default')
  })
})

// ── Arrays ──────────────────────────────────────────────────────────

describe('config panel arrays', () => {
  /**
   * A config with a POPULATED array.
   *
   * `getConfig()` returns `customRoles: []` by default, so the real config's
   * only array is an empty one and the "step into the entries" path would be
   * untested against it. The shape is the one `NexusCustomRoleConfig` declares,
   * so this is the panel's real array handling and not an invented one.
   */
  const populated = (): PanelDraft =>
    ({
      customRoles: [
        { name: 'qa', prompt: 'Ask questions', model: 'anthropic/claude-sonnet-4-6' },
        { name: 'ops', prompt: 'Run the ops' }
      ]
    }) as PanelDraft

  it('steps onto an array header and reaches the entries inside it', () => {
    const state = createPanelState(populated() as never, 'global')
    const rows = stateRows(state)
    const header = rows.findIndex(row => row.kind === 'list')
    expect(header).toBeGreaterThanOrEqual(0)

    const focused = focusRow(state, header)
    const entered = press(focused, key('return')).state
    expect(entered.cursor).toBe(header + 1)
    expect(stateRows(entered)[entered.cursor]?.path).toEqual(['customRoles', 0, 'name'])
  })

  it('edits a value inside an array element, at the right path', () => {
    const state = createPanelState(populated() as never, 'global')
    const onRow = focusRow(state, indexOfPath(state, 'customRoles.1.name'))
    // The OPENED state, not a copy of the browse state: committing from browse
    // mode would just re-open the cell seeded with its own current value, and the
    // typed text would be discarded with no error — which is the exact bug this
    // panel set out to remove, reproduced in the test that covers it.
    const opened = applyPanelKey(onRow, key('return')).state
    expect(opened.mode).toBe('edit')

    const committed = applyPanelKey({ ...opened, buffer: 'sre' }, key('return')).state
    expect(committed.mode).toBe('browse')
    const roles = panelValueAt(committed.draft, ['customRoles'])
    expect(Array.isArray(roles)).toBe(true)

    expect(panelValueAt(committed.draft, ['customRoles', 1, 'name'])).toBe('sre')
    // The SIBLING FIELDS of the edited element survive. This is the assertion
    // that catches the bug this test was written against: a path-walk that
    // spread the array into an object produced an element that still read back
    // `'sre'` at `[1].name` while having silently lost every other field.
    expect(panelValueAt(committed.draft, ['customRoles', 1, 'prompt'])).toBe('Run the ops')
    // And the other element is untouched, which is what a walk that dropped the
    // index would break: it would write to `customRoles[0]`.
    expect(panelValueAt(committed.draft, ['customRoles', 0, 'name'])).toBe('qa')
    expect(panelValueAt(committed.draft, ['customRoles', 0, 'model'])).toBe('anthropic/claude-sonnet-4-6')
  })

  it('gives an element’s own model reference the picker', () => {
    const state = createPanelState(populated() as never, 'global')
    const outcome = applyPanelKey(focusRow(state, indexOfPath(state, 'customRoles.0.model')), key('return'))
    expect(outcome.effect).toMatchObject({
      kind: 'pick-model',
      path: ['customRoles', 0, 'model'],
      current: 'anthropic/claude-sonnet-4-6'
    })
  })

  it('says so when an array is empty, instead of appearing inert', () => {
    const state = createPanelState({ roles: [] } as never, 'global')
    const outcome = applyPanelKey(state, key('return'))
    expect(outcome.state.notice).toContain('empty')
    // And it does not claim to have moved somewhere it did not.
    expect(outcome.state.cursor).toBe(0)
  })

  it('reports the array header as a non-editable row, with the reason', () => {
    const { readonlyRows } = discoverPanel(populated())
    expect(readonlyRows).toEqual([
      { label: 'customRoles', reason: 'array header — return opens its entries' }
    ])
  })
})

// ── Dirty state, revert, escape, save ───────────────────────────────

describe('config panel leaving and saving', () => {
  const initial = () => createPanelState(realConfig() as never, 'global')

  it('closes straight away when nothing has been edited', () => {
    const outcome = applyPanelKey(initial(), key('escape'))
    expect(outcome.state.closed).toBe(true)
    expect(outcome.effect).toEqual({ kind: 'close', discarded: false })
  })

  // THE OTHER SILENT-DISCARD. A panel that drops edits on escape with no prompt
  // is a panel that loses work the user believed they had staged.
  it('never discards edits silently: escape with unsaved edits asks first', () => {
    const dirty = edited(initial())
    expect(panelIsDirty(dirty)).toBe(true)

    const outcome = applyPanelKey(dirty, key('escape'))
    expect(outcome.state.closed).toBe(false)
    expect(outcome.state.mode).toBe('discard')
    expect(outcome.effect).toBeUndefined()
  })

  it('keeps the edits when the discard prompt is declined, from either key', () => {
    for (const declining of [key('n'), key('escape')]) {
      const prompted = applyPanelKey(edited(initial()), key('escape')).state
      const answered = applyPanelKey(prompted, declining).state
      expect(answered.mode).toBe('browse')
      expect(answered.closed).toBe(false)
      expect(panelIsDirty(answered)).toBe(true)
      expect(answered.notice).toContain('Nothing was written')
    }
  })

  it('discards and closes when the prompt is accepted, and says the edits were lost', () => {
    const prompted = applyPanelKey(edited(initial()), key('escape')).state
    const outcome = applyPanelKey(prompted, key('y'))
    expect(outcome.state.closed).toBe(true)
    expect(outcome.effect).toEqual({ kind: 'close', discarded: true })
  })

  it('ignores every other key at the discard prompt, including save', () => {
    const prompted = applyPanelKey(edited(initial()), key('escape')).state
    for (const other of [key('s'), key('j'), key('return'), key('tab'), key('r')]) {
      const outcome = applyPanelKey(prompted, other)
      expect(outcome.state).toBe(prompted)
      expect(outcome.effect).toBeUndefined()
    }
  })

  it('reverts every staged edit, and says when there was nothing to revert', () => {
    const dirty = edited(initial())
    const reverted = applyPanelKey(dirty, key('r')).state
    expect(panelIsDirty(reverted)).toBe(false)
    expect(reverted.draft).toEqual(dirty.base)
    expect(reverted.notice).toContain('Reverted')

    const again = applyPanelKey(reverted, key('r'))
    expect(again.state.draft).toEqual(dirty.base)
    expect(again.state.notice).toContain('Nothing to revert')
  })

  it('saves with s and with ctrl+s, and never from inside a cell', () => {
    for (const saveKey of [key('s'), key('s', { ctrl: true })]) {
      const outcome = applyPanelKey(initial(), saveKey)
      expect(outcome.effect).toEqual({ kind: 'save' })
    }
    const open = press(focusRow(initial(), indexOfPath(initial(), 'budget.maxTotalCost')), key('return')).state
    expect(applyPanelKey(open, key('s')).effect).toBeUndefined()
  })

  it('switches the save scope with tab without writing anything', () => {
    const toggled = applyPanelKey(initial(), key('tab')).state
    expect(toggled.scope).toBe('project')
    expect(applyPanelKey(toggled, key('tab')).state.scope).toBe('global')
  })

  /**
   * The whole draft goes to the config manager, not the changed paths.
   *
   * `updateStorageConfig` rebuilds the blocks it names and, for `selfHealing`,
   * falls back to `DEFAULT_CONFIG` rather than to the project/global levels for
   * three of its four fields. A partial update would therefore pin those to
   * their defaults and shadow the user's `nexus.jsonc` — the "the file is
   * ignored" bug, reached by editing one unrelated number.
   */
  it('saves the entire merged draft, so untouched keys cannot be reset', () => {
    const merged = new NexusConfigManager().getConfig()
    const update = panelSaveUpdate(createPanelState(merged, 'global'))
    const blocks = Object.keys(merged)

    expect(blocks.length).toBeGreaterThan(0)
    for (const block of blocks) {
      expect(Object.hasOwn(update, block)).toBe(true)
      // Compared against the manager's own merged config, not against a second
      // `getConfig()` call dressed up as a draft — that would be the
      // function-against-itself tautology this repository has shipped before.
      expect(update[block as keyof typeof update]).toEqual(merged[block as keyof typeof merged])
    }
  })

  it('does not mutate the config the panel opened with', () => {
    const config = realConfig()
    const snapshot = JSON.stringify(config)
    applyPanelKey(
      { ...applyPanelKey(focusRow(createPanelState(config as never, 'global'), 0), key('return')).state, buffer: '1' },
      key('return')
    )
    expect(JSON.stringify(config)).toBe(snapshot)
  })
})

/** A state with one staged edit, for the escape and revert cases. */
function edited(initial: PanelState): PanelState {
  const opened = applyPanelKey(
    focusRow(initial, indexOfPath(initial, 'budget.maxTotalCost')),
    key('return')
  ).state
  return applyPanelKey({ ...opened, buffer: '999' }, key('return')).state
}


// ── Value path handling ─────────────────────────────────────────────

describe('config panel value paths', () => {
  it('leaves the input alone and copies along the path', () => {
    const config: PanelDraft = { a: { b: { c: 1 } }, d: 2 }
    const next = setPanelValue(config, ['a', 'b', 'c'], 9)
    expect(panelValueAt(next, ['a', 'b', 'c'])).toBe(9)
    expect(panelValueAt(config, ['a', 'b', 'c'])).toBe(1)
    // Off-path values are shared, not cloned — a deep copy of the whole config
    // on every keystroke would be the alternative.
    expect(next.d).toBe(config.d)
  })

  it('refuses a path that does not resolve rather than inventing the containers', () => {
    const config: PanelDraft = { a: 1 }
    expect(setPanelValue(config, ['nope', 'deeper'], 9)).toBe(config)
    expect(setPanelValue(config, ['a', 'deeper'], 9)).toBe(config)
    expect(setPanelValue(config, ['a', 5], 9)).toBe(config)
  })
})

// ── The save path keeps every block ─────────────────────────────────

describe('config panel save path', () => {
  /**
   * `getSaveableConfig()` is a hand-written list of blocks, and
   * `saveProjectConfig` writes its RETURN VALUE AS THE WHOLE FILE. A block
   * missing from that list is therefore not left alone — it is DELETED from the
   * user's `nexus.jsonc` the first time they save anything at all, which is what
   * makes the panel (a surface whose whole job is saving) the place this bites.
   *
   * The list of blocks is read out of the `NexusFullConfig` declaration rather
   * than written here, so a block added to the config interface fails this test
   * until `getSaveableConfig` mentions it. That is the only version of the check
   * that can notice a block nobody thought to list.
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
    const dir = mkdtempSync(join(tmpdir(), 'nexus-panel-save-'))
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

  // The test that stood here read `src/config.ts` as a STRING and asserted it
  // contained 'maxTotalCost', 'maxCostPerTask' and 'alertThreshold'. Three
  // greps, in a loop, over a list typed out beside them, asserting nothing per
  // member: the strings are in that file in comments, in `DEFAULT_CONFIG`, in the
  // merge chain and in `getSaveableConfig`, so the assertion could not fail for
  // any reason a user would recognise — and `retryDelay`, the one nested field
  // this repository has been bitten by twice, was not in the list.
  //
  // It is replaced by the round trip above, which is the real version: save a
  // project file, read the file back, and assert on its CONTENTS. A block or a
  // field that stops being written fails that, and one that is only mentioned
  // in a comment cannot pass it. `test/config-knobs.test.ts` covers the same
  // ground for `retryDelay` at the manager layer.
})

// ── The keymap handshake ────────────────────────────────────────────
//
// Everything below was, until `panelLayerSpec` and `panelKeyBuffer` were
// extracted, a closure inside `src/tui.tsx` that no test in this repository
// could reach. Two mutations of that closure survive a full green suite, and
// both are user-visible failures rather than crashes:
//
//   1. Never reading `panelInput.value`. Every committed edit stores the value
//      the cell was SEEDED with. The cell opens, the user types, presses enter,
//      and the old value is written back — with no error, because every value
//      the reducer is handed is a perfectly valid string.
//   2. Targeting the root unconditionally. A focused `<input>` consumes the
//      keyboard, so `esc` never reaches the panel and a cell can be entered but
//      not left.

describe('the keymap handshake', () => {
  const initial = () => createPanelState(realConfig() as never, 'global')

  /** A cell open on a number row, reached the way a user reaches it. */
  function editingCell(): PanelState {
    const opened = initial()
    const target = stateRows(opened).findIndex(row => row.kind === 'number')
    expect(target).toBeGreaterThan(0)
    return press(opened, ...Array.from({ length: target }, () => key('down')), key('return')).state
  }

  it('commits what the user TYPED, not the value the cell was seeded with', () => {
    const state = { ...editingCell(), buffer: 'seeded' }
    // The two values differ on purpose: if the function returned `state.buffer`
    // this test fails, and if it returned the input unconditionally the next one
    // does. A single assertion covering both would pass a wrong implementation
    // that returned the input for every key.
    expect({ seeded: state.buffer, committed: panelKeyBuffer(state, key('return'), 'typed') })
      .toEqual({ seeded: 'seeded', committed: 'typed' })
  })

  it('reads the input on commit ONLY, so a keystroke cannot fight the caret', () => {
    // The input is uncontrolled after mount. Re-rendering it from state on every
    // keypress is a fight over the caret position, and the cost is a cell that
    // drops characters — which is why only `return` reads it. `escape` is the
    // one that matters: it CANCELS, so it must not see a value at all.
    const state = { ...editingCell(), buffer: 'seeded' }
    for (const name of ['escape', 'a', 'up']) {
      expect({ name, buffer: panelKeyBuffer(state, key(name), 'typed') })
        .toEqual({ name, buffer: 'seeded' })
    }
    // And in `browse` there is no input on screen, so `return` — which does read
    // it when a cell is open — must not read it here either. Otherwise opening a
    // cell and pressing return with no input mounted would commit `undefined`.
    expect(panelKeyBuffer(initial(), key('return'), 'typed')).toBe(initial().buffer)
  })

  it('falls back to the seeded buffer when the input is not mounted', () => {
    // `panelInput` is `undefined` until the render's `ref` runs. A cell that
    // somehow commits before then must store what it was given rather than
    // `undefined`, which would write the string "undefined" into a user's file.
    const state = { ...editingCell(), buffer: 'seeded' }
    expect(panelKeyBuffer(state, key('return'), undefined)).toBe('seeded')
  })

  it('targets the ROOT while browsing and the INPUT while a cell is open', () => {
    const ROOT = { name: 'root' }
    const INPUT = { name: 'input' }
    let state = initial()
    const layer = panelLayerSpec(() => state, () => ({ root: ROOT, input: INPUT }), () => {})

    expect(layer().target()).toBe(ROOT)

    state = editingCell()
    expect(state.mode).toBe('edit')
    // The whole point of this assertion: a root target here means `esc` goes to
    // a renderable that does not have the keyboard, and the cell is a trap.
    expect(layer().target()).toBe(INPUT)

    // Read FRESH, not captured. A spec that captured the mode when it was built
    // would send the key to whatever was on screen at build time.
    state = initial()
    expect(layer().target()).toBe(ROOT)
  })

  it('targets nothing and enables nothing while the panel is closed', () => {
    const ROOT = { name: 'root' }
    const layer = panelLayerSpec(
      () => ({ ...initial(), closed: true }),
      () => ({ root: ROOT, input: { name: 'input' } }),
      () => {}
    )
    expect(layer().target()).toBeNull()
    expect(layer().enabled()).toBe(false)
  })

  it('offers exactly the bindings the current mode declares, and runs the key it names', () => {
    const sent: PanelKey[] = []
    let state = initial()
    const layer = panelLayerSpec(() => state, () => ({ root: {}, input: {} }), k => { sent.push(k) })

    for (const mode of ['browse', 'edit', 'discard'] as const) {
      state = { ...initial(), mode }
      const spec = layer()
      const expected = PANEL_BINDINGS.filter(b => b.modes.includes(mode))
      expect({ mode, ids: spec.commands.map(c => c.id) })
        .toEqual({ mode, ids: expected.map(b => `nexus.config.panel.${b.id}`) })

      // And the command runs the key the TABLE names — not a retyped copy. A
      // command that ran `return` for a binding spelled `ctrl+s` would save the
      // file on the wrong key, and no assertion above would notice.
      for (const command of spec.commands) {
        const binding = expected.find(b => `nexus.config.panel.${b.id}` === command.id)
        if (!binding) throw new Error(`panelLayerSpec offered ${command.id}, which ${mode} does not declare`)
        sent.length = 0
        command.run()
        // The whole array, so a command that ran TWICE fails as well as one that
        // ran the wrong key.
        expect({ mode, id: command.id, sent }).toEqual({ mode, id: command.id, sent: [binding.key] })
      }
    }
  })

  it('escapes a cell, which is only possible because the input is the target', () => {
    // The end-to-end version of the two assertions above, through the real
    // handshake: an open cell, the spec's `escape` command, and the reducer.
    // Asserted on `spec.target()` at the moment the key is dispatched rather
    // than only afterwards, because the bug is that the key never arrives.
    let state = editingCell()
    const dispatched: PanelKey[] = []
    // Hoisted, because the getter runs on every dispatch and a fresh object
    // literal each time would make the identity check below compare two
    // different objects rather than two reads of one renderable.
    const ROOT_TOKEN = { name: 'root' }
    const INPUT_TOKEN = { name: 'input' }
    const layer = panelLayerSpec(
      () => state,
      () => ({ root: ROOT_TOKEN, input: INPUT_TOKEN }),
      k => {
        dispatched.push(k)
        if (layer().target() !== INPUT_TOKEN) throw new Error('escape dispatched with the cell unfocused')
        state = applyPanelKey({ ...state, buffer: panelKeyBuffer(state, k, 'typed') }, k).state
      }
    )
    expect(layer().target()).toBe(INPUT_TOKEN)

    const cancel = layer().commands.find(c => c.id === 'nexus.config.panel.cancel')
    if (!cancel) throw new Error('edit mode must offer a cancel binding, or a cell is a trap')
    cancel.run()

    expect(dispatched).toEqual([{ name: 'escape', ctrl: false, shift: false }])
    expect(state.mode).toBe('browse')
    expect(state.closed).toBe(false)
  })
})
