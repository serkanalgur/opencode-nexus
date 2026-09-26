import { describe, it, expect, afterEach, afterAll, mock } from 'bun:test'
import * as realFs from 'node:fs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import * as realOs from 'node:os'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * What the content signal costs, measured rather than asserted in prose.
 *
 * The poll's signature is `mtime:size|sha1(bytes)`, and the digest has to be
 * read on every tick that finds an existing regular file: "mtime did not move"
 * and "mtime is lying" are indistinguishable without looking at the bytes, so
 * there is no cheaper schedule that still closes the gap. What the stat tier
 * *does* buy is that a path which is not an existing regular file — the common
 * case, since most installs ship no project config at all — costs a `stat` and
 * no read.
 *
 * These tests count `readFileSync` calls through a counting wrapper, so the cost
 * model is pinned by the implementation rather than by a comment that can
 * quietly stop being true. The wrapper is a faithful pass-through, so the rest
 * of the suite is unaffected even if the module mock is never undone.
 */

// `require` rather than a namespace import: spreading the `node:fs` namespace
// object goes through its live getters, which re-enter the module under mock
// and hang the runner.
const realNodeFs = require('node:fs') as typeof realFs

let readCalls = 0
let statCalls = 0
const countingReadFileSync = (...args: unknown[]): unknown => {
  readCalls += 1
  return (realNodeFs.readFileSync as (...a: unknown[]) => unknown)(...args)
}
// `statSync` is counted as well, so "no reads" can be told apart from "the
// poller was not running" — without it, a dead poller would pass the test that
// asserts a cost of zero.
const countingStatSync = (...args: unknown[]): unknown => {
  statCalls += 1
  return (realNodeFs.statSync as (...a: unknown[]) => unknown)(...args)
}
mock.module('node:fs', () => ({
  ...realNodeFs,
  default: realNodeFs,
  readFileSync: countingReadFileSync,
  statSync: countingStatSync,
}))

const resetCounts = (): void => {
  readCalls = 0
  statCalls = 0
}

const { watchConfigFiles } = await import('../src/index')
const { NexusOrchestrator } = await import('../src/orchestrator')

// Both the plugin and the config manager read homedir(). `process.env.HOME` does
// not move os.homedir() under `bun test`, so the module is mocked — otherwise
// these tests would read and overwrite the developer's real global config.
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'nexus-home-'))
mock.module('node:os', () => ({ ...realOs, default: realOs, homedir: () => SANDBOX_HOME }))

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Above the 25ms floor `watchConfigFiles` clamps to. */
const POLL_MS = 25
const POLL_DEBOUNCE_MS = 25
const QUIET_MS = 180

