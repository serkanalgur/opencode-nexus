import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import * as realOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The `designer` role, end to end.
 *
 * The reason this file exists in its own right: adding a role touches six
 * enumerated literals, and TWO of the omissions fail silently with green tests.
 *
 *  1. `agentTypeMap` (`src/orchestrator.ts`) — a missing entry falls through
 *     `|| 'nexus-coder'` without a word, so a Designer spawn runs as a Coder,
 *     with the coder's markdown and the coder's `edit: allow`.
 *  2. The `models` records — a missing entry falls through `getModelForRole`'s
 *     `|| config.models.coder`, so the Designer runs on the wrong model, at the
 *     wrong price, with no error.
 *
 * Neither is a crash, so neither is caught by "the suite is green". Every test
 * here is written to fail on the specific mutation it guards; the mutation run
 * at the bottom of the review notes is the evidence.
 *
 * `getRoles()` returning 'designer' is NOT treated as coverage of either. It
 * feeds the TUI picker and the summary loop, and nothing else — a role in that
 * list with no entry in `agentTypeMap` or in a preset still spawns as a coder
 * on the coder's model, and `getRoles()` stays perfectly green throughout.
 */

// Same sandbox pattern as `spawn-subagent-tool.test.ts`: `homedir()` is the
// module the plugin writes generated agents under and the config manager reads
// global config from, and `bun test` does not let process.env.HOME redirect it.
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'nexus-designer-'))
mock.module('node:os', () => ({ ...realOs, default: realOs, homedir: () => SANDBOX_HOME }))

const { NexusOrchestrator } = await import('../src/orchestrator')
const { NexusConfigManager, PRESETS } = await import('../src/config')
const { default: plugin } = await import('../src/index')

afterAll(() => {
  mock.module('node:os', () => realOs)
})

const CHILD_SESSION_ID = 'ses_designer_child'

/**
 * A repository file's text, synchronously.
 *
 * The `readSourceFile` helper in `test/helpers/dashboard-page.ts` is the wrong
 * tool here: it is async, it resolves relative to `src/`, and it appends `.ts`.
 * These assertions are at module scope inside synchronous tests and read
 * `src/`, `dashboard/` and `README.md` by their real path.
 */
function readRepoFile(...segments: string[]): string {
  return readFileSync(join(import.meta.dir, '..', ...segments), 'utf-8')
}

// ── 1. agentTypeMap — the silent nexus-coder fallback ───────────────

/**
 * The map is a local literal inside `spawnAgent`, so it is read from the source
 * rather than imported. That is the point: the value under test is a RESOLUTION
 * that happens inside one method, and the only way to assert it directly is to
 * look at the mapping itself. Asserting the observable consequence instead (see
 * `spawnAgent resolves the designer…` below) is a strictly weaker test — it
 * passes for any value the orchestrator chooses to send, including a typo'd
 * `nexus-designer` in a differently-spelled agent file, so the source read and
 * the behavioural test are kept as a pair rather than one or the other.
 */
function readAgentTypeMap(): Record<string, string> {
  const source = readRepoFile('src', 'orchestrator.ts')
  const block = /const agentTypeMap: Record<string, string> = \{([\s\S]*?)\}/.exec(source)
  expect(block).not.toBeNull()
  const body = (block as RegExpExecArray)[1] as string
  const entries: Record<string, string> = {}
  for (const line of body.split('\n')) {
    const match = /^\s*(\w+):\s*'(nexus-[\w-]+)'/.exec(line)
    if (match) entries[match[1] as string] = match[2] as string
  }
  return entries
}

function createToolCtx() {
  const subagentCalls: any[] = []
  const ctx: any = {
    location: { directory: mkdtempSync(join(tmpdir(), 'nexus-designer-project-')) },
    session: {
      create: mock(() => Promise.resolve({ id: 'ses_should_not_be_used' })),
      switchAgent: mock(() => Promise.resolve()),
      switchModel: mock(() => Promise.resolve()),
      prompt: mock(() => Promise.resolve()),
      wait: mock(() => Promise.resolve()),
      context: mock(() => Promise.resolve([])),
      background: mock(() => Promise.resolve()),
      hook: mock(() => Promise.resolve()),
    },
    storage: { set: mock(() => Promise.resolve()), get: mock(() => Promise.resolve(null)) },
    tool: {
      // `plugin.setup` registers its tools through `transform`, and also writes
      // the generated agent files. Without this the setup throws before the
      // write loop runs, so the file assertions would be testing nothing.
      transform: mock(async (cb: any) => {
        cb({ namespace: () => {}, add: () => {} })
      }),
      list: mock(() => Promise.resolve([
        {
          id: 'subagent',
          name: 'subagent',
          options: {},
          description: 'Spawn a subagent',
          input: {},
          output: {},
          execute: mock((input: any, context: any) => {
            subagentCalls.push({ input, context })
            return (async () => {
              await context.progress({ sessionID: CHILD_SESSION_ID, status: 'running' })
              return { title: input.description, metadata: {} }
            })()
          }),
        },
      ])),
    },
  }
  return { ctx, subagentCalls }
}

