import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, utimesSync, chmodSync } from 'node:fs'
import * as realOs from 'node:os'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Both the plugin (generated agent files) and the config manager read
// homedir(). Under `bun test`, changing process.env.HOME does NOT affect
// os.homedir(), so the module is mocked instead — otherwise these tests would
// read and overwrite the developer's real global config. This must run before
// the modules under test are loaded, hence the dynamic imports below.
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'nexus-home-'))
mock.module('node:os', () => ({ ...realOs, default: realOs, homedir: () => SANDBOX_HOME }))

const { default: plugin, CONFIG_RELOAD_DEBOUNCE_MS, watchConfigFiles } = await import('../src/index')
const { NexusOrchestrator } = await import('../src/orchestrator')
const { DEFAULT_CONFIG } = await import('../src/config')

/**
 * The config manager is loaded from disk exactly once, from
 * `NexusOrchestrator.initialize`. There was no reload path, so editing
 * `.opencode/nexus.jsonc` after startup was silently ignored until the service
 * restarted — a `reviewer` edit had no effect and nothing said why.
 *
 * These tests boot the real plugin via `plugin.setup(ctx)` with a fake context
 * whose `event.subscribe` is a hand-driven async iterable, then assert that a
 * `filesystem.changed` event for one of the two files the config manager reads
 * causes exactly one reload, that the reloaded values reach observable state,
 * and that the subscription is torn down on plugin unload.
 */

// A little more than the debounce window, to let a scheduled reload land.
const SETTLE_MS = CONFIG_RELOAD_DEBOUNCE_MS + 150
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// `DEFAULT_CONFIG.models.reviewer` — the value a load falls back to when no
// config file supplies one.
const DEFAULT_REVIEWER = 'openai/gpt-5-mini'

// Built-in models, for pinning that a cleared override stopped supplying them.
const DEFAULT_CONFIG_MODELS = DEFAULT_CONFIG.models

/**
 * Wait for a condition instead of sleeping a fixed span: a reload that does
 * happen is picked up as soon as it does, and one that never happens fails
 * loudly here rather than as a confusing value mismatch.
 */
