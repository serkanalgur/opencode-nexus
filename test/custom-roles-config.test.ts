import { describe, it, expect, afterAll, beforeEach, mock } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as realOs from 'node:os'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { Task } from '../src/types'

/**
 * `customRoles` in `nexus.jsonc` used to do nothing at all.
 *
 * `CustomRoleManager.loadFromConfig` was the only reader of the key and had no
 * caller anywhere in `src/`, and `NexusConfigManager` did not model the block at
 * all — so there was nothing for a call to read even if one existed. A user who
 * followed the documented `customRoles` example got a role that was never
 * registered, no error, and — because `roles.list` told them to add it to
 * `nexus.jsonc` — an error message pointing at a config key that did nothing.
 *
 * HOME is sandboxed for the reason the other config tests give: the config
 * manager reads `homedir()/.config/opencode/nexus.jsonc` on every load, and
 * without this a developer's own global config decides the outcome.
 */
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'nexus-roles-home-'))
mock.module('node:os', () => ({ ...realOs, default: realOs, homedir: () => SANDBOX_HOME }))

const { NexusOrchestrator } = await import('../src/orchestrator')
const { NexusConfigManager } = await import('../src/config')
const { CustomRoleManager } = await import('../src/custom-roles')

const tempDirs: string[] = [SANDBOX_HOME]

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-roles-project-'))
  tempDirs.push(dir)
  return dir
}

function globalConfigPath(): string {
  return resolve(join(SANDBOX_HOME, '.config', 'opencode', 'nexus.jsonc'))
}

/** A project dir whose `nexus.jsonc` is the given object, verbatim. */
function projectWith(config: unknown): string {
  const dir = makeTempDir()
  mkdirSync(join(dir, '.opencode'), { recursive: true })
  writeFileSync(
    join(dir, '.opencode', 'nexus.jsonc'),
    `// sandboxed\n${JSON.stringify(config, null, 2)}\n`,
    'utf-8'
  )
  return dir
}

/** The saved file, with `writeJsoncFile`'s leading comment lines removed. */
function readProjectConfig(dir: string): Record<string, unknown> {
  const raw = readFileSync(join(dir, '.opencode', 'nexus.jsonc'), 'utf-8')
  const withoutComments = raw.split('\n').filter(line => !line.trimStart().startsWith('//')).join('\n')
  return JSON.parse(withoutComments) as Record<string, unknown>
}

/** The one role shape `README.md` documents, as a literal the test can read. */
const SECURITY_AUDITOR = {
  name: 'security-auditor',
  displayName: 'Security Auditor',
  emoji: '🔐',
  prompt: 'You are a security auditor. Report only what you can show.',
  model: 'anthropic/claude-sonnet-4-6'
}

type Ctx = {
  location: { directory: string }
  session: Record<string, unknown>
  storage: Record<string, unknown>
  promptArgs: () => Array<{ sessionID: string; text: string }>
}

function mockCtx(directory: string): Ctx {
  const sent: Array<{ sessionID: string; text: string }> = []
  return {
    location: { directory },
    session: {
      create: mock(() => Promise.resolve({ id: 'ses_roles_1' })),
      switchAgent: mock(() => Promise.resolve()),
      switchModel: mock(() => Promise.resolve()),
      prompt: mock((arg: { sessionID: string; text: string }) => { sent.push(arg); return Promise.resolve() }),
      wait: mock(() => Promise.resolve()),
      context: mock(() => Promise.resolve([{ type: 'assistant', content: [{ type: 'text', text: 'done' }] }])),
      background: mock(() => Promise.resolve()),
      hook: mock(() => Promise.resolve())
    },
    storage: { set: mock(() => Promise.resolve()), get: mock(() => Promise.resolve(null)) },
    promptArgs: () => sent
  }
}

/** Minimal `NexusPluginContext` for `initialize`, cast at the boundary only. */
function asPluginContext(ctx: Ctx): never {
  return ctx as unknown as never
}

function newOrchestrator(overrides?: Record<string, unknown>) {
  return new NexusOrchestrator({
    schedulerInterval: 1,
    selfHealing: { enabled: false, maxRetries: 0, retryDelay: 0, contextTransfer: false },
    budget: { maxTotalCost: 10.0, maxCostPerTask: 1.0, alertThreshold: 0.2, hardLimit: false },
    ...overrides
  } as never)
}

/**
 * Run one real task through the public execution path and return the prompt the
 * session was sent.
 *
 * `execute()` rather than the private `spawnAndExecute`, because this is a
 * claim about what an agent is TOLD and the strongest version of that claim
 * goes through the path a user's task actually takes. It also builds the DAG
 * the completion path needs, which poking the private method does not.
 */