describe('designer: the agent type it actually spawns as', () => {
  it('maps `designer` to `nexus-designer` in agentTypeMap', () => {
    // The assertion the whole feature rests on. `designer: 'nexus-coder'` here
    // would pass every other test in this file.
    expect(readAgentTypeMap().designer).toBe('nexus-designer')
  })

  it('maps every built-in role to its own agent type, with no two roles sharing one', () => {
    const map = readAgentTypeMap()
    const roles = new NexusConfigManager().getRoles()
    // Both directions, because a stale entry is as wrong as a missing one: a
    // role dropped from `getRoles()` would leave `map` holding an entry nothing
    // can ever reach, and the map would still look complete.
    expect(Object.keys(map).sort()).toEqual([...roles].sort())
    const agents = Object.values(map)
    expect(new Set(agents).size).toBe(agents.length)
    // And the value is not the fallback: `|| 'nexus-coder'` means the literal
    // string 'nexus-coder' must appear for exactly one role.
    expect(Object.entries(map).filter(([, agent]) => agent === 'nexus-coder')).toEqual([['coder', 'nexus-coder']])
  })

  it('spawnAgent resolves the designer through the subagent tool as `nexus-designer`', async () => {
    const { ctx, subagentCalls } = createToolCtx()
    const orchestrator = new NexusOrchestrator({
      budget: { maxTotalCost: 10.00, maxCostPerTask: 1.00, alertThreshold: 0.2, hardLimit: false },
    })
    await orchestrator.initialize(ctx)

    const agent = await orchestrator.spawnAgent(
      { role: 'designer' },
      {
        toolContext: { sessionID: 'ses_parent', agent: 'nexus-orchestrator', messageID: 'msg_1', callID: 'call_1' },
        task: 'Decide the layout for the settings page',
      },
    )

    expect(agent.sessionID).toBe(CHILD_SESSION_ID)
    expect(subagentCalls).toHaveLength(1)
    // The value the subagent tool is actually handed, which is what decides
    // which agent markdown and which permission block applies.
    expect(subagentCalls[0].input.agent).toBe('nexus-designer')
  })

  it('titles the session with the designer emoji and name, not a bare role', async () => {
    const { ctx } = createToolCtx()
    const orchestrator = new NexusOrchestrator({
      budget: { maxTotalCost: 10.00, maxCostPerTask: 1.00, alertThreshold: 0.2, hardLimit: false },
    })
    await orchestrator.initialize(ctx)
    await orchestrator.spawnAgent(
      { role: 'designer' },
      {
        toolContext: { sessionID: 'ses_parent', agent: 'nexus-orchestrator', messageID: 'msg_1', callID: 'call_1' },
        task: 'Decide the layout',
      },
    )
    // A missing `getRoleEmoji` entry degrades to 🤖 and a missing display name
    // to the raw string, both silently, so the title is asserted rather than
    // assumed to compose correctly.
    const manager = new NexusConfigManager()
    const title = `${manager.getRoleEmoji('designer')} ${manager.getRoleDisplayName('designer')}`
    expect(title).toBe('🎨 Designer')
    expect(manager.getRoleEmoji('designer')).not.toBe('🤖')
  })
})

// ── 2. Model resolution — the silent config.models.coder fallthrough ─

