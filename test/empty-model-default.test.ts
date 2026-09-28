import { describe, it, expect, afterAll, mock } from 'bun:test'
import * as realOs from 'node:os'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * `""` in the `models` block means the role's own default, and only the role's
 * own default.
 *
 * ── THE BUG THIS SPECIFIES ──
 *
 * The TUI model picker's "Use default" row carries `USE_DEFAULT_VALUE = ""`
 * (`src/tui.tsx`), and `getSaveableConfig()` writes the `models` block verbatim
 * as the whole file body, so choosing that row persists `"reviewer": ""` into
 * the user's `nexus.jsonc`. A key present with `""` is present, and `"" || x` is
 * `x`, so under the old chain the row labelled "Use default" selected the
 * CODER's model: `reviewer`'s default is `openai/gpt-5-mini` and clearing it
 * produced `anthropic/claude-sonnet-4-6`. A different model's judgement, under a
 * role name that says otherwise, at the coder's price, chosen from a row that
 * promises the opposite.
 *
 * The chain is now
 * `config.models[role] || customRoleModel || roleDefault || config.models.coder
 * || DEFAULT_CONFIG.models.coder`, where `roleDefault` is
 * `DEFAULT_CONFIG.models[role]` and is consulted ONLY when the role's own entry
 * was explicitly emptied.
 *
 * ── WHY THESE TESTS DRIVE THE PICKER'S SENTINEL ──
 *
 * Every test that asserts an empty value resolves to a default takes the value
 * from `USE_DEFAULT_VALUE` and the row from `buildModelOptions`, rather than
 * writing `""` by hand. Hand-writing `""` is the tautology this file exists to
 * avoid: it would keep passing if the sentinel were renamed, and the rename is
 * exactly the change under which a hand-written `""` stops being the value the
 * product writes. The one test that DOES write `""` into a config file on disk
 * says so, and exists to cover the hand-written case the picker cannot reach.
 *
 * The other shape worth naming: a config built by hand cannot distinguish
 * "absent" from "present and undefined" through the resolver, so both are
 * asserted separately where the chain treats them differently. They are
 * different inputs, and the difference is load-bearing.
 */

// Mocked at the module rather than via `process.env.HOME`: under `bun test` the
// env var does not reach `os.homedir()`, and the manager reads a GLOBAL
// `~/.config/opencode/nexus.jsonc` that a developer's real file could use to
// decide these outcomes. Same approach and same reason as
// `test/config-knobs.test.ts`.
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'nexus-empty-model-home-'))
mock.module('node:os', () => ({ ...realOs, default: realOs, homedir: () => SANDBOX_HOME }))

const { NexusConfigManager } = await import('../src/config')
const { USE_DEFAULT_VALUE, buildModelOptions } = await import('../src/tui')

afterAll(() => {
  mock.module('node:os', () => realOs)
})

/**
 * The picker's "Use default" row, read off the options the product builds.
 *
 * Through `buildModelOptions` rather than a literal `"Use default"` title, so
 * this cannot pass if the row is renamed — and it returns the row's `value`,
 * which is the thing the resolver has to agree with.
 */
function useDefaultRow(): string {
  const options = buildModelOptions([], [])
  const row = options[options.length - 1]
  expect(row.title).toBe('Use default')
  return row.value
}

/** A temp project dir, optionally with a `models` block written into it. */
function projectWith(models: Record<string, string> | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-empty-model-proj-'))
  if (models !== null) {
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    const body = Object.entries(models)
      .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`)
      .join(',\n')
    writeFileSync(join(dir, '.opencode', 'nexus.jsonc'), `// test\n{\n  "models": {\n${body}\n  }\n}\n`, 'utf-8')
  }
  return dir
}

/**
 * The built-in defaults, read off a manager with no config anywhere.
 *
 * Typed as `Record<string, string>` by narrowing each value through the same
 * helper, because `NexusModelConfig`'s index signature is `string | undefined`
 * and a reader should not have to write `!` at every call site to say "this is
 * a built-in role, it has a default". The narrowing is an assertion at ONE
 * place, and the assertion is load-bearing: a role with no default is the case
 * the custom-role tests are about, and it is covered there by name rather than
 * by tripping over this helper.
 */