function taskFor(role: string): Task {
  return {
    id: 'task-roles-1',
    name: 'Audit the sink',
    description: 'Check the HTML sink',
    requiredRole: role,
    complexity: {
      overall: 50,
      factors: { fileCount: 1, codeLines: 10, dependencyDepth: 0, domainKnowledge: 0, riskLevel: 'low' }
    },
    dependencies: [],
    files: { include: ['a.ts'] },
    priority: 'normal',
    status: 'pending'
  }
}

async function spawnOnce(orchestrator: InstanceType<typeof NexusOrchestrator>, role: string): Promise<string> {
  await orchestrator.execute({ tasks: [taskFor(role)] })
  return ''
}

afterAll(() => {
  mock.module('node:os', () => realOs)
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

describe('customRoles reaches the role a spawn uses', () => {
  it('registers the role from nexus.jsonc during initialize()', async () => {
    const dir = projectWith({ customRoles: [SECURITY_AUDITOR] })
    const ctx = mockCtx(dir)
    const orchestrator = newOrchestrator()
    await orchestrator.initialize(asPluginContext(ctx))
    try {
      const role = orchestrator.customRoles.get('security-auditor')
      expect(role).toBeDefined()
      expect(role?.prompt).toBe(SECURITY_AUDITOR.prompt)
      expect(role?.displayName).toBe('Security Auditor')
      expect(role?.emoji).toBe('🔐')
      expect(orchestrator.customRoles.list().map(r => r.name)).toEqual(['security-auditor'])
    } finally {
      orchestrator.shutdown()
    }
  })

  it('sends the custom prompt to the session, not the generic one', async () => {
    // The point of the whole change: a registered role has to change what the
    // agent is told, or the block is discovery-only and the README overstates
    // it. `buildRolePrompt` puts the custom prompt at the head of the task
    // prompt, and that string is what reaches `session.prompt`.
    const dir = projectWith({ customRoles: [SECURITY_AUDITOR] })
    const ctx = mockCtx(dir)
    const orchestrator = newOrchestrator()
    await orchestrator.initialize(asPluginContext(ctx))
    try {
      await spawnOnce(orchestrator, 'security-auditor')
      const prompts = ctx.promptArgs()
      expect(prompts).toHaveLength(1)
      expect(prompts[0]?.text).toContain(SECURITY_AUDITOR.prompt)
      // The generic fallback `buildRolePrompt` uses for an unknown role, which
      // is what a spawn would have got before the block was read at all.
      expect(prompts[0]?.text).not.toContain('You are a security-auditor. Complete the assigned task')
    } finally {
      orchestrator.shutdown()
    }
  })

  it("resolves the role's own `model` to what a spawn for it is configured with", async () => {
    // `model` on a custom role entry is documented, and before this change it
    // was read by nothing: `getModelForRole` knew only the `models` block, so a
    // role's entry said one model and the spawn used the `coder` default. It is
    // the first CANDIDATE for the role now, which is exactly what the same
    // string under `models` has always been — not a guarantee, because the
    // ranker still chooses among the candidates.
    const dir = projectWith({
      models: { 'security-auditor': 'opencode/from-models-block' },
      customRoles: [{ ...SECURITY_AUDITOR, model: 'opencode/from-custom-role' }]
    })
    const manager = new NexusConfigManager()
    manager.loadFromPath(dir)
    // The `models` block wins: it is the block whose whole job is a per-role
    // model, and `model` is one field of one role.
    expect(manager.getModelForRole('security-auditor')).toBe('opencode/from-models-block')
  })

  it('falls back to the custom role entry when the models block is silent', () => {
    const dir = projectWith({ customRoles: [{ ...SECURITY_AUDITOR, model: 'opencode/from-custom-role' }] })
    const manager = new NexusConfigManager()
    manager.loadFromPath(dir)
    expect(manager.getModelForRole('security-auditor')).toBe('opencode/from-custom-role')
  })

  it('registers roles given to the constructor, the way dashboard and notifications are', () => {
    // `customRolesBase` sits beneath the files and above the defaults, so both
    // ways of configuring a role resolve through the ONE `getConfig()` read
    // rather than through two consumers with no precedence between them.
    const manager = new NexusConfigManager(undefined, undefined, [SECURITY_AUDITOR])
    expect(manager.getConfig().customRoles).toEqual([SECURITY_AUDITOR])
  })

  it('lets a project file replace the constructor list rather than merging into it', async () => {
    const dir = projectWith({ customRoles: [{ name: 'from-file', prompt: 'From the file' }] })
    const ctx = mockCtx(dir)
    const orchestrator = newOrchestrator({ customRoles: [{ name: 'from-constructor', prompt: 'From the constructor' }] })
    await orchestrator.initialize(asPluginContext(ctx))
    try {
      expect(orchestrator.customRoles.has('from-file')).toBe(true)
      expect(orchestrator.customRoles.has('from-constructor')).toBe(false)
    } finally {
      orchestrator.shutdown()
    }
  })
})

describe('a custom role wins over a built-in of the same name', () => {
  it('overrides the built-in prompt, and only the prompt', async () => {
    // The precedence rule, stated as a test because nothing else states it:
    // `buildRolePrompt` consults the registry before the built-in prompt table,
    // so a custom role named `coder` replaces that role's system prompt.
    // Nothing else about the built-in moves — the model still comes from the
    // `models` block, which is the only place a role's model is read from.
    const dir = projectWith({ customRoles: [{ name: 'coder', prompt: 'You write only tests today.' }] })
    const ctx = mockCtx(dir)
    const orchestrator = newOrchestrator()
    await orchestrator.initialize(asPluginContext(ctx))
    try {
      await spawnOnce(orchestrator, 'coder')
      const prompts = ctx.promptArgs()
      expect(prompts[0]?.text).toContain('You write only tests today.')
      expect(prompts[0]?.text).not.toContain('You are a senior software engineer.')
    } finally {
      orchestrator.shutdown()
    }
  })
})

describe('a level that sets another block does not blank customRoles', () => {
  it('leaves the roles alone when the file sets only `notifications`', () => {
    // The `dashboard`-block regression from 2.7.0, in the shape an array block
    // could have reproduced it: a spread over a level that omits the key would
    // resolve the whole block from the winning level.
    const dir = projectWith({ notifications: { enabled: false }, customRoles: [SECURITY_AUDITOR] })
    const manager = new NexusConfigManager()
    manager.loadFromPath(dir)
    expect(manager.getConfig().customRoles).toEqual([SECURITY_AUDITOR])
    // And the sibling is not blanked by the roles in the other direction.
    expect(manager.getConfig().notifications).toEqual({ enabled: false })
  })

  it('a config file with no customRoles block resolves to none, not to undefined', () => {
    const dir = projectWith({ budget: { maxTotalCost: 10 } })
    const manager = new NexusConfigManager()
    manager.loadFromPath(dir)
    expect(manager.getConfig().customRoles).toEqual([])
  })

  it('a session model change does not shadow the file with an empty list', () => {
    // `setModel` creates the storage level when there is none, and it used to
    // seed it with a `DEFAULT_CONFIG` spread — which would have put a default
    // empty `customRoles` at the HIGHEST precedence level, winning over the
    // user's file. The `models` block is the only thing that call touches.
    const dir = projectWith({ customRoles: [SECURITY_AUDITOR] })
    const manager = new NexusConfigManager()
    manager.loadFromPath(dir)
    manager.setModel('reviewer', 'opencode/session-override')
    expect(manager.getConfig().customRoles).toEqual([SECURITY_AUDITOR])
    expect(manager.getModelForRole('reviewer')).toBe('opencode/session-override')
  })

  it('survives the TUI budget dialog, which is the real updateStorageConfig caller', () => {
    // The other way a session override is created, and the one a user reaches
    // by editing a budget. It sets only `budget`, so `customRoles` has to keep
    // resolving from the file rather than becoming absent.
    const dir = projectWith({ customRoles: [SECURITY_AUDITOR] })
    const manager = new NexusConfigManager()
    manager.loadFromPath(dir)
    // The call `src/tui.tsx` actually makes: a full `budget` block, and
    // nothing else.
    const budget = manager.getConfig().budget
    manager.updateStorageConfig({ budget: { ...budget, maxTotalCost: 3 } })
    expect(manager.getConfig().customRoles).toEqual([SECURITY_AUDITOR])
  })
})

describe('a save does not delete the roles', () => {
  it('round-trips through getSaveableConfig()', () => {
    // `saveProjectConfig` writes the RETURNED object as the whole file, so a
    // block left out of `getSaveableConfig` is a block deleted from the user's
    // `nexus.jsonc` the first time they change a model in the TUI.
    const dir = projectWith({ customRoles: [SECURITY_AUDITOR] })
    const manager = new NexusConfigManager()
    manager.loadFromPath(dir)
    const saveable = (manager as unknown as {
      getSaveableConfig: () => { customRoles?: unknown }
    }).getSaveableConfig()
    expect(saveable.customRoles).toEqual([SECURITY_AUDITOR])
  })

  it('survives a real save and reload of the project file', () => {
    const dir = projectWith({ customRoles: [SECURITY_AUDITOR] })
    const manager = new NexusConfigManager()
    manager.loadFromPath(dir)
    manager.setModel('reviewer', 'opencode/tui-change')
    manager.saveProjectConfig(dir)

    // Read the file back as JSON, not through the manager: the question is what
    // is on disk, and a manager that still holds the roles in memory would
    // agree either way.
    expect(readProjectConfig(dir).customRoles).toEqual([SECURITY_AUDITOR])

    const reloaded = new NexusConfigManager()
    reloaded.loadFromPath(dir)
    expect(reloaded.getConfig().customRoles).toEqual([SECURITY_AUDITOR])
    expect(reloaded.getModelForRole('reviewer')).toBe('opencode/tui-change')
  })
})

describe('a config reload re-reads the roles', () => {
  it('picks up a role added to the file, and drops one removed from it', async () => {
    // `notifications` is snapshotted at initialize and stays whatever the file
    // said then; `dashboard` is read live at each use. Roles are re-synced on
    // every load because the registry has to SHRINK as well as grow: a role
    // deleted from the file has to stop resolving, and an additive load cannot
    // do that. So a user editing `customRoles` does not need a restart.
    const dir = makeTempDir()
    const file = join(dir, '.opencode', 'nexus.jsonc')
    const write = (customRoles: unknown) => {
      mkdirSync(join(dir, '.opencode'), { recursive: true })
      writeFileSync(file, `${JSON.stringify({ customRoles }, null, 2)}\n`, 'utf-8')
    }
    write([SECURITY_AUDITOR])

    const ctx = mockCtx(dir)
    const orchestrator = newOrchestrator()
    await orchestrator.initialize(asPluginContext(ctx))
    try {
      expect(orchestrator.customRoles.has('security-auditor')).toBe(true)

      write([{ name: 'perf-reviewer', prompt: 'You profile things.' }])
      orchestrator.reloadConfigFromDisk('event')
      expect(orchestrator.customRoles.has('perf-reviewer')).toBe(true)
      // The role the user deleted is gone rather than latched.
      expect(orchestrator.customRoles.has('security-auditor')).toBe(false)

      write([])
      orchestrator.reloadConfigFromDisk('event')
      expect(orchestrator.customRoles.list()).toEqual([])
    } finally {
      orchestrator.shutdown()
    }
  })

  it('drops a role registered at runtime once the config is re-read', async () => {
    // The cost of the file being authoritative, pinned so it stays a decision:
    // `roles.add` registers for the session only, and its return message says so.
    const dir = projectWith({ customRoles: [] })
    const ctx = mockCtx(dir)
    const orchestrator = newOrchestrator()
    await orchestrator.initialize(asPluginContext(ctx))
    try {
      orchestrator.customRoles.register({ name: 'runtime-only', displayName: 'Runtime', emoji: '🤖', prompt: 'p' })
      expect(orchestrator.customRoles.has('runtime-only')).toBe(true)
      orchestrator.reloadConfigFromDisk('event')
      expect(orchestrator.customRoles.has('runtime-only')).toBe(false)
    } finally {
      orchestrator.shutdown()
    }
  })

  it('reads a global-level role when the project file says nothing about them', async () => {
    const globalFile = globalConfigPath()
    mkdirSync(join(SANDBOX_HOME, '.config', 'opencode'), { recursive: true })
    writeFileSync(globalFile, `${JSON.stringify({ customRoles: [{ name: 'global-role', prompt: 'From the global file' }] })}\n`, 'utf-8')
    const dir = projectWith({ budget: { maxTotalCost: 10 } })
    const ctx = mockCtx(dir)
    const orchestrator = newOrchestrator()
    await orchestrator.initialize(asPluginContext(ctx))
    try {
      expect(orchestrator.customRoles.getPrompt('global-role')).toBe('From the global file')
    } finally {
      orchestrator.shutdown()
      rmSync(globalFile, { force: true })
    }
  })
})

describe('a malformed or duplicate entry', () => {
  let warnings: string[]
  let originalWarn: typeof console.warn

  beforeEach(() => {
    warnings = []
    originalWarn = console.warn
    console.warn = mock((...args: unknown[]) => { warnings.push(args.map(String).join(' ')) })
  })

  const restore = () => { console.warn = originalWarn }

  it('skips an entry with no name, and says so', () => {
    const manager = new CustomRoleManager()
    const report = manager.loadFromConfig({ customRoles: [{ displayName: 'Nameless', prompt: 'p' }] })
    expect(manager.list()).toEqual([])
    expect(report.registered).toEqual([])
    expect(report.skipped).toHaveLength(1)
    // The behaviour being pinned: a malformed entry is SKIPPED, not registered
    // with an undefined key, and it is reported rather than dropped silently.
    expect(report.skipped[0]).toMatchObject({ index: 0, name: null })
    expect(warnings.join('\n')).toContain('customRoles[0]')
    restore()
  })

  it('skips an entry with no prompt, which would have behaved as if unregistered', () => {
    const manager = new CustomRoleManager()
    const report = manager.loadFromConfig({ customRoles: [{ name: 'promptless' }] })
    expect(manager.has('promptless')).toBe(false)
    expect(report.skipped[0]).toMatchObject({ name: 'promptless' })
    expect(report.skipped[0]?.reason).toContain('prompt')
    restore()
  })

  it('skips an entry that is not an object', () => {
    const manager = new CustomRoleManager()
    const report = manager.loadFromConfig({ customRoles: ['security-auditor', null, 42] })
    expect(manager.list()).toEqual([])
    expect(report.skipped).toHaveLength(3)
    restore()
  })

  it('reports a `customRoles` that is not an array, and registers nothing', () => {
    const manager = new CustomRoleManager()
    const report = manager.loadFromConfig({ customRoles: { name: 'x', prompt: 'p' } })
    expect(manager.list()).toEqual([])
    expect(report.skipped[0]?.reason).toContain('not an array')
    restore()
  })

  it('lets the later of two entries with one name win, and reports the shadowed one', () => {
    // Last wins, matching `register()`'s own `Map.set` and the way a later key
    // overrides an earlier one. The shadowed entry is REPORTED, so a copy-paste
    // that silently replaces a role is visible.
    const manager = new CustomRoleManager()
    const report = manager.loadFromConfig({
      customRoles: [
        { name: 'dupe', prompt: 'first' },
        { name: 'dupe', prompt: 'second' }
      ]
    })
    expect(manager.getPrompt('dupe')).toBe('second')
    expect(report.registered).toEqual(['dupe'])
    expect(report.skipped).toHaveLength(1)
    // The reported index is the SHADOWED entry, so it points at the line the
    // user has to delete rather than at the one that is in effect.
    expect(report.skipped[0]).toMatchObject({ index: 0, name: 'dupe' })
    expect(report.skipped[0]?.reason).toContain('later entry wins')
    restore()
  })

  it('defaults the presentation fields rather than rejecting the entry', () => {
    const manager = new CustomRoleManager()
    const report = manager.loadFromConfig({ customRoles: [{ name: 'terse', prompt: 'Be terse.' }] })
    expect(report.registered).toEqual(['terse'])
    expect(manager.get('terse')).toEqual({ name: 'terse', displayName: 'terse', emoji: '🤖', prompt: 'Be terse.' })
    restore()
  })

  it('keeps the valid entries around the malformed ones', () => {
    // Validation is per entry: one typo must not cost the user every role in
    // the file, which is what a whole-block reject would do.
    const manager = new CustomRoleManager()
    const report = manager.loadFromConfig({
      customRoles: [
        { name: 'good-one', prompt: 'p' },
        { name: 'bad-one' },
        { name: 'good-two', prompt: 'p' }
      ]
    })
    expect(report.registered).toEqual(['good-one', 'good-two'])
    expect(report.skipped).toHaveLength(1)
    restore()
  })

  it('replaces rather than accumulates, so a removed role stops resolving', () => {
    const manager = new CustomRoleManager()
    manager.loadFromConfig({ customRoles: [{ name: 'a', prompt: 'p' }] })
    manager.loadFromConfig({ customRoles: [{ name: 'b', prompt: 'p' }] })
    expect(manager.list().map(r => r.name)).toEqual(['b'])
    // And a load with no block at all clears the registry rather than leaving
    // the previous file's roles in place.
    manager.loadFromConfig({})
    expect(manager.list()).toEqual([])
    restore()
  })

  it('a malformed entry in the file does not stop the valid one being used', async () => {
    const dir = projectWith({ customRoles: [{ name: 'no-prompt' }, SECURITY_AUDITOR] })
    const ctx = mockCtx(dir)
    const orchestrator = newOrchestrator()
    await orchestrator.initialize(asPluginContext(ctx))
    try {
      expect(orchestrator.customRoles.has('no-prompt')).toBe(false)
      await spawnOnce(orchestrator, 'security-auditor')
      expect(ctx.promptArgs()[0]?.text).toContain(SECURITY_AUDITOR.prompt)
    } finally {
      orchestrator.shutdown()
    }
  })
})