const tempDirs: string[] = []
function makeProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-project-'))
  tempDirs.push(dir)
  return dir
}
function projectConfigPath(dir: string): string {
  return resolve(join(dir, '.opencode', 'nexus.jsonc'))
}
function writeConfig(file: string, models: Record<string, string>): void {
  mkdirSync(resolve(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify({ models }, null, 2) + '\n', 'utf-8')
}

/** A context with no event stream, so only the poller can cause a reload. */
function makeCtx(projectDir: string) {
  return {
    location: { directory: projectDir },
    storage: { set: mock(() => Promise.resolve()), get: mock(() => Promise.resolve(null)) },
    tool: {
      transform: mock(async (cb: (input: unknown) => void) => {
        cb({ namespace: () => {}, add: () => {} })
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
}

describe('config poll — what the content signal costs', () => {
  const running: Array<() => void> = []

  afterEach(async () => {
    while (running.length > 0) running.pop()?.()
  })

  async function startWatching(projectDir: string) {
    const ctx = makeCtx(projectDir)
    const orchestrator = new NexusOrchestrator()
    await orchestrator.initialize(ctx)

    const stop = watchConfigFiles(ctx as never, orchestrator, POLL_DEBOUNCE_MS, POLL_MS)
    running.push(stop)
    running.push(() => { void orchestrator.shutdown() })

    return { orchestrator, stop, loadCount: () => orchestrator.getConfigInfo()?.loadCount ?? 0 }
  }

  it('reads content on every tick for a file that exists', async () => {
    const dir = makeProjectDir()
    writeConfig(projectConfigPath(dir), { reviewer: 'opencode/quiet' })

    const w = await startWatching(dir)
    expect(w.loadCount()).toBe(1)

    // Measure only the ticks, not the startup: the baseline load reads the file
    // too, and the seed read is one read per path.
    resetCounts()
    await sleep(QUIET_MS)
    const afterQuiet = readCalls

    // ~7 ticks. The project config exists and is stable, so each tick must
    // still have read it — that is the price of detecting a change that leaves
    // mtime and size untouched. The global config does not exist, so it costs
    // a `stat` and contributes no reads, which is what bounds the count to
    // roughly one read per tick rather than two.
    expect(afterQuiet).toBeGreaterThanOrEqual(5)
    expect(afterQuiet).toBeLessThanOrEqual(14)
    // Two `stat`s per tick: the existing file and the absent one.
    expect(statCalls).toBeGreaterThanOrEqual(2 * 5)

    // The reads bought correctness, not churn: a stable digest is not a change.
    expect(w.loadCount()).toBe(1)

    // And the cost is not the signature's being unstable: the count keeps
    // tracking the ticks rather than collapsing to zero, so the digest really
    // is being recomputed and compared.
    resetCounts()
    await sleep(QUIET_MS)
    expect(readCalls).toBeGreaterThanOrEqual(5)
    expect(w.loadCount()).toBe(1)
  })

  it('reads nothing at all when neither config file exists', async () => {
    // The default shape of a fresh checkout: no `.opencode/nexus.jsonc`, and no
    // global one. Both watched paths stat to the stable 'absent' stamp, so the
    // poller never opens a file at all. Without this the content signal would
    // tax every install on reads it cannot benefit from.
    const w = await startWatching(makeProjectDir())
    expect(w.loadCount()).toBe(1)

    resetCounts()
    await sleep(QUIET_MS)

    expect(readCalls).toBe(0)
    // Both watched paths were still visited on every tick, so the zero above is
    // the guard doing its job and not a poller that stopped running.
    expect(statCalls).toBeGreaterThanOrEqual(10)
    expect(w.loadCount()).toBe(1)
  })

  it('does not read a path that is a directory, and still notices the real file after it', async () => {
    const dir = makeProjectDir()
    const file = projectConfigPath(dir)
    // `statSync` succeeds but `isFile()` is false, so the path collapses to
    // 'absent' and the read is never attempted — attempting it would throw on
    // every tick, which is the spin the stable stamp exists to prevent.
    mkdirSync(file, { recursive: true })

    const w = await startWatching(dir)
    resetCounts()
    await sleep(QUIET_MS)
    expect(readCalls).toBe(0)
    // The path was still stat-ed on every tick, so the zero is the `isFile()`
    // guard and not a poller that had stopped.
    expect(statCalls).toBeGreaterThanOrEqual(10)
    expect(w.loadCount()).toBe(1)

    rmSync(file, { recursive: true })
    writeConfig(file, { reviewer: 'opencode/after-dir' })
    const deadline = Date.now() + 2000
    while (Date.now() < deadline && w.loadCount() < 2) await sleep(5)
    expect(w.loadCount()).toBe(2)
  })

  it('attempts exactly one read per existing file per tick, and one stat-only check per absent one', async () => {
    const dir = makeProjectDir()
    writeConfig(projectConfigPath(dir), { reviewer: 'opencode/one-file' })

    const w = await startWatching(dir)
    resetCounts()

    // A single short window, so the number of ticks that can land in it is
    // bounded. Both watched paths are visited every tick; only one of them can
    // produce a read.
    const spanMs = 60
    await sleep(spanMs)
    const reads = readCalls
    const expectedTicks = Math.max(1, Math.round(spanMs / POLL_MS))

    expect(reads).toBeGreaterThanOrEqual(expectedTicks - 1)
    expect(reads).toBeLessThanOrEqual(expectedTicks + 1)
    expect(reads).toBeLessThanOrEqual(expectedTicks * 2)
    // One `stat` per watched path per tick, whatever the path turns out to be.
    expect(statCalls).toBeGreaterThanOrEqual(expectedTicks * 2)
    expect(w.loadCount()).toBe(1)
  })
})

afterAll(() => {
  mock.module('node:fs', () => realNodeFs)
  mock.module('node:os', () => realOs)
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  rmSync(SANDBOX_HOME, { recursive: true, force: true })
})