function builtInDefaults(): Record<string, string> {
  const models = new NexusConfigManager().getConfig().models
  const out: Record<string, string> = {}
  for (const [role, model] of Object.entries(models)) {
    if (model === undefined) throw new Error(`built-in role "${role}" has no default`)
    out[role] = model
  }
  return out
}

/** Whether the defaults name this role at all, as a distinct question. */
function hasBuiltInDefault(role: string): boolean {
  return Object.hasOwn(new NexusConfigManager().getConfig().models, role)
}

/**
 * A role whose built-in default DIFFERS from the coder's.
 *
 * Without this the assertions would be satisfied by accident: `designer` and
 * `coder` share a default, so "resolves to the designer's default" and
 * "resolves to the coder's model" are the same string for that role and the
 * whole spec is untestable against it. `reviewer` is the role the bug was
 * reported against, and its default is `openai/gpt-5-mini`.
 */
const ROLE = 'reviewer'

// ── 1. The end-to-end path: click the row, save, reload, resolve ────

describe('"Use default" restores the role\'s own default', () => {
  it('resolves to the role\'s default after a save and reload, not the coder\'s', () => {
    // The whole path, in the order a user's click takes it: `buildModelOptions`
    // builds the row, the row's value goes to `setModel`, `saveProjectConfig`
    // writes the file, a FRESH manager reads that file, and the resolver answers.
    //
    // The fresh manager is the load-bearing part. Resolving on the same instance
    // that took the write would pass even if the save dropped the key, because
    // the storage level would still be in memory — so this would be a test of
    // `setModel` rather than of the file, and the file is where the product's
    // behaviour actually lives.
    const dir = mkdtempSync(join(tmpdir(), 'nexus-use-default-e2e-'))
    const picker = new NexusConfigManager()
    picker.loadFromPath(dir)

    const value = useDefaultRow()
    picker.setModel(ROLE, value)
    picker.saveProjectConfig(dir)

    // The file really does carry the empty string. Asserted because the rest of
    // this test is only meaningful if the save persisted what the picker wrote,
    // and a `getSaveableConfig` that filtered empty values would otherwise make
    // every assertion below pass while the picker's value went nowhere.
    const written = readFileSync(join(dir, '.opencode', 'nexus.jsonc'), 'utf-8')
    expect(written).toContain(`"${ROLE}": ""`)

    const reloaded = new NexusConfigManager()
    reloaded.loadFromPath(dir)
    const resolved = reloaded.getModelForRole(ROLE)

    // The role's OWN default, read from the defaults rather than restated as a
    // literal — so this tracks the constant and cannot pass by matching a
    // hardcoded string that happens to be right today.
    expect(resolved).toBe(builtInDefaults()[ROLE])
    // And explicitly NOT the coder's model, which is the bug. Written as its own
    // assertion rather than folded into the one above, because "differs from
    // coder" and "equals the default" are different claims and only the first
    // is what the user was harmed by.
    expect(resolved).not.toBe(reloaded.getModelForRole('coder'))
  })

  it('the reviewer specifically lands on gpt-5-mini rather than the coder\'s sonnet', () => {
    // The reported case, pinned to the two literal model ids, so the failure
    // message when this regresses names the two models that swapped rather than
    // two values that happen to differ. Both literals are also asserted to
    // still be what the defaults say — if a default is ever changed, this test
    // fails as a stale expectation instead of silently passing.
    const reloaded = new NexusConfigManager()
    reloaded.loadFromPath(mkdtempSync(join(tmpdir(), 'nexus-use-default-pinned-')))
    reloaded.updateStorageConfig({ models: { [ROLE]: useDefaultRow() } })

    expect(builtInDefaults()[ROLE]).toBe('openai/gpt-5-mini')
    expect(builtInDefaults().coder).toBe('anthropic/claude-sonnet-4-6')
    expect(reloaded.getModelForRole(ROLE)).toBe('openai/gpt-5-mini')
  })

  it('restores the default for every built-in role, not just the reported one', () => {
    // `reviewer` alone would leave the other six untested, and a chain that
    // special-cased one name would pass. `designer` is in the set precisely
    // because its default EQUALS the coder's: it is the one role where the old
    // behaviour was invisible, so it is the role where a fix that accidentally
    // only moved the visible cases would be caught by nothing else.
    const manager = new NexusConfigManager()
    manager.loadFromPath(mkdtempSync(join(tmpdir(), 'nexus-use-default-all-')))

    for (const role of manager.getRoles()) {
      manager.setModel(role, useDefaultRow())
      expect(manager.getModelForRole(role)).toBe(builtInDefaults()[role])
    }
  })

  it('is idempotent: default, then explicit, then default again', () => {
    // A user who changes their mind twice must end where they started. This is
    // the shape of the actual complaint — the reset row is a thing people press
    // more than once — and it is a case a single-application test cannot reach.
    const manager = new NexusConfigManager()
    manager.loadFromPath(mkdtempSync(join(tmpdir(), 'nexus-use-default-cycle-')))

    const reset = useDefaultRow()
    expect(manager.getModelForRole(ROLE)).toBe(builtInDefaults()[ROLE])
    manager.setModel(ROLE, 'opencode/some-pick')
    expect(manager.getModelForRole(ROLE)).toBe('opencode/some-pick')
    manager.setModel(ROLE, reset)
    expect(manager.getModelForRole(ROLE)).toBe(builtInDefaults()[ROLE])
  })
})