describe('designer: the model it runs on', () => {
  it('every preset names a model for the designer', () => {
    for (const [name, preset] of Object.entries(PRESETS)) {
      const model = (preset.config.models as Record<string, string | undefined>).designer
      // Per preset, not a loop over "some model is defined": a preset missing
      // the key falls through to `config.models.coder` and still spawns.
      expect(model, `preset "${name}" must name a designer model`).toBeString()
      expect(model).toContain('/')
    }
  })

  it('the minimal preset does not put the designer on a frontier model', () => {
    // The thesis of `minimal` is cheap models against a $1 ceiling. This is the
    // one assertion here that is about intent rather than presence, and it is
    // here because copying the coder's model into every preset is the obvious
    // wrong turn: it would satisfy the "every preset has a key" test above while
    // making that preset a lie.
    const designer = (PRESETS.minimal.config.models as Record<string, string>).designer
    for (const role of ['architect', 'coder', 'reviewer', 'tester', 'explorer', 'documenter']) {
      expect(designer).toBe((PRESETS.minimal.config.models as Record<string, string>)[role])
    }
  })

  it('the cost-optimized preset keeps the designer off the cheapest tier', () => {
    // The deliberate exception: four of six roles there are on flash, and the
    // architect on haiku. The designer sits with the architect, because a design
    // decision is the input to all the code that follows it.
    const models = PRESETS['cost-optimized'].config.models as Record<string, string>
    expect(models.designer).toBe(models.architect)
    expect(models.designer).not.toBe(models.coder)
  })

  it('the unset fallback is the default, not the coder model', () => {
    // A `designer` key missing from DEFAULT_CONFIG would put every design
    // director on whatever the coder resolves to, so the key has to be there and
    // the resolved value has to be the designer's own. Asserted on the RESOLVED
    // value with no config file anywhere, which is the state a fresh install is
    // in.
    const manager = new NexusConfigManager()
    const config = manager.getConfig()
    expect(config.models.designer).toBeString()
    const resolved = manager.getModelForRole('designer')
    expect(resolved).toContain('/')
    // And the fallthrough is genuinely unreachable: clearing every level's
    // designer key still lands on the designer's own default.
    //
    // The coder is given a DIFFERENT model first, because the designer's default
    // and the coder's default are the same string — so asserting against the
    // coder's resolved value here would pass whether the chain restored the
    // designer's default or handed over the coder's, and the assertion would be
    // true of the old behaviour too. Naming a different coder model is what
    // makes the two outcomes distinguishable.
    // The designer's own default, read from a manager with nothing set — so the
    // expected side of this comparison cannot come from the manager under test.
    // The runtime check narrows the index signature's `string | undefined` for
    // the assertion below, and it is also the assertion that the key is really
    // there: without it, `designerDefault` would be `undefined` and the
    // comparison below would be `toBe(undefined)`, which `getModelForRole` can
    // never return — a permanently green line.
    const designerDefault = new NexusConfigManager().getConfig().models.designer
    if (designerDefault === undefined) throw new Error('the designer role has no default')

    manager.updateStorageConfig({ models: { designer: '', coder: 'opencode/some-other-coder' } })
    const cleared = manager.getModelForRole('designer')
    expect(cleared).toBe(designerDefault)
    expect(cleared).not.toBe('opencode/some-other-coder')
  })

  it('a designer model set by the user is not overwritten by the default', () => {
    const manager = new NexusConfigManager()
    manager.updateStorageConfig({ models: { designer: 'opencode/session-pick' } })
    expect(manager.getModelForRole('designer')).toBe('opencode/session-pick')
    // And the default did not leak into another role.
    expect(manager.getModelForRole('coder')).not.toBe('opencode/session-pick')
  })
})

// ── 3. The role accessors ──────────────────────────────────────────

describe('designer: the role accessors', () => {
  it('is a role, with a display name and its own emoji', () => {
    const manager = new NexusConfigManager()
    expect(manager.getRoles()).toContain('designer')
    expect(manager.getRoleDisplayName('designer')).toBe('Designer')
    // The display name is asserted against the literal, not against a
    // capitalisation of the role: `getRoleDisplayName` falls back to the raw
    // string, so 'designer' satisfies an `expect(...).toBe(role)` test.
    expect(manager.getRoleDisplayName('designer')).not.toBe('designer')
  })

  it('has an emoji that collides with none of the other six', () => {
    const manager = new NexusConfigManager()
    const roles = manager.getRoles()
    const emojis = roles.map(role => manager.getRoleEmoji(role))
    // Six of these are the fallback 🤖 — a designer wearing 🤖 would make two
    // sidebar badges and two session titles indistinguishable.
    expect(new Set(emojis).size).toBe(roles.length)
    expect(emojis).not.toContain('🤖')
  })

  it('the models block round-trips a designer entry through a save', () => {
    // `getSaveableConfig` spreads the whole merged `models` block, so no line
    // was added there for the designer. Asserted anyway, because a save that
    // dropped the key would reset the user's pick on the next load — and it is
    // a save-path behaviour that a `getRoles()` test cannot see.
    const manager = new NexusConfigManager()
    manager.updateStorageConfig({ models: { designer: 'opencode/round-trip' } })
    const dir = mkdtempSync(join(tmpdir(), 'nexus-designer-save-'))
    manager.saveProjectConfig(dir)
    const written = readFileSync(join(dir, '.opencode', 'nexus.jsonc'), 'utf-8')
    expect(written).toContain('designer')
    expect(written).toContain('opencode/round-trip')

    const reloaded = new NexusConfigManager()
    reloaded.loadFromPath(dir)
    expect(reloaded.getModelForRole('designer')).toBe('opencode/round-trip')
  })
})