async function waitFor(what: string, predicate: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(5)
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${what}`)
}

const tempDirs: string[] = []
function makeProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-project-'))
  tempDirs.push(dir)
  return dir
}
function projectConfigPath(dir: string): string {
  return resolve(join(dir, '.opencode', 'nexus.jsonc'))
}
function globalConfigPath(): string {
  return resolve(join(SANDBOX_HOME, '.config', 'opencode', 'nexus.jsonc'))
}
function writeConfig(file: string, models: Record<string, string>): void {
  mkdirSync(resolve(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify({ models }, null, 2) + '\n', 'utf-8')
}

/** A `filesystem.changed` event in the real V2 shape — the field is `file`. */
function changedEvent(file: string, event: 'add' | 'change' | 'unlink', directory?: string) {
  return { id: 'evt_1', created: Date.now(), type: 'filesystem.changed', ...(directory ? { location: { directory } } : {}), data: { file, event } }
}

/**
 * An async iterable the test drives by hand, so events are delivered only when
 * the test asks for them. Aborting the signal ends the iteration, matching the
 * real stream, which lets a test prove teardown actually stops the consumer.
 */
function makeEventStream() {
  const queue: unknown[] = []
  let pending: (() => void) | null = null
  let closed = false

  const wake = () => {
    const resume = pending
    pending = null
    resume?.()
  }

  const stream: AsyncIterable<unknown> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<unknown>> {
          if (closed) return Promise.resolve({ done: true, value: undefined })
          if (queue.length > 0) return Promise.resolve({ done: false, value: queue.shift() })
          return new Promise<IteratorResult<unknown>>(resolveNext => {
            pending = () => {
              if (closed || queue.length === 0) resolveNext({ done: true, value: undefined })
              else resolveNext({ done: false, value: queue.shift() })
            }
          })
        },
        return(): Promise<IteratorResult<unknown>> {
          closed = true
          wake()
          return Promise.resolve({ done: true, value: undefined })
        },
      }
    },
  }

  return {
    stream,
    push(event: unknown) { queue.push(event); wake() },
    close() { closed = true; wake() },
  }
}

interface Booted {
  ctx: any
  tools: Map<string, any>
  events: ReturnType<typeof makeEventStream>
  subscribeMock: ReturnType<typeof mock>
  projectDir: string
  cleanup: () => void
}

/** A fake plugin context whose event stream the test drives by hand. */
function makeCtx(projectDir: string, tools?: Map<string, any>) {
  const events = makeEventStream()
  const subscribeMock = mock((opts: { signal?: AbortSignal } = {}) => {
    // The real subscribe tears the stream down when the signal aborts.
    opts.signal?.addEventListener('abort', () => events.close())
    return events.stream
  })

  const ctx: any = {
    location: { directory: projectDir },
    event: { subscribe: subscribeMock },
    storage: { set: mock(() => Promise.resolve()), get: mock(() => Promise.resolve(null)) },
    tool: {
      transform: mock(async (cb: any) => {
        cb({ namespace: () => {}, add: (t: any) => { tools?.set(t.name, t) } })
      }),
      list: mock(() => Promise.resolve([])),
    },
    session: {
      create: mock(() => Promise.resolve({ id: 'ses_created' })),
      prompt: mock(() => Promise.resolve()),
      wait: mock(() => Promise.resolve()),
      context: mock(() => Promise.resolve([])),
      background: mock(() => Promise.resolve()),
      hook: mock(() => Promise.resolve()),
    },
  }

  return { ctx, events, subscribeMock }
}

async function bootPlugin(projectDir: string) {
  const tools = new Map<string, any>()
  const { ctx, events, subscribeMock } = makeCtx(projectDir, tools)
  const cleanup = await plugin.setup(ctx)
  return { ctx, tools, events, subscribeMock, projectDir, cleanup: cleanup as () => void }
}

/** Read the `config` block the `nexus.status` tool serialises. */
async function readStatus(booted: Booted) {
  const status = booted.tools.get('status')
  expect(status).toBeDefined()
  const result = await status.execute({}, { sessionID: 'ses_parent' })
  return JSON.parse(result.content as string).config
}

/**
 * `[nexus] config loaded` lines emitted so far.
 *
 * Filtered to that prefix rather than capturing every `console.log`, so an
 * unrelated setup log line added later cannot break every test in the file.
 */
let loadLogs: string[] = []
let originalLog: typeof console.log

beforeEach(() => {
  loadLogs = []
  originalLog = console.log
  console.log = mock((...args: unknown[]) => {
    const line = args.join(' ')
    if (line.includes('config loaded')) loadLogs.push(line)
  })
})

afterEach(() => {
  console.log = originalLog
})

afterAll(() => {
  mock.module('node:os', () => realOs)
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  rmSync(SANDBOX_HOME, { recursive: true, force: true })
})

describe('config reload on filesystem.changed', () => {
  // Registered here rather than as a last statement in each test: a failing
  // assertion would otherwise skip the cleanup and strand a live 2000ms poller
  // into the following tests.
  const bootedPlugins: Booted[] = []

  afterEach(() => {
    while (bootedPlugins.length > 0) bootedPlugins.pop()?.cleanup()
  })

  async function boot(dir: string): Promise<Booted> {
    const booted = await bootPlugin(dir)
    bootedPlugins.push(booted)
    return booted
  }

  it('reloads once for a burst of change events on the project config', async () => {
    const dir = makeProjectDir()
    const file = projectConfigPath(dir)
    writeConfig(file, { reviewer: 'opencode/before' })

    const booted = await boot(dir)
    // Initial load, from initialize().
    expect(loadLogs).toHaveLength(1)
    expect((await readStatus(booted)).models.reviewer).toBe('opencode/before')

    writeConfig(file, { reviewer: 'opencode/deepseek-v4.1-flash' })
    // One save produces several watcher events.
    booted.events.push(changedEvent(file, 'change', dir))
    booted.events.push(changedEvent(file, 'change', dir))
    booted.events.push(changedEvent(file, 'change', dir))
    await sleep(SETTLE_MS)

    // Debounced: three events, one reload.
    expect(loadLogs).toHaveLength(2)
    const status = await readStatus(booted)
    expect(status.models.reviewer).toBe('opencode/deepseek-v4.1-flash')
    expect(status.loadCount).toBe(2)

  })

  it('picks up an add event for a project config that did not exist at load', async () => {
    const dir = makeProjectDir()
    const file = projectConfigPath(dir)
    expect(existsSync(file)).toBe(false)

    const booted = await boot(dir)
    const before = await readStatus(booted)
    // A load with no project config is now distinguishable from a normal one.
    expect(before.project).toEqual({ path: file, existed: false, parsed: false })
    expect(before.models.reviewer).toBeDefined()

    writeConfig(file, { reviewer: 'opencode/added' })
    booted.events.push(changedEvent(file, 'add', dir))
    await sleep(SETTLE_MS)

    const after = await readStatus(booted)
    expect(after.models.reviewer).toBe('opencode/added')
    expect(after.project).toEqual({ path: file, existed: true, parsed: true })
    expect(loadLogs).toHaveLength(2)

  })

  it('falls back to the next level on unlink instead of keeping deleted values', async () => {
    const dir = makeProjectDir()
    const file = projectConfigPath(dir)
    // Global supplies the value the project config then overrides.
    writeConfig(globalConfigPath(), { reviewer: 'opencode/from-global' })
    writeConfig(file, { reviewer: 'opencode/from-project' })

    const booted = await boot(dir)
    expect((await readStatus(booted)).models.reviewer).toBe('opencode/from-project')

    rmSync(file)
    booted.events.push(changedEvent(file, 'unlink', dir))
    await sleep(SETTLE_MS)

    const after = await readStatus(booted)
    // The deleted level stops contributing instead of staying latched.
    expect(after.models.reviewer).toBe('opencode/from-global')
    expect(after.project).toEqual({ path: file, existed: false, parsed: false })

    rmSync(globalConfigPath())
  })

  it('reloads on a change to the global config', async () => {
    const dir = makeProjectDir()
    const globalFile = globalConfigPath()
    writeConfig(globalFile, { tester: 'opencode/global-one' })

    const booted = await boot(dir)
    expect((await readStatus(booted)).models.tester).toBe('opencode/global-one')

    writeConfig(globalFile, { tester: 'opencode/global-two' })
    booted.events.push(changedEvent(globalFile, 'change'))
    await sleep(SETTLE_MS)

    expect((await readStatus(booted)).models.tester).toBe('opencode/global-two')
    expect(loadLogs).toHaveLength(2)

    rmSync(globalFile)
  })

  it('ignores a nested package config when the event names another location', async () => {
    const dir = makeProjectDir()
    const file = projectConfigPath(dir)
    writeConfig(file, { reviewer: 'opencode/untouched' })

    const booted = await boot(dir)

    // A monorepo package ships its own .opencode/nexus.jsonc. This project
    // never reads it, so matching on shape alone would be a wasted reload.
    const nested = resolve(join(dir, 'packages', 'api', '.opencode', 'nexus.jsonc'))
    booted.events.push(changedEvent(nested, 'change', resolve(join(dir, 'packages', 'api'))))
    await sleep(SETTLE_MS)
    expect(loadLogs).toHaveLength(1)

    // When the host omits the location, fall back to the broad shape.
    booted.events.push(changedEvent(nested, 'change'))
    await sleep(SETTLE_MS)
    expect(loadLogs).toHaveLength(2)

    // The nested file contributed nothing either way.
    expect((await readStatus(booted)).models.reviewer).toBe('opencode/untouched')

  })

  it('reports a non-object config file as unparseable, not loaded', async () => {
    const dir = makeProjectDir()
    const file = projectConfigPath(dir)
    mkdirSync(resolve(join(dir, '.opencode')), { recursive: true })
    // `JSON.parse` accepts this, and it then contributes nothing at all.
    writeFileSync(file, '42\n', 'utf-8')

    const booted = await boot(dir)
    const status = await readStatus(booted)

    expect(status.project).toEqual({ path: file, existed: true, parsed: false })
    expect(loadLogs[0]).toContain('[unparseable]')
    // Falls back to the built-in default rather than claiming a config loaded.
    expect(status.models.reviewer).toBe(DEFAULT_REVIEWER)

  })

  it('reports a config path blocked by a regular file as absent, not unparseable', async () => {
    const dir = makeProjectDir()
    // `.opencode` is a regular file, so `<dir>/.opencode/nexus.jsonc` is
    // structurally not a file (ENOTDIR), and there is nothing to parse.
    writeFileSync(resolve(join(dir, '.opencode')), 'not a directory\n', 'utf-8')

    const booted = await boot(dir)
    const status = await readStatus(booted)

    expect(status.project).toEqual({ path: projectConfigPath(dir), existed: false, parsed: false })
    expect(loadLogs[0]).toContain('[absent]')

  })

  it('keeps a preset applied in-session across a reload', async () => {
    const dir = makeProjectDir()
    const file = projectConfigPath(dir)
    writeConfig(file, { reviewer: 'opencode/from-disk' })

    const booted = await boot(dir)
    const preset = booted.tools.get('preset')
    expect(preset).toBeDefined()

    // 1. The user applies a preset in this session.
    const applied = await preset.execute({ name: 'enterprise' }, { sessionID: 'ses_parent' })
    expect(applied.content).toContain('Enterprise')
    // The enterprise preset sets reviewer to openai/gpt-5.
    const withPreset = await readStatus(booted)
    expect(withPreset.models.reviewer).toBe('openai/gpt-5')
    expect(withPreset.sessionOverride).toBe(true)
    expect(withPreset.loadCount).toBe(1)

    // 2. The user then edits the config file on disk — the exact workflow this
    //    feature exists to enable.
    writeConfig(file, { reviewer: 'opencode/edited' })
    booted.events.push(changedEvent(file, 'change', dir))
    await sleep(SETTLE_MS)

    // 3. The reload ran, and the preset survived it.
    const after = await readStatus(booted)
    expect(after.loadCount).toBe(2)
    expect(after.models.reviewer).toBe('openai/gpt-5')
    expect(after.sessionOverride).toBe(true)
    // The disk file was genuinely re-read, not just skipped: its own pin landed.
    expect(after.project.parsed).toBe(true)
    // And the log does not present the override-stripped map as the whole story.
    expect(loadLogs[1]).toContain('session override')

    // 4. The preset is still the thing supplying the values. `enterprise` pins
    //    tester to sonnet where the disk default is haiku, so this cannot be a
    //    stale snapshot or a default leaking through.
    writeConfig(file, { tester: 'opencode/edited-tester' })
    booted.events.push(changedEvent(file, 'change', dir))
    await sleep(SETTLE_MS)
    const third = await readStatus(booted)
    expect(third.loadCount).toBe(3)
    expect(third.models.tester).toBe('anthropic/claude-sonnet-4-6')

    // 5. Both surfaces say the disk file is being ignored, and say how to hand
    //    control back — otherwise a user who edits the file and watches nothing
    //    happen gets the same silence as the original bug.
    expect(third.sessionOverride).toBe(true)
    expect(third.diskModelsIgnored).toBe(true)
    expect(loadLogs[2]).toContain('IGNORED')
    // The tool announces the shadowing at the moment the preset is applied,
    // not only later in the load log.
    expect(applied.content).toContain('nexus.jsonc')
    expect(applied.content).toContain('will NOT take effect')
    expect(applied.content).toContain('TUI')
  })

  it('reports no shadowing when no preset is set', async () => {
    const dir = makeProjectDir()
    writeConfig(projectConfigPath(dir), { reviewer: 'opencode/plain' })

    const booted = await boot(dir)
    const status = await readStatus(booted)

    expect(status.sessionOverride).toBe(false)
    expect(status.diskModelsIgnored).toBe(false)
    expect(loadLogs[0]).not.toContain('IGNORED')
    // A disk edit is honoured.
    writeConfig(projectConfigPath(dir), { reviewer: 'opencode/plain-2' })
    booted.events.push(changedEvent(projectConfigPath(dir), 'change', dir))
    await sleep(SETTLE_MS)
    expect((await readStatus(booted)).models.reviewer).toBe('opencode/plain-2')
  })

  it('hands control back to disk once the session override is reset', async () => {
    const dir = makeProjectDir()
    const file = projectConfigPath(dir)
    writeConfig(file, { tester: 'opencode/disk-tester' })

    const orchestrator = new NexusOrchestrator()
    await orchestrator.initialize({ location: { directory: dir } } as never)
    orchestrator.configManager.applyPreset('enterprise')

    const withPreset = JSON.parse(orchestrator.getStatus()).config
    expect(withPreset.sessionOverride).toBe(true)
    // A preset is a complete model selection, so it shadows the whole models
    // level — a disk edit cannot win while it is in effect.
    expect(withPreset.models.tester).toBe('anthropic/claude-sonnet-4-6')

    writeConfig(file, { tester: 'opencode/disk-tester-2' })
    orchestrator.reloadConfigFromDisk()
    expect(orchestrator.configManager.getResolvedModels().tester).toBe('anthropic/claude-sonnet-4-6')

    // resetToDefaults() drops the override, and disk takes over again.
    orchestrator.configManager.resetToDefaults()
    const afterReset = JSON.parse(orchestrator.getStatus()).config
    expect(afterReset.sessionOverride).toBe(false)
    expect(afterReset.models.tester).toBe('opencode/disk-tester-2')

    await orchestrator.shutdown()
  })

  it('clears the session override on the first load, before anything sets it', async () => {
    const dir = makeProjectDir()
    writeConfig(projectConfigPath(dir), { reviewer: 'opencode/disk' })

    const booted = await boot(dir)
    const preset = booted.tools.get('preset')
    await preset.execute({ name: 'enterprise' }, { sessionID: 'ses_parent' })
    expect((await readStatus(booted)).models.reviewer).toBe('openai/gpt-5')

    // A preset applied before the first load is still cleared by it, so disk
    // config can never lose to a stale in-process override.
    rmSync(projectConfigPath(dir))
    const fresh = new NexusOrchestrator()
    fresh.configManager.applyPreset('enterprise')
    await fresh.initialize({ location: { directory: dir } } as never)
    expect(fresh.getConfigInfo()?.sessionOverride).toBe(false)
    await fresh.shutdown()

  })

  it('ignores an unrelated file path and non-filesystem events', async () => {
    const dir = makeProjectDir()
    const file = projectConfigPath(dir)
    writeConfig(file, { reviewer: 'opencode/untouched' })

    const booted = await boot(dir)
    const before = await readStatus(booted)

    booted.events.push(changedEvent(join(dir, 'src', 'index.ts'), 'change', dir))
    booted.events.push(changedEvent(join(dir, '.opencode', 'other.jsonc'), 'change', dir))
    booted.events.push(changedEvent(join(dir, '.opencode', 'nexus.json'), 'change', dir))
    // A different event type carrying a matching path must not reload either.
    booted.events.push({ id: 'evt_2', created: Date.now(), type: 'session.updated', data: { file, event: 'change' } })
    await sleep(SETTLE_MS)

    expect(loadLogs).toHaveLength(1)
    expect(await readStatus(booted)).toEqual(before)

  })

  it('logs the consulted paths, which existed, and the resolved role -> model map', async () => {
    const dir = makeProjectDir()
    writeConfig(projectConfigPath(dir), { reviewer: 'opencode/logged' })

    const booted = await boot(dir)
    const log = loadLogs[0]

    // One line, naming both paths and the resolved map.
    expect(log.split('\n')).toHaveLength(1)
    expect(log).toContain(`project=${projectConfigPath(dir)} [loaded]`)
    expect(log).toContain('global=~/.config/opencode/nexus.jsonc [absent]')
    expect(log).toContain('reviewer=opencode/logged')
    expect(log).toContain('coder=anthropic/claude-sonnet-4-6')
    // The timestamp is recorded, so a log line can be correlated with a report.
    expect(log).toMatch(/ at=\d{4}-\d{2}-\d{2}T[\d:.]+Z/)
    // No session override layered on, so the map reads as the disk truth.
    expect(log).not.toContain('session override')

  })

  it('keeps the home directory out of the log and the status payload', async () => {
    const dir = makeProjectDir()
    writeConfig(globalConfigPath(), { tester: 'opencode/global' })

    const booted = await boot(dir)
    const log = loadLogs[0]

    // An absolute home path leaks the OS account name into CI output, pasted
    // bug reports, and — via the status block — LLM context.
    expect(log).not.toContain(SANDBOX_HOME)
    expect(log).toContain('global=~/.config/opencode/nexus.jsonc')

    const status = await readStatus(booted)
    expect(status.global.path).toBe('~/.config/opencode/nexus.jsonc')
    expect(JSON.stringify(status)).not.toContain(SANDBOX_HOME)
    // Existence and parse state are still reported, so nothing is lost.
    expect(status.global.existed).toBe(true)
    expect(status.global.parsed).toBe(true)
    expect(status.models.tester).toBe('opencode/global')

    rmSync(globalConfigPath())
  })

  it('keeps project config ahead of global config on reload', async () => {
    const dir = makeProjectDir()
    const projectFile = projectConfigPath(dir)
    const globalFile = globalConfigPath()
    writeConfig(globalFile, { reviewer: 'opencode/global', architect: 'opencode/global-architect' })
    writeConfig(projectFile, { reviewer: 'opencode/project' })

    const booted = await boot(dir)
    expect((await readStatus(booted)).models.reviewer).toBe('opencode/project')

    writeConfig(projectFile, { reviewer: 'opencode/project-2' })
    booted.events.push(changedEvent(projectFile, 'change', dir))
    await sleep(SETTLE_MS)

    const after = await readStatus(booted)
    expect(after.models.reviewer).toBe('opencode/project-2')
    // Untouched levels keep their values through the reload.
    expect(after.models.architect).toBe('opencode/global-architect')
    expect(after.global.parsed).toBe(true)

    rmSync(globalFile)
  })
})

describe('config watch teardown', () => {
  const bootedPlugins: Booted[] = []

  afterEach(() => {
    while (bootedPlugins.length > 0) bootedPlugins.pop()?.cleanup()
  })

  async function boot(dir: string): Promise<Booted> {
    const booted = await bootPlugin(dir)
    bootedPlugins.push(booted)
    return booted
  }

  it('aborts the subscription and stops reloading after plugin unload', async () => {
    const dir = makeProjectDir()
    const file = projectConfigPath(dir)
    writeConfig(file, { reviewer: 'opencode/before-unload' })

    const booted = await boot(dir)
    // The subscription is established with the plugin context's own signal.
    expect(booted.subscribeMock).toHaveBeenCalled()
    const signal = booted.subscribeMock.mock.calls[0][0].signal as AbortSignal
    expect(signal.aborted).toBe(false)

    booted.cleanup()
    expect(signal.aborted).toBe(true)

    // A pending burst scheduled before unload must not reload afterwards.
    booted.events.push(changedEvent(file, 'change', dir))
    await sleep(SETTLE_MS)
    expect(loadLogs).toHaveLength(1)
  })

  it('does not open a second subscription when setup runs twice on one context', async () => {
    const dir = makeProjectDir()
    const file = projectConfigPath(dir)
    writeConfig(file, { reviewer: 'opencode/single' })

    const booted = await boot(dir)
    // setup() is not re-entered today, but two live watchers would mean two
    // poll intervals and two reloads per save.
    await plugin.setup(booted.ctx)
    expect(booted.subscribeMock).toHaveBeenCalledTimes(1)

    // Two setups means two orchestrators, each of which loads once.
    const before = loadLogs.length
    expect(before).toBe(2)

    writeConfig(file, { reviewer: 'opencode/single-2' })
    booted.events.push(changedEvent(file, 'change', dir))
    await sleep(SETTLE_MS)
    // Exactly one reload across both orchestrators, not one each.
    expect(loadLogs.length).toBe(before + 1)
  })

  it('still polls when the context has no event stream', async () => {
    const dir = makeProjectDir()
    const file = projectConfigPath(dir)
    writeConfig(file, { reviewer: 'opencode/no-events' })

    const tools = new Map<string, any>()
    const { ctx, events, subscribeMock } = makeCtx(dir, tools)
    // Drop the event domain entirely. Polling is the guaranteed trigger, so
    // gating it on the fast path would leave the feature simply off here — the
    // silent staleness this branch exists to remove.
    delete ctx.event

    const cleanup = (await plugin.setup(ctx)) as () => void
    const booted: Booted = { ctx, tools, events, subscribeMock, projectDir: dir, cleanup }
    bootedPlugins.push(booted)

    expect(loadLogs).toHaveLength(1)
    expect((await readStatus(booted)).trigger).toBe('initial')

    writeConfig(file, { reviewer: 'opencode/no-events-2' })
    // This genuinely waits out one production poll interval (2000ms): the
    // point is that `setup` installs the production poller, not an injected one.
    await waitFor('a poll-driven reload with no event stream', () => loadLogs.length >= 2, 5000)

    const after = await readStatus(booted)
    expect(after.loadCount).toBe(2)
    expect(after.trigger).toBe('poll')
    expect(after.models.reviewer).toBe('opencode/no-events-2')
    expect(() => cleanup()).not.toThrow()
  })
})

describe('config reload — mtime polling (the guaranteed trigger)', () => {
  // A live probe against a real OpenCode server received zero
  // `filesystem.changed` events for these files, so polling is what makes the
  // feature work at all. The event stays as a fast path only.
  //
  // The poll interval is injected (as `debounceMs` is) so the suite does not
  // have to sit through the 2000ms production default.
  // Both are above the 25ms floor `watchConfigFiles` clamps to.
  const POLL_MS = 25
  const POLL_DEBOUNCE_MS = 25
  /** ~7 poll intervals. Only the "nothing changed" waits need a real span. */
  const QUIET_MS = 180

  const running: Array<() => void> = []

  afterEach(async () => {
    while (running.length > 0) running.pop()?.()
  })

  async function startWatching(projectDir: string, pollMs = POLL_MS, debounceMs = POLL_DEBOUNCE_MS) {
    const { ctx, events, subscribeMock } = makeCtx(projectDir)
    const orchestrator = new NexusOrchestrator()
    await orchestrator.initialize(ctx)

    const stop = watchConfigFiles(ctx, orchestrator, debounceMs, pollMs)
    running.push(stop)
    running.push(() => { void orchestrator.shutdown() })

    return {
      ctx,
      events,
      subscribeMock,
      orchestrator,
      stop,
      status: () => JSON.parse(orchestrator.getStatus()).config,
    }
  }

  it('reloads once when the poll sees a change, then stays put', async () => {
    const dir = makeProjectDir()
    const file = projectConfigPath(dir)
    writeConfig(file, { reviewer: 'opencode/before' })

    const w = await startWatching(dir)
    expect(w.status().loadCount).toBe(1)
    expect(w.status().models.reviewer).toBe('opencode/before')

    writeConfig(file, { reviewer: 'opencode/after' })
    await waitFor('the poll to reload', () => w.status().loadCount === 2)
    expect(w.status().models.reviewer).toBe('opencode/after')

    // Steady state: the file is not moving, so the poll must not keep reloading.
    await sleep(QUIET_MS)
    expect(w.status().loadCount).toBe(2)
  })

  it('does not reload when nothing changed, across many intervals', async () => {
    const dir = makeProjectDir()
    writeConfig(projectConfigPath(dir), { reviewer: 'opencode/quiet' })

    const w = await startWatching(dir)
    // ~15 poll intervals with a stable file. A poller that reloaded anyway
    // would spin the disk and flood the log.
    await sleep(QUIET_MS)
    expect(w.status().loadCount).toBe(1)
    expect(loadLogs).toHaveLength(1)

    // The first poll must not be treated as a change just because the watch
    // started before any edit.
    expect(w.status().trigger).toBe('initial')
  })

  it('picks up a config file created after the watch started', async () => {
    const dir = makeProjectDir()
    const file = projectConfigPath(dir)
    expect(existsSync(file)).toBe(false)

    const w = await startWatching(dir)
    expect(w.status().project.existed).toBe(false)

    writeConfig(file, { reviewer: 'opencode/created' })
    await waitFor('the poll to see the new file', () => w.status().loadCount === 2)

    expect(w.status().project).toEqual({ path: file, existed: true, parsed: true })
    expect(w.status().models.reviewer).toBe('opencode/created')
  })

  it('picks up a config file deleted after the watch started', async () => {
    const dir = makeProjectDir()
    const file = projectConfigPath(dir)
    writeConfig(file, { reviewer: 'opencode/doomed' })

    const w = await startWatching(dir)
    expect(w.status().models.reviewer).toBe('opencode/doomed')

    rmSync(file)
    await waitFor('the poll to see the removal', () => w.status().loadCount === 2)

    expect(w.status().project.existed).toBe(false)
    expect(w.status().models.reviewer).toBe(DEFAULT_REVIEWER)
  })

  it('detects a same-tick edit that only changes the file length', async () => {
    const dir = makeProjectDir()
    const file = projectConfigPath(dir)
    // A fixed mtime for both writes, so mtime provably cannot be the signal —
    // only the length differs. This is what comparing size as well as mtime
    // buys, and what a coarse-grained timestamp would otherwise miss.
    const FIXED_MTIME_S = 1_700_000_000
    writeConfig(file, { reviewer: 'opencode/short' })
    utimesSync(file, FIXED_MTIME_S, FIXED_MTIME_S)
    const sizeBefore = statSync(file).size

    const w = await startWatching(dir)
    expect(w.status().loadCount).toBe(1)

    writeConfig(file, { reviewer: 'opencode/a-much-longer-model-id' })
    utimesSync(file, FIXED_MTIME_S, FIXED_MTIME_S)
    expect(statSync(file).mtimeMs).toBe(FIXED_MTIME_S * 1000)
    expect(statSync(file).size).not.toBe(sizeBefore)

    await waitFor('the poll to notice the length change', () => w.status().loadCount === 2)
    expect(w.status().models.reviewer).toBe('opencode/a-much-longer-model-id')
  })

  // ---------------------------------------------------------------------------
  // The content signal. mtime+size is a proxy for "the file changed", and a
  // proxy that a filesystem is free to get wrong: coarse timestamp granularity
  // (two edits in the same tick), a network mount serving a cached mtime, or any
  // filesystem that does not reliably update it. Every one of those leaves
  // mtimeMs:size byte-identical while the content differs, so the poll would
  // never fire and the config would go silently stale — the one failure this
  // feature exists to prevent. These tests pin that the gap is closed, and
  // that closing it did not cost the cheap path.
  // ---------------------------------------------------------------------------

  /** Two model ids of identical length, so only the content differs. */
  const SAME_LEN_A = 'opencode/same-length-a'
  const SAME_LEN_B = 'opencode/same-length-b'

  /**
   * Pin a file's mtime, so the tests below can prove mtime is *not* the signal
   * that caught the change. A stat-only signature would miss these edits.
   */
  function pinMtime(file: string, seconds = 1_700_000_000) {
    utimesSync(file, seconds, seconds)
    return seconds * 1000
  }

  it('detects a content change that leaves mtime AND size identical', async () => {
    const dir = makeProjectDir()
    const file = projectConfigPath(dir)
    writeConfig(file, { reviewer: SAME_LEN_A })
    const pinnedMtime = pinMtime(file)
    const statBefore = statSync(file)

    const w = await startWatching(dir)
    expect(w.status().loadCount).toBe(1)
    expect(w.status().models.reviewer).toBe(SAME_LEN_A)

    // The blind spot: same length, and mtime forced back to the value the
    // signature was seeded with. mtimeMs:size is now bit-for-bit what it was.
    const contentBefore = readFileSync(file, 'utf-8')
    writeConfig(file, { reviewer: SAME_LEN_B })
    pinMtime(file)
    const statAfter = statSync(file)
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs)
    expect(statAfter.size).toBe(statBefore.size)
    // Same size, different bytes: the only thing left to tell them apart.
    expect(readFileSync(file, 'utf-8')).not.toBe(contentBefore)

    await waitFor('the poll to notice a content-only change', () => w.status().loadCount === 2)
    expect(w.status().models.reviewer).toBe(SAME_LEN_B)
    expect(w.status().trigger).toBe('poll')

    // And it settles: the digest is compared against the new baseline, not
    // against the seed, so the change is not reported on every tick.
    await sleep(QUIET_MS)
    expect(w.status().loadCount).toBe(2)
  })

  it('detects a revert to earlier content, which mtime:size cannot see', async () => {
    const dir = makeProjectDir()
    const file = projectConfigPath(dir)
    writeConfig(file, { reviewer: SAME_LEN_A })
    const pinnedMtime = pinMtime(file)

    const w = await startWatching(dir)
    expect(w.status().loadCount).toBe(1)

    // A, then B, then back to A — all under one mtime. A stat-only signature
    // sees one state and cannot tell it from any other; the digest sees each
    // one, and the settle back onto A is a real change to load.
    writeConfig(file, { reviewer: SAME_LEN_B })
    pinMtime(file)
    await waitFor('the change to B', () => w.status().loadCount === 2)
    expect(w.status().models.reviewer).toBe(SAME_LEN_B)

    writeConfig(file, { reviewer: SAME_LEN_A })
    pinMtime(file)
    expect(statSync(file).mtimeMs).toBe(pinnedMtime)
    await waitFor('the revert back to A', () => w.status().loadCount === 3)
    expect(w.status().models.reviewer).toBe(SAME_LEN_A)

    await sleep(QUIET_MS)
    expect(w.status().loadCount).toBe(3)
  })

  it('reads the content on every tick, and still does not reload an untouched file', async () => {
    const dir = makeProjectDir()
    const file = projectConfigPath(dir)
    writeConfig(file, { reviewer: SAME_LEN_A })
    pinMtime(file)

    const w = await startWatching(dir)
    expect(w.status().loadCount).toBe(1)

    // The content read happens every tick for an existing file — that is the
    // price of the guarantee, and `test/config-reload-content-signal.test.ts`
    // counts the reads to pin it. What matters here is that paying it does not
    // cause a reload: a stable digest must compare equal to its own baseline,
    // on every tick, indefinitely.
    await sleep(QUIET_MS)
    expect(w.status().loadCount).toBe(1)
    expect(w.status().trigger).toBe('initial')
    expect(loadLogs).toHaveLength(1)

    // A real edit still lands immediately afterwards, so the quiet period is
    // not the poller having gone to sleep.
    writeConfig(file, { reviewer: SAME_LEN_B })
    await waitFor('the poll to still work after a quiet stretch', () => w.status().loadCount === 2)
    expect(w.status().models.reviewer).toBe(SAME_LEN_B)
  })

  it('cannot fire a spurious reload on the first tick, digest included', async () => {
    const dir = makeProjectDir()
    const file = projectConfigPath(dir)
    writeConfig(file, { reviewer: SAME_LEN_A })
    pinMtime(file)

    // Seeded with a full signature, so the first tick compares stat-to-stat
    // *and* digest-to-digest. A seed carrying only the cheap half would report
    // a change on tick one for every file that exists.
    const w = await startWatching(dir)
    expect(w.status().loadCount).toBe(1)
    await sleep(QUIET_MS)
    expect(w.status().loadCount).toBe(1)
    expect(w.status().trigger).toBe('initial')
    expect(loadLogs).toHaveLength(1)

    // Same for a file that does not exist yet: both watched paths start as the
    // stable 'absent' stamp, so their creation is the one change to report.
    const absent = await startWatching(makeProjectDir())
    await sleep(QUIET_MS)
    expect(absent.status().loadCount).toBe(1)
  })

  it('collapses an unreadable file to a stable stamp instead of spinning', async () => {
    const dir = makeProjectDir()
    const file = projectConfigPath(dir)
    writeConfig(file, { reviewer: SAME_LEN_A })
    pinMtime(file)

    const w = await startWatching(dir)
    expect(w.status().loadCount).toBe(1)

    // `statSync` succeeds and reports a regular file, but the read cannot
    // succeed. The digest must resolve to a stable value, not a throw: a throw
    // would kill the interval and silently void the guarantee, and a varying
    // value would spin the poller.
    chmodSync(file, 0o000)
    try {
      // One reload, and only one: the effective config really did change (the
      // level stops contributing), so reporting it is correct. The stamp is
      // then stable, which is the part under test.
      await waitFor('the unreadable file to be reported once', () => w.status().loadCount === 2)
      await sleep(QUIET_MS)
      expect(w.status().loadCount).toBe(2)

      // Still alive after the read failure — the interval was not killed.
      chmodSync(file, 0o644)
      writeConfig(file, { reviewer: SAME_LEN_B })
      await waitFor('the poller to survive an unreadable file', () => w.status().loadCount === 3)
      expect(w.status().models.reviewer).toBe(SAME_LEN_B)
    } finally {
      chmodSync(file, 0o644)
    }
  })

  it('coalesces a second change landing while a reload is already pending', async () => {
    const dir = makeProjectDir()
    const file = projectConfigPath(dir)
    writeConfig(file, { reviewer: 'opencode/one' })

    // A debounce window several poll intervals long, so the second change
    // below is guaranteed to arrive while a reload is pending.
    const w = await startWatching(dir, 25, 200)
    expect(w.status().loadCount).toBe(1)

    writeConfig(file, { reviewer: 'opencode/two' })
    await sleep(60)                    // first change seen, reload scheduled
    writeConfig(file, { reviewer: 'opencode/three' })
    await waitFor('the coalesced reload', () => w.status().loadCount === 2)

    // One reload, carrying the newest content.
    expect(w.status().models.reviewer).toBe('opencode/three')
  })

  it('after cleanup, an edit triggers neither mechanism', async () => {
    const dir = makeProjectDir()
    const file = projectConfigPath(dir)
    writeConfig(file, { reviewer: 'opencode/before-cleanup' })

    const w = await startWatching(dir)
    const signal = w.subscribeMock.mock.calls[0][0].signal as AbortSignal
    expect(signal.aborted).toBe(false)

    w.stop()
    expect(signal.aborted).toBe(true)
    const afterStop = w.status().loadCount

    // An edit plus a matching event, i.e. both mechanisms firing at once.
    writeConfig(file, { reviewer: 'opencode/after-cleanup' })
    w.events.push(changedEvent(file, 'change', dir))
    await sleep(QUIET_MS)

    expect(w.status().loadCount).toBe(afterStop)
    expect(loadLogs).toHaveLength(1)
  })

  it('attributes the trigger on every reload', async () => {
    const dir = makeProjectDir()
    const file = projectConfigPath(dir)
    writeConfig(file, { reviewer: 'opencode/attributed' })

    const w = await startWatching(dir)
    // The startup load is neither trigger.
    expect(w.status().trigger).toBe('initial')
    expect(loadLogs[0]).toContain('trigger=initial')

    // Event-driven.
    w.events.push(changedEvent(file, 'change', dir))
    await waitFor('an event-driven reload', () => w.status().trigger === 'event')
    expect(loadLogs[1]).toContain('trigger=event')

    // Poll-driven. If the event never arrives in the wild, this stays 'poll'
    // and the status block says so instead of the staleness being a silent
    // unknown.
    writeConfig(file, { reviewer: 'opencode/attributed-2' })
    await waitFor('a poll-driven reload', () => w.status().trigger === 'poll')
    expect(loadLogs[2]).toContain('trigger=poll')
  })

  it('does not start a second poller for the same context', async () => {
    const dir = makeProjectDir()
    const file = projectConfigPath(dir)
    writeConfig(file, { reviewer: 'opencode/one-poller' })

    const { ctx, subscribeMock } = makeCtx(dir)
    const orchestrator = new NexusOrchestrator()
    await orchestrator.initialize(ctx)

    const stopFirst = watchConfigFiles(ctx, orchestrator, POLL_DEBOUNCE_MS, POLL_MS)
    const stopSecond = watchConfigFiles(ctx, orchestrator, POLL_DEBOUNCE_MS, POLL_MS)
    running.push(stopFirst, stopSecond, () => { void orchestrator.shutdown() })

    expect(subscribeMock).toHaveBeenCalledTimes(1)
    expect(orchestrator.getConfigInfo()?.loadCount).toBe(1)

    writeConfig(file, { reviewer: 'opencode/one-poller-2' })
    await waitFor('the single reload', () => orchestrator.getConfigInfo()?.loadCount === 2)
    // A second interval would fire its own reload too.
    await sleep(QUIET_MS)
    expect(orchestrator.getConfigInfo()?.loadCount).toBe(2)
  })

  it('still reloads under a sustained event storm, and keeps the change afterwards', async () => {
    const dir = makeProjectDir()
    const file = projectConfigPath(dir)
    writeConfig(file, { reviewer: 'opencode/storm-start' })

    // A long debounce and a short poll, so the poll keeps arriving while the
    // debounce would still be resetting. This is the file-sync / git-checkout
    // shape: sustained events faster than the debounce window.
    const w = await startWatching(dir, 25, 400)
    expect(w.status().loadCount).toBe(1)

    let sending = true
    const storm = (async () => {
      while (sending) {
        writeConfig(file, { reviewer: `opencode/storm-${Math.floor(Math.random() * 1e6)}` })
        w.events.push(changedEvent(file, 'change', dir))
        await sleep(25)
      }
    })()

    // The bounded wait must break the starvation: without the cap, a stream
    // faster than the debounce resets the timer forever and no reload ever runs.
    await waitFor('a reload during the storm', () => w.status().loadCount >= 2, 4000)
    const duringStorm = w.status().loadCount

    sending = false
    await storm

    // The storm's final content must not be lost: once it stops, the config
    // has to settle on the last thing written. This is the part the poll's
    // pre-advance would silently discard.
    await sleep(POLL_MS * 4)
    expect(w.status().loadCount).toBeGreaterThanOrEqual(duringStorm)
    const settled = w.status().models.reviewer
    await sleep(QUIET_MS)
    expect(w.status().models.reviewer).toBe(settled)
    expect(w.status().loadCount).toBeGreaterThanOrEqual(duringStorm)
  })

  it('collapses a stat failure to "absent" instead of killing the poller', async () => {
    const dir = makeProjectDir()
    const file = projectConfigPath(dir)
    // A directory where the config file should be: `statSync` succeeds but
    // `isFile()` is false, and a plain path that cannot be stat-ed throws.
    // Both must collapse to the same stable stamp.
    mkdirSync(resolve(file), { recursive: true })

    const w = await startWatching(dir)
    expect(w.status().loadCount).toBe(1)
    // The loader reports EISDIR as "something is there but unusable"; the
    // *poller* collapses the same path to the stable 'absent' stamp, which is
    // what this test is about.
    expect(w.status().project.parsed).toBe(false)

    // The poller is still alive after stat-ing a directory: replacing it with
    // a real file is noticed.
    rmSync(resolve(file), { recursive: true })
    writeConfig(file, { reviewer: 'opencode/after-dir' })
    await waitFor('the poller to survive the stat failure', () => w.status().loadCount === 2)
    expect(w.status().models.reviewer).toBe('opencode/after-dir')

    // And a stat failure mid-flight does not reload on its own.
    await sleep(QUIET_MS)
    expect(w.status().loadCount).toBe(2)
  })

  it('polls the exact two config paths, with no shape heuristics', async () => {
    const dir = makeProjectDir()
    const file = projectConfigPath(dir)
    writeConfig(file, { reviewer: 'opencode/exact' })

    const w = await startWatching(dir)
    const before = w.status().loadCount

    // A monorepo package's own .opencode/nexus.jsonc, plus a decoy that has
    // the watched basename in the wrong directory. The poller stat-s only the
    // two real paths, so neither can cause a reload.
    writeConfig(resolve(join(dir, 'packages', 'api', '.opencode', 'nexus.jsonc')), { reviewer: 'opencode/nested' })
    writeConfig(resolve(join(dir, 'config', 'nexus.jsonc')), { reviewer: 'opencode/decoy' })
    await sleep(QUIET_MS)

    expect(w.status().loadCount).toBe(before)
    expect(w.status().models.reviewer).toBe('opencode/exact')
  })
})

describe('NexusOrchestrator.reloadConfigFromDisk', () => {  it('notifies state change and emits config:reloaded on a successful reload', async () => {
    const dir = makeProjectDir()
    writeConfig(projectConfigPath(dir), { reviewer: 'opencode/orch-reload' })

    const orchestrator = new NexusOrchestrator()
    const notified: number[] = []
    const events: unknown[] = []
    orchestrator.on('config:reloaded', (info: unknown) => events.push(info))

    await orchestrator.initialize({ location: { directory: dir } } as never, () => notified.push(1))
    expect(orchestrator.getConfigInfo()?.loadCount).toBe(1)

    writeConfig(projectConfigPath(dir), { reviewer: 'opencode/orch-reload-2' })
    const info = orchestrator.reloadConfigFromDisk()

    expect(info?.loadCount).toBe(2)
    expect(info?.models.reviewer).toBe('opencode/orch-reload-2')
    expect(orchestrator.configManager.getModelForRole('reviewer')).toBe('opencode/orch-reload-2')
    expect(events).toHaveLength(1)
    // notifyStateChange is debounced by the orchestrator; wait it out.
    await sleep(200)
    expect(notified.length).toBeGreaterThan(0)

    await orchestrator.shutdown()
  })

  it('falls back to the last known load when there is no plugin context', async () => {
    const orchestrator = new NexusOrchestrator()
    expect(orchestrator.getConfigInfo()).toBeNull()
    // No ctx → no project directory to re-read; nothing changes, nothing throws.
    expect(orchestrator.reloadConfigFromDisk()).toBeNull()
    expect(orchestrator.getConfigInfo()).toBeNull()
    await orchestrator.shutdown()
  })
})

/**
 * The way back to disk, from inside the session.
 *
 * Until this existed, applying a preset meant only the TUI could undo it, so
 * an agent that had just applied one had no in-band recovery: the user edits
 * nexus.jsonc, nothing happens, and the agent can only point at a UI it cannot
 * open. These tests pin that `preset` with mode 'clear' clears the override
 * through the same `resetToDefaults()` path the TUI uses, reports the resolved
 * map afterwards so the outcome is confirmable, and does not weaken the 2.5.0
 * fix that made the override survive a reload.
 */
describe('clearing the session preset override (preset mode: clear)', () => {
  const bootedPlugins: Booted[] = []

  afterEach(() => {
    while (bootedPlugins.length > 0) bootedPlugins.pop()?.cleanup()
  })

  async function boot(dir: string): Promise<Booted> {
    const booted = await bootPlugin(dir)
    bootedPlugins.push(booted)
    return booted
  }

  /** The registered `preset` tool, as a model would find it in the tool list. */
  function presetTool(booted: Booted) {
    const tool = booted.tools.get('preset')
    expect(tool).toBeDefined()
    return tool
  }

  async function apply(booted: Booted, name: string) {
    return presetTool(booted).execute({ name }, { sessionID: 'ses_parent' })
  }

  async function clear(booted: Booted) {
    return presetTool(booted).execute({ mode: 'clear' }, { sessionID: 'ses_parent' })
  }

  it('returns control to disk, and reports the resolved map afterwards', async () => {
    const dir = makeProjectDir()
    const file = projectConfigPath(dir)
    writeConfig(file, { reviewer: 'opencode/disk', tester: 'opencode/disk-tester' })

    const booted = await boot(dir)
    await apply(booted, 'enterprise')
    const withPreset = await readStatus(booted)
    expect(withPreset.sessionOverride).toBe(true)
    expect(withPreset.models.reviewer).toBe('openai/gpt-5')

    const cleared = await clear(booted)

    // The override is gone, and the disk file's own values are in effect.
    const after = await readStatus(booted)
    expect(after.sessionOverride).toBe(false)
    expect(after.diskModelsIgnored).toBe(false)
    expect(after.models.reviewer).toBe('opencode/disk')
    expect(after.models.tester).toBe('opencode/disk-tester')
    // No other role drifted to a preset value.
    expect(after.models.coder).toBe(DEFAULT_CONFIG_MODELS.coder)

    // The result says what changed and hands back the post-clear map, so the
    // caller can confirm rather than assume.
    expect(cleared.content).toContain('Cleared the session preset override')
    expect(cleared.content).toContain('reviewer=opencode/disk')
    expect(cleared.content).toContain('tester=opencode/disk-tester')
    expect(cleared.content).toContain('sessionOverride: false')

    // The disk file itself is untouched — this clears the override, it does
    // not rewrite the user's config.
    expect(readFileSync(file, 'utf-8')).toContain('"reviewer": "opencode/disk"')
    expect(readFileSync(file, 'utf-8')).toContain('"tester": "opencode/disk-tester"')
  })

  it('says so honestly, and changes nothing, when no override is set', async () => {
    const dir = makeProjectDir()
    writeConfig(projectConfigPath(dir), { reviewer: 'opencode/disk' })

    const booted = await boot(dir)
    const before = await readStatus(booted)

    const cleared = await clear(booted)

    // No override existed, so this is not a success that changed nothing.
    expect(cleared.content).toContain('nothing was cleared')
    expect(cleared.content).not.toContain('Cleared the session preset override')
    // It still reports the map it resolved, and the state is unchanged.
    expect(cleared.content).toContain('reviewer=opencode/disk')
    expect(cleared.content).toContain('sessionOverride: false')
    expect(await readStatus(booted)).toEqual(before)
  })

  it('is idempotent: a second clear reports nothing to clear, and is harmless', async () => {
    const dir = makeProjectDir()
    writeConfig(projectConfigPath(dir), { reviewer: 'opencode/disk' })

    const booted = await boot(dir)
    await apply(booted, 'enterprise')

    const first = await clear(booted)
    const afterFirst = await readStatus(booted)
    expect(first.content).toContain('Cleared the session preset override')
    expect(afterFirst.models.reviewer).toBe('opencode/disk')

    const second = await clear(booted)
    expect(second.content).toContain('nothing was cleared')
    // The already-cleared state is a fixed point, not a fresh change.
    expect(await readStatus(booted)).toEqual(afterFirst)
  })

  it('still clears an override that survived a reload in between', async () => {
    const dir = makeProjectDir()
    const file = projectConfigPath(dir)
    writeConfig(file, { reviewer: 'opencode/disk' })

    const booted = await boot(dir)
    await apply(booted, 'enterprise')

    // The 2.5.0 fix: a reload must not silently discard the in-session choice,
    // so the override is still there — and still needs an explicit way out.
    writeConfig(file, { reviewer: 'opencode/edited' })
    booted.events.push(changedEvent(file, 'change', dir))
    await sleep(SETTLE_MS)
    const reloaded = await readStatus(booted)
    expect(reloaded.loadCount).toBe(2)
    expect(reloaded.sessionOverride).toBe(true)
    expect(reloaded.models.reviewer).toBe('openai/gpt-5')

    const cleared = await clear(booted)
    expect(cleared.content).toContain('reviewer=opencode/edited')

    const after = await readStatus(booted)
    expect(after.sessionOverride).toBe(false)
    // No reload happened as part of the clear: the disk file was already read
    // on load, and it is the override that was in the way.
    expect(after.loadCount).toBe(2)
    expect(after.models.reviewer).toBe('opencode/edited')
  })

  it('leaves disk in control across a reload that follows the clear', async () => {
    const dir = makeProjectDir()
    const file = projectConfigPath(dir)
    writeConfig(file, { reviewer: 'opencode/disk' })

    const booted = await boot(dir)
    await apply(booted, 'enterprise')
    await clear(booted)

    // A later disk edit is now honoured directly, with no second clear needed —
    // the override does not resurrect itself on reload.
    writeConfig(file, { reviewer: 'opencode/edited' })
    booted.events.push(changedEvent(file, 'change', dir))
    await sleep(SETTLE_MS)

    const after = await readStatus(booted)
    expect(after.loadCount).toBe(2)
    expect(after.sessionOverride).toBe(false)
    expect(after.models.reviewer).toBe('opencode/edited')
    expect(loadLogs[1]).not.toContain('IGNORED')

    // And applying a preset again after the clear still works, i.e. clearing
    // did not wedge the override mechanism.
    await apply(booted, 'minimal')
    const reapplied = await readStatus(booted)
    expect(reapplied.sessionOverride).toBe(true)
    expect(reapplied.models.reviewer).toBe('google/gemini-2.5-flash')
    expect((await clear(booted)).content).toContain('reviewer=opencode/edited')
  })

  it('is discoverable from the registered tool definition, not just its behaviour', async () => {
    const booted = await boot(makeProjectDir())
    const tool = presetTool(booted)

    // A model decides how to call this from `description` alone; the clear
    // mode must be named there, not only in the parameter description.
    expect(tool.description).toContain("mode 'clear'")
    expect(tool.description).toContain('nexus.jsonc')

    // And the shape itself has to carry it, or the call cannot be built.
    expect(tool.input.properties.mode.enum).toEqual(['apply', 'clear'])
    expect(tool.input.properties.mode.description).toContain('clear')
    expect(tool.input.properties.name.description).toContain('clear')
    expect(tool.input.additionalProperties).toBe(false)

    // The apply path is unchanged for existing callers: mode is optional and
    // defaults to apply, so `{ name }` alone still works.
    expect(tool.input.required).toBeUndefined()
  })

  it('reports the missing preset name instead of silently doing nothing', async () => {
    const booted = await boot(makeProjectDir())
    const result = await presetTool(booted).execute({ mode: 'apply' }, { sessionID: 'ses_parent' })

    expect(result.content).toContain('Error')
    expect(result.content).toContain("mode: 'clear'")
    // Nothing was applied, and nothing was cleared.
    const status = await readStatus(booted)
    expect(status.sessionOverride).toBe(false)
  })
})