// ── 2. The picker and the resolver are one contract ────────────────

describe('the picker and the resolver agree on what the sentinel means', () => {
  it('the reset row carries the sentinel, and the sentinel is what the resolver reads', () => {
    // The two halves, asserted against each other rather than against a
    // restated `""`. `expect(row.value).toBe(USE_DEFAULT_VALUE)` on its own is
    // close to `expect(x).toBe(x)` — it only says the constant is used where the
    // constant is defined, which is why the resolver's behaviour below is a
    // SEPARATE test reading the same constant.
    expect(useDefaultRow()).toBe(USE_DEFAULT_VALUE)
  })

  it('the sentinel is the empty string, and the empty string means the default', () => {
    // The reason the sentinel is `""` and not a readable token, asserted rather
    // than assumed: a non-empty sentinel would be a value `getModelForRole`
    // accepts as a configured model, so it would resolve to itself and a
    // provider-prefix warning would be the only sign anything was wrong.
    expect(USE_DEFAULT_VALUE).toBe('')

    const manager = new NexusConfigManager()
    manager.updateStorageConfig({ models: { [ROLE]: USE_DEFAULT_VALUE } })
    expect(manager.getModelForRole(ROLE)).toBe(builtInDefaults()[ROLE])
  })

  it('every role the picker offers is resolvable, and the reset row is not a model', () => {
    // The catalogue path, with one real model and the reset row, so both kinds of
    // row go through the same assertion. The reset row must NOT resolve to a
    // model reference of its own — that is the property that makes `""` the only
    // correct sentinel, and it is the thing a future "use a real token" change
    // would break.
    const options = buildModelOptions(
      [{ providerID: 'opencode', id: 'a-model' } as never],
      [{ id: 'opencode', name: 'OpenCode' }]
    )
    const manager = new NexusConfigManager()
    for (const option of options) {
      manager.setModel(ROLE, option.value)
      const resolved = manager.getModelForRole(ROLE)
      if (option.value === USE_DEFAULT_VALUE) {
        expect(resolved).toBe(builtInDefaults()[ROLE])
      } else {
        expect(resolved).toBe(option.value)
      }
    }
  })
})

// ── 3. The coder's fallback, and the custom-role path ──────────────