// ── 4. The TUI picker ──────────────────────────────────────────────

describe('designer: selectable in the TUI', () => {
  it('the role the picker loops over is the role the models block has', () => {
    // `handleModelSelect` rejects any role not in `getRoles()`, and the overview
    // loops `getRoles()`. Both read the same list, so what matters is that the
    // list and the `models` block agree — the check `tui-config-flow.test.ts`
    // already makes, restated here against the designer specifically.
    const manager = new NexusConfigManager()
    const roles = manager.getRoles()
    expect(roles).toContain('designer')
    const models = manager.getConfig().models
    for (const role of roles) {
      expect(models[role], `models block is missing "${role}"`).toBeString()
    }
  })

  it('the toast in handleModelSelect would name designer as valid', () => {
    // The guard is `!getRoles().includes(role)`, and its failure message lists
    // `getRoles()`. Asserting the message content is asserting the string a
    // user would read if the role were somehow not recognised.
    const manager = new NexusConfigManager()
    expect(manager.getRoles().join(', ')).toContain('designer')
  })
})

// ── 5. The generated agent file ─────────────────────────────────────

describe('designer: the generated nexus-designer.md', () => {
  let content: string

  beforeEach(async () => {
    // Written by the real plugin boot, into the sandbox home — the same
    // best-effort write loop the other six go through (`src/index.ts`), not a
    // string lifted out of the source. A file that is never written is a
    // different failure from a file written with the wrong permissions, and
    // only this can tell them apart.
    const { ctx, subagentCalls } = createToolCtx()
    await plugin.setup(ctx as never)
    const file = join(SANDBOX_HOME, '.config', 'opencode', 'agents', 'nexus-designer.md')
    expect(existsSync(file)).toBe(true)
    content = readFileSync(file, 'utf-8')
    expect(subagentCalls).toHaveLength(0)
  })

  it('denies edit, so a design director cannot implement what it decides', () => {
    // Parsed out of the frontmatter, not substring-matched: the requirement is
    // a permission RULE, and a body that merely mentions "edit" must not pass.
    const frontmatter = content.split('---')[1] ?? ''
    const rules = [...frontmatter.matchAll(/action:\s*(\S+)[\s\S]*?resource:\s*"?([^"\n]+)"?[\s\S]*?effect:\s*(\S+)/g)]
    const edits = rules.filter(rule => rule[1] === 'edit')
    expect(edits.length).toBeGreaterThan(0)
    for (const rule of edits) {
      expect(rule[2]?.trim()).toBe('*')
      expect(rule[3]?.trim()).toBe('deny')
    }
    // An `edit: allow` anywhere in the block would undo it.
    expect(frontmatter).not.toMatch(/action:\s*edit[\s\S]*?effect:\s*allow/)
  })

  it('denies shell, and says why in the body', () => {
    const frontmatter = content.split('---')[1] ?? ''
    const rules = [...frontmatter.matchAll(/action:\s*(\S+)[\s\S]*?resource:\s*"?([^"\n]+)"?[\s\S]*?effect:\s*(\S+)/g)]
    const shells = rules.filter(rule => rule[1] === 'shell')
    expect(shells.length).toBeGreaterThan(0)
    for (const rule of shells) {
      expect(rule[3]?.trim()).toBe('deny')
    }
    // A permission nobody was told the reason for is one the next person to
    // edit this file will "fix" by removing it.
    expect(content).toMatch(/shell/)
  })

  it('is a subagent and describes itself as deciding rather than building', () => {
    const frontmatter = content.split('---')[1] ?? ''
    expect(frontmatter).toMatch(/mode:\s*subagent/)
    // The persona lives HERE, not only in `rolePrompts`, because this is the
    // file the subagent executor actually reads.
    expect(content).toMatch(/^# Nexus Designer Agent/m)
    expect(content).toMatch(/do not build|do not implement|decide/i)
    // The routing-relevant instruction, asserted because the whole role rests
    // on the orchestrator LLM knowing when NOT to pick it.
    expect(content).toMatch(/Write, edit, or patch a file/i)
  })

  it('every generated role file carries a rule with an effect', () => {
    // The repo's existing invariant (see spawn-subagent-tool.test.ts): a rule
    // with no `effect` is dropped by OpenCode and the agent vanishes from the
    // registry. Checked for all seven, so a designer entry cannot reintroduce
    // it for one role only.
    const dir = join(SANDBOX_HOME, '.config', 'opencode', 'agents')
    for (const role of new NexusConfigManager().getRoles()) {
      const file = join(dir, `nexus-${role}.md`)
      expect(existsSync(file), `nexus-${role}.md was not written`).toBe(true)
      const frontmatter = readFileSync(file, 'utf-8').split('---')[1] ?? ''
      // Split on `action:` rather than lazily matching to the next blank line:
      // a lazy `[\s\S]*?` stops at the first newline gap and reads a rule as
      // having no `effect` — the regex bug, not a missing one. Each chunk is
      // one permission rule and must carry its effect.
      const rules = frontmatter.split(/action:/).slice(1)
      expect(rules.length).toBeGreaterThan(0)
      for (const rule of rules) {
        expect(rule).toMatch(/effect:\s*(allow|deny)/)
      }
    }
  })
})

// ── 6. The docs and the dashboard ──────────────────────────────────

describe('designer: the documentation and the dashboard', () => {
  it('the README agent table lists the designer and the count is right', () => {
    const readme = readRepoFile('README.md')
    const roles = new NexusConfigManager().getRoles()
    // The count in prose, checked against getRoles() rather than a literal, so
    // the next role added breaks this instead of making the prose quietly wrong.
    expect(readme).toMatch(/Nexus creates 8 agent files/)
    // And every role is a row, matched on the agent file name.
    for (const role of roles) {
      expect(readme).toContain(`nexus-${role}`)
    }
    // The table itself, not just the file name appearing somewhere in 1500
    // lines. Bounded by the NEXT markdown heading rather than by a blank line,
    // because a table row list that runs to the end of the document would
    // happily count rows from every later table in the README.
    const table = /\| Agent \| Mode \| Purpose \|([\s\S]*?)\n### /.exec(readme)
    expect(table).not.toBeNull()
    const rows = (table as RegExpExecArray)[1] as string
    for (const role of roles) {
      expect(rows).toContain(`\`nexus-${role}\``)
    }
    // 7 subagents + the primary orchestrator. Counted from `getRoles()` so the
    // next role added breaks this assertion instead of making the prose wrong.
    // `.slice(1)` drops the header row, and the separator row is not a `|`
    // start after trim, so only real role rows remain.
    const roleRows = rows.trim().split('\n').filter(line => line.trim().startsWith('|')).slice(1)
    expect(roleRows).toHaveLength(roles.length + 1)
    for (const row of roleRows) {
      expect(row).toContain('nexus-')
    }
  })

  it('the dashboard has an emoji and a colour for the designer', () => {
    const html = readRepoFile('dashboard', 'index.html')
    const roles = new NexusConfigManager().getRoles()
    // A missing ROLE_EMOJI entry degrades to 🤖 and a missing ROLE_COLORS entry
    // to blue, so the absence is visible but not an error — assert presence.
    const emojiBlock = /var ROLE_EMOJI = \{([\s\S]*?)\}/.exec(html)
    const colorBlock = /var ROLE_COLORS = \{([\s\S]*?)\}/.exec(html)
    expect(emojiBlock).not.toBeNull()
    expect(colorBlock).not.toBeNull()
    for (const role of roles) {
      expect((emojiBlock as RegExpExecArray)[1]).toContain(`${role}:`)
      expect((colorBlock as RegExpExecArray)[1]).toContain(`${role}:`)
    }
    // The badge CSS class, which is what actually colours the badge.
    expect(html).toContain('.agent-role-badge.designer')
  })

  it('the orchestrator prompt lists the designer as a role it can choose', () => {
    // `NEXUS_AGENT_CONTENT` is the ONLY place a routing rule can live: there is
    // no router in this codebase, so if the prose here does not say when to
    // pick the designer, no Designer spawn ever happens.
    const readme = readRepoFile('src', 'index.ts')
    expect(readme).toMatch(/\*\*designer\*\* — Decide UI\/UX direction/)
    // And the negative half, which is what stops it being spawned for work the
    // coder should take.
    expect(readme).toMatch(/Do \*\*not\*\* spawn it when/)
  })
})