describe('the coder\'s fallback still works', () => {
  it('serves a role that is absent from config entirely', () => {
    // The documented behaviour this fix had to preserve, and the reason the
    // coder's model stays in the chain at all. `archivist` is not in
    // `DEFAULT_CONFIG.models`, which is the only way to reach this level for a
    // role nobody configured — for the seven built-ins the defaults are merged
    // UNDERNEATH, so an absent built-in key already has a value by the time the
    // chain reads it and never falls through.
    const manager = new NexusConfigManager()
    manager.updateStorageConfig({ models: { coder: 'opencode/the-coder' } })

    expect(manager.getModelForRole('archivist')).toBe('opencode/the-coder')
  })

  it('a built-in role absent from the file keeps its own default, not the coder\'s', () => {
    // The case that looks like it should hit the coder's fallback and does not,
    // and the reason is the merge order rather than anything in the chain. This
    // is asserted because it is the input a reader will most confidently predict
    // wrongly: `getConfig()` spreads `DEFAULT_CONFIG.models` first, so an absent
    // key is already populated before `getModelForRole` is called.
    const manager = new NexusConfigManager()
    manager.loadFromPath(projectWith({ coder: 'opencode/the-coder' }))

    expect(manager.getModelForRole(ROLE)).toBe(builtInDefaults()[ROLE])
    expect(manager.getModelForRole(ROLE)).not.toBe('opencode/the-coder')
  })

  it('the final term still catches a blanked coder', () => {
    // `DEFAULT_CONFIG.models.coder!` looks unreachable, because `getConfig()`
    // merges the coder default in. It is not: a blanked coder is `""` in the
    // merged map, and `""` is falsy, so the last term is the only thing left.
    // Asserted through a blanked role, so this also pins that the coder's
    // default is what a blanked CODER resolves to — the one role where the old
    // chain and the new one agreed by coincidence.
    const manager = new NexusConfigManager()
    manager.updateStorageConfig({ models: { coder: USE_DEFAULT_VALUE } })

    expect(manager.getModelForRole('coder')).toBe('anthropic/claude-sonnet-4-6')
  })
})

describe('a custom role resolves through the same chain', () => {
  const CUSTOM = 'archivist'

  it('with its own model, that model wins over the coder\'s', () => {
    // `customRoles[].model` sits between the `models` block and the coder
    // fallback, so `models: { archivist: "x" }` and a custom role named
    // `archivist` with `model: "x"` agree.
    const manager = new NexusConfigManager()
    manager.updateStorageConfig({ models: { coder: 'opencode/the-coder' } })
    manager.updateStorageConfig({
      customRoles: [{ name: CUSTOM, prompt: 'keep the records', model: 'opencode/from-custom-role' }]
    })

    expect(manager.getModelForRole(CUSTOM)).toBe('opencode/from-custom-role')
  })

  it('with no model of its own, it falls through to the coder rather than yielding nothing', () => {
    // Item 3 of the brief, and the reason `DEFAULT_CONFIG.models[role]` cannot be
    // a bare term in the chain: this role is not in the defaults, so the role's
    // own default is `undefined`. A chain that ended there would hand a spawn
    // `undefined`; a chain that yielded the empty string would fail the
    // provider-prefix check. Falling through to the coder is the third option
    // and the one that keeps a configured install usable.
    const manager = new NexusConfigManager()
    manager.updateStorageConfig({ models: { coder: 'opencode/the-coder' } })
    manager.updateStorageConfig({ customRoles: [{ name: CUSTOM, prompt: 'keep the records' }] })

    expect(manager.getModelForRole(CUSTOM)).toBe('opencode/the-coder')
    // And explicitly: the defaults do not name this role at all, so nothing was
    // invented for it. This is the assertion that would fail if a future change
    // gave custom roles a synthesised default and thereby quietly redefined
    // "unset" — and it is a question about the KEY rather than about a value
    // being `undefined`, because those are not the same thing: a key present
    // with no value is exactly the input the preservation table treats
    // differently from `""`.
    expect(hasBuiltInDefault(CUSTOM)).toBe(false)
  })

  it('blanked in the `models` block, a custom role with no model of its own falls through', () => {
    // The picker's sentinel applied to a role the defaults do not name. There is
    // no default to restore, so the honest answer is the coder's model — the
    // same answer an absent key gives, which is why "Use default" is not a lie
    // for this role either. Asserted as a PAIR because the equality between the
    // two is the interesting fact, not either value alone.
    const withBlank = new NexusConfigManager()
    withBlank.updateStorageConfig({ models: { coder: 'opencode/the-coder' } })
    withBlank.updateStorageConfig({ customRoles: [{ name: CUSTOM, prompt: 'keep the records' }] })
    withBlank.updateStorageConfig({ models: { [CUSTOM]: USE_DEFAULT_VALUE } })

    const withoutBlank = new NexusConfigManager()
    withoutBlank.updateStorageConfig({ models: { coder: 'opencode/the-coder' } })
    withoutBlank.updateStorageConfig({ customRoles: [{ name: CUSTOM, prompt: 'keep the records' }] })

    expect(withBlank.getModelForRole(CUSTOM)).toBe('opencode/the-coder')
    expect(withBlank.getModelForRole(CUSTOM)).toBe(withoutBlank.getModelForRole(CUSTOM))
  })

  it('a custom role\'s `models` entry outranks its own `model` field', () => {
    // The precedence between the two spellings, unchanged by the fix. Without
    // it, swapping the first two terms of the chain would keep every other test
    // in this file green.
    const manager = new NexusConfigManager()
    manager.updateStorageConfig({
      customRoles: [{ name: CUSTOM, prompt: 'keep the records', model: 'opencode/from-the-role' }]
    })
    manager.updateStorageConfig({ models: { [CUSTOM]: 'opencode/from-the-block' } })

    expect(manager.getModelForRole(CUSTOM)).toBe('opencode/from-the-block')
  })

  it('a blanked `models` entry falls to the custom role\'s own `model`', () => {
    // The one place the sentinel does NOT produce the built-in default, and it
    // is deliberate: the custom role's `model` is a more specific answer for
    // that role than anything in the defaults, and it outranks the role's
    // default in the chain. A chain that put the role default above the custom
    // role's model would fail here.
    const manager = new NexusConfigManager()
    manager.updateStorageConfig({
      customRoles: [{ name: CUSTOM, prompt: 'keep the records', model: 'opencode/from-the-role' }]
    })
    manager.updateStorageConfig({ models: { [CUSTOM]: USE_DEFAULT_VALUE } })

    expect(manager.getModelForRole(CUSTOM)).toBe('opencode/from-the-role')
  })

  it('a blanked entry for a role that is BOTH built-in and custom keeps the custom model', () => {
    // The case that makes the ordering of the two middle levels observable, and
    // the mutation that catches swapping them. A custom role named after a
    // built-in is allowed and wins (`CustomRoleManager`'s own docstring says so),
    // so this is a configuration a user can write rather than a theoretical one.
    //
    // Everything here is a real value, so nothing falls through: the role's own
    // default is a real model (`openai/gpt-5-mini`) and the custom role's `model`
    // is a different real model. Which of the two wins is therefore visible, and
    // the custom role's answer is the one that should: it is the more specific
    // statement about this role, and it is the one the user wrote most recently
    // in the file.
    const manager = new NexusConfigManager()
    manager.updateStorageConfig({
      customRoles: [{ name: ROLE, prompt: 'review with extra care', model: 'opencode/from-the-role' }]
    })
    manager.updateStorageConfig({ models: { [ROLE]: USE_DEFAULT_VALUE } })

    // The two candidates are asserted as different, so this test cannot pass by
    // the two levels happening to agree.
    expect(builtInDefaults()[ROLE]).not.toBe('opencode/from-the-role')
    expect(manager.getModelForRole(ROLE)).toBe('opencode/from-the-role')
  })
})

// ── 4. Everything else is unchanged ────────────────────────────────

describe('only the empty value changed: the preservation table', () => {
  /**
   * One row of the table, asserted.
   *
   * `expected` is the model's own value, NOT a copy of what the resolver
   * currently returns. That is the difference between this table and a
   * characterisation test: an assertion derived from the code under test
   * passes for whatever the code does, so a behaviour change here would be
   * recorded as the new expectation instead of failing.
   */
  function assertResolves(
    label: string,
    models: Record<string, string> | null,
    role: string,
    expected: string
  ): void {
    const manager = new NexusConfigManager()
    manager.loadFromPath(projectWith(models))
    expect({ label, resolved: manager.getModelForRole(role) }).toEqual({ label, resolved: expected })
  }

  it('a fully-specified config is untouched: every role keeps what it was given', () => {
    // The picker's other output. If a user has chosen a model for every role,
    // nothing about them changed, and this is the input a wrong fix would break
    // first — any implementation that replaced the role's entry with a default
    // would fail all seven.
    const models: Record<string, string> = {}
    for (const role of new NexusConfigManager().getRoles()) models[role] = 'opencode/explicitly-set'

    assertResolves('fully specified', models, ROLE, 'opencode/explicitly-set')
    assertResolves('fully specified', models, 'designer', 'opencode/explicitly-set')
    assertResolves('fully specified', models, 'coder', 'opencode/explicitly-set')
  })

  it('a config that omits one role leaves that role on its own default', () => {
    // The other common state, and the one the coder's fallback is NOT reached
    // from: the defaults are merged underneath, so an absent key is populated
    // before the chain reads it.
    assertResolves('one role omitted', { coder: 'opencode/only-this-one' }, ROLE, builtInDefaults()[ROLE])
    assertResolves('one role omitted', { tester: 'opencode/only-this-one' }, ROLE, builtInDefaults()[ROLE])
  })

  it('a config with no `models` block at all resolves every role to its default', () => {
    // A fresh install, asserted per role rather than for one. `null` writes a
    // config file with no `models` key, which is different from a directory with
    // no file at all — both are covered, and the distinction is that the first
    // exercises the merge with an absent block.
    assertResolves('no models block', null, ROLE, builtInDefaults()[ROLE])
    assertResolves('no models block', null, 'coder', builtInDefaults().coder)

    const noFile = new NexusConfigManager()
    noFile.loadFromPath(mkdtempSync(join(tmpdir(), 'nexus-use-default-nofile-')))
    expect(noFile.getModelForRole(ROLE)).toBe(builtInDefaults()[ROLE])
  })

  it('an explicitly `undefined` role entry is NOT the empty case, and keeps the old answer', () => {
    // The preservation case with the least obvious right answer, and the reason
    // the role-default level is gated on `=== ''` rather than being a bare
    // `DEFAULT_CONFIG.models[role]` term.
    //
    // A key present with `undefined` is reachable: a spread of
    // `{ models: { reviewer: undefined } }` SETS the key (spread copies own
    // enumerable keys, `undefined` values included), and `getConfig()`'s
    // `{ ...defaults, ...global, ...project, ...storage }` is exactly such a
    // spread. An embedder calling `updateStorageConfig` with a partially-built
    // object does this without meaning to.
    //
    // Is it the same intent as `""`? No. `undefined` is a level that says "I
    // have no value", which is what absent means; `""` is a level that says
    // "use this role's default", which only the picker means. Treating them
    // alike would silently repoint an embedder's unset role away from the
    // coder's model — the one behaviour this fix is required to preserve.
    const manager = new NexusConfigManager()
    manager.updateStorageConfig({ models: { coder: 'opencode/the-coder' } })
    manager.updateStorageConfig({
      models: { [ROLE]: undefined as unknown as string }
    })

    // The key really is present-and-undefined, not absent: otherwise this test
    // would be asserting the omitted-role row again while appearing to cover a
    // third case, which is the misreading it exists to prevent.
    expect(Object.hasOwn(manager.getConfig().models, ROLE)).toBe(true)
    expect(manager.getConfig().models[ROLE]).toBeUndefined()
    expect(manager.getModelForRole(ROLE)).toBe('opencode/the-coder')
  })

  it('a blanked role is silent: no warning, and the other channels are unchanged', () => {
    // The absence assertion, and the one the fix has to earn. The previous
    // behaviour warned here; the point of the fix is that the outcome is now
    // correct, so a warning would be the product objecting to a value it wrote
    // itself. A different assertion from "silent on a normal config" — the
    // input is the one the picker produces.
    const original = console.warn
    const seen: string[] = []
    console.warn = (...args: unknown[]) => { seen.push(args.map(a => String(a)).join(' ')) }
    try {
      const manager = new NexusConfigManager()
      manager.setModel(ROLE, useDefaultRow())
      manager.setModel('designer', useDefaultRow())
      for (const role of manager.getRoles()) manager.getModelForRole(role)
    } finally {
      console.warn = original
    }
    expect(seen).toEqual([])
  })

  it('a blanked role with no provider prefix elsewhere still warns about the prefix', () => {
    // The other warning is untouched, and it is a different mistake with a
    // different fix. Keeping the two apart matters: a change that merged them,
    // or that swallowed this one, would pass a test that only checked silence.
    const original = console.warn
    const seen: string[] = []
    console.warn = (...args: unknown[]) => { seen.push(args.map(a => String(a)).join(' ')) }
    try {
      const manager = new NexusConfigManager()
      manager.updateStorageConfig({ models: { tester: 'bare-model-name' } })
      manager.getModelForRole('tester')
    } finally {
      console.warn = original
    }

    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain('missing provider prefix')
  })
})
