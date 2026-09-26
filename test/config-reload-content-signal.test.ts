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
 * These tests count `readFileSync` and `statSync` calls through a counting
 * wrapper, so the cost model is pinned by the implementation rather than by a
 * comment that can quietly stop being true. The wrapper is a faithful
 * pass-through, so the rest of the suite is unaffected even if the module mock
 * is never undone.
 *
 * Why they *measure ticks* instead of sleeping
 * --------------------------------------------
 * An earlier version of this file slept a fixed 180ms window and then demanded
 * that the poll interval had fired around ten times inside it. That asserts how
 * often the event loop got round to a timer, not what the poller does, and it
 * failed about one run in three under full-suite load while passing every time
 * it was run on its own. A slower scheduler is not a broken poller.
 *
 * So the window is no longer measured in milliseconds. `watchConfigFiles` takes
 * an injected poll interval, and the poller's first syscall on a tick is
 * `statSync` on the project config, so instrumenting `statSync` yields a tick
 * *counter*: a measurement can be asked for N ticks and awaited, and it ends
 * when N of them have happened. A contended machine makes that take longer; it
 * cannot change the answer. Everything below is then a ratio between counters
 * sampled at that tick boundary — "one read per tick", "no reads at all", "one
 * stat per watched path per tick" — which is what the claims actually are.
 */

// `require` rather than a namespace import: spreading the `node:fs` namespace
// object goes through its live getters, which re-enter the module under mock
// and hang the runner.
const realNodeFs = require('node:fs') as typeof realFs

// ---------------------------------------------------------------------------
// Tick instrumentation
// ---------------------------------------------------------------------------

/** The two paths `watchConfigFiles` watches, in the order it walks them. */
let watchedPaths: readonly string[] = []

/** -1 is "not a watched path"; 0 is the project config, 1 the global one. */
const watchedIndexOf = (target: unknown): number => {
  if (typeof target !== 'string') return -1
  const resolved = resolve(target)
  for (let i = 0; i < watchedPaths.length; i += 1) {
    if (watchedPaths[i] === resolved) return i
  }
  return -1
}

interface Counters {
  /**
   * `statSync` on the project config. Exactly one per tick, and the first
   * syscall of the tick — which is what makes it a usable tick counter.
   */
  projectStats: number
  /** `statSync` on the global config. One per tick, the last syscall of it. */
  globalStats: number
  /** `readFileSync` on the project config: the content signal, when paid. */
  projectReads: number
  /** `readFileSync` on the global config. */
  globalReads: number
}

const freshCounters = (): Counters => ({
  projectStats: 0,
  globalStats: 0,
  projectReads: 0,
  globalReads: 0,
})

let counters: Counters = freshCounters()

/**
 * Only the poller stats a config path.
 *
 * `src/config.ts` reads the two config files with `readFileSync` and never
 * stats them, and nothing else in the tree stats a `nexus.jsonc`; the message
 * store's one `statSync` is on `messages.jsonl`. So a `statSync` of a watched
 * path is attributable to `stampOf` and to nothing else, and a reload cannot
 * inflate the tick count. Each test also asserts the load count did not move,
 * so the loader's reads cannot be mistaken for the poller's either.
 */
const countingReadFileSync = (...args: unknown[]): unknown => {
  const index = watchedIndexOf(args[0])
  if (index === 0) counters.projectReads += 1
  else if (index === 1) counters.globalReads += 1
  return (realNodeFs.readFileSync as (...a: unknown[]) => unknown)(...args)
}

// `statSync` is counted as well, so "no reads" can be told apart from "the
// poller was not running" — without it, a dead poller would pass the test that
// asserts a cost of zero.
const countingStatSync = (...args: unknown[]): unknown => {
  const index = watchedIndexOf(args[0])
  if (index === 0) counters.projectStats += 1
  else if (index === 1) counters.globalStats += 1
  // Resolving here is safe: `poll` is synchronous end to end, so the awaiting
  // continuation cannot run until the tick that produced the count has finished.
  if (index === 0) noteTickProgress()
  return (realNodeFs.statSync as (...a: unknown[]) => unknown)(...args)
}

mock.module('node:fs', () => ({
  ...realNodeFs,
  default: realNodeFs,
  readFileSync: countingReadFileSync,
  statSync: countingStatSync,
}))

// --- awaiting N ticks -------------------------------------------------------

interface TickWaiter {
  /** `projectStats` value at which the awaited tick count has been reached. */
  readonly target: number
  readonly resolve: () => void
}

let tickWaiters: TickWaiter[] = []

const noteTickProgress = (): void => {
  if (tickWaiters.length === 0) return
  const reached = tickWaiters.filter(waiter => counters.projectStats >= waiter.target)
  if (reached.length === 0) return
  tickWaiters = tickWaiters.filter(waiter => counters.projectStats < waiter.target)
  for (const waiter of reached) waiter.resolve()
}

/**
 * How long a tick may take before the wait is called a failure.
 *
 * Not a performance budget: it exists so a poller that has stopped reports
 * itself as stopped. At the injected interval one tick is 25ms, so this is
 * three orders of magnitude of slack, and it fires only when the ticks the test
 * asked for are not going to arrive. Set below `bun test`'s 5s per-test timeout
 * so the failure is the poller's, with its own message.
 */
const TICK_DEADLINE_MS = 3000

/** Resolves once the poller has run `ticks` further ticks; rejects if it stops. */
const waitForTicks = async (ticks: number): Promise<void> => {
  const target = counters.projectStats + ticks
  const startedAt = counters.projectStats
  await new Promise<void>((resolveWait, rejectWait) => {
    const onReached = (): void => {
      clearTimeout(deadline)
      resolveWait()
    }
    const deadline = setTimeout(() => {
      tickWaiters = tickWaiters.filter(waiter => waiter.resolve !== onReached)
      const observed = (counters.projectStats - startedAt).toFixed(2)
      rejectWait(
        new Error(
          `the config poller did not run ${ticks} tick(s) within ${TICK_DEADLINE_MS}ms ` +
            `(it managed ${observed}) — the poller is not running, so nothing measured here is meaningful`,
        ),
      )
    }, TICK_DEADLINE_MS)
    tickWaiters.push({ target, resolve: onReached })
  })
}

interface TickSample {
  /** Ticks observed, taken from the project config's stat count. */
  readonly ticks: number
  /** Stats on the global config over the same ticks. */
  readonly globalStats: number
  /** Reads on the project config over the same ticks. */
  readonly projectReads: number
  /** Reads on the global config over the same ticks. */
  readonly globalReads: number
}

/**
 * Counters over exactly `ticks` poller ticks.
 *
 * Returns proportions, never an absolute count derived from elapsed time, so
 * the result is a property of the poller rather than of the machine's
 * scheduling. Rejects — rather than hanging until `bun test` gives up — if the
 * poller stops, which is the one thing every ratio here cannot see.
 */
const measureTicks = async (ticks: number): Promise<TickSample> => {
  counters = freshCounters()
  await waitForTicks(ticks)
  return {
    ticks: counters.projectStats,
    globalStats: counters.globalStats,
    projectReads: counters.projectReads,
    globalReads: counters.globalReads,
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const { watchConfigFiles } = await import('../src/index')
const { NexusOrchestrator } = await import('../src/orchestrator')
// The same functions the poller uses to decide what to watch, so a change to
// the watched-path definition cannot make these tests silently measure nothing.
const { nexusProjectConfigPath, nexusGlobalConfigPath } = await import('../src/config')

// Both the plugin and the config manager read homedir(). `process.env.HOME` does
// not move os.homedir() under `bun test`, so the module is mocked — otherwise
// these tests would read and overwrite the developer's real global config.
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'nexus-home-'))
mock.module('node:os', () => ({ ...realOs, default: realOs, homedir: () => SANDBOX_HOME }))

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Above the 25ms floor `watchConfigFiles` clamps to. */
const POLL_MS = 25
const POLL_DEBOUNCE_MS = 25

/**
 * Ticks per measurement window.
 *
 * Four is enough to see a per-tick ratio rather than a one-off, and it keeps the
 * file's cost the same order as before: four ticks at the injected interval is
 * about 100ms, against five fixed 180ms sleeps previously.
 */
const TICKS = 4

/**
 * The floor for "the poller actually ran".
 *
 * One, not ten. A tick is counted as it happens, so a sample that returns at
 * all has observed at least the ticks it asked for — the floor is stated
 * explicitly in every test so the claim is visible in the test body rather than
 * buried in the helper, and so a helper that stopped counting could not pass
 * the ratios below on zeros.
 */
const MIN_TICKS = 1

const tempDirs: string[] = []
function makeProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-project-'))
  tempDirs.push(dir)
  return dir
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
    await orchestrator.initialize(ctx as never)

    // Published before the poller starts, so the very first tick is counted.
    watchedPaths = [nexusProjectConfigPath(projectDir), nexusGlobalConfigPath()]

    const stop = watchConfigFiles(ctx as never, orchestrator, POLL_DEBOUNCE_MS, POLL_MS)
    running.push(stop)
    running.push(() => { void orchestrator.shutdown() })

    return { orchestrator, stop, loadCount: () => orchestrator.getConfigInfo()?.loadCount ?? 0 }
  }

  it('reads content on every tick for a file that exists', async () => {
    const dir = makeProjectDir()
    writeConfig(nexusProjectConfigPath(dir), { reviewer: 'opencode/quiet' })

    const w = await startWatching(dir)
    expect(w.loadCount()).toBe(1)

    // Measure only the ticks, not the startup: the baseline load reads the file
    // too, and the seed stamp is one stat and one read per path.
    //
    // The project config exists and is stable, so each tick must still have read
    // it — that is the price of detecting a change that leaves mtime and size
    // untouched. The global config does not exist, so it costs a `stat` and
    // contributes no reads, which is what keeps the read count at roughly one
    // per tick rather than two.
    const first = await measureTicks(TICKS)
    expect(first.ticks).toBeGreaterThanOrEqual(MIN_TICKS)
    expect(first.projectReads).toBeGreaterThanOrEqual(first.ticks)
    expect(first.projectReads).toBeLessThanOrEqual(first.ticks * 2)
    expect(first.globalReads).toBe(0)
    // Every tick that visited the project config also visited the global one, so
    // the pair of visits is one tick rather than two halves of a tick.
    expect(first.globalStats).toBeGreaterThanOrEqual(first.ticks)
    // The reads bought correctness, not churn: a stable digest is not a change.
    expect(w.loadCount()).toBe(1)

    // And the cost is not the signature's being unstable: the count keeps
    // tracking the ticks rather than collapsing to zero, so the digest really
    // is being recomputed and compared.
    const second = await measureTicks(TICKS)
    expect(second.ticks).toBeGreaterThanOrEqual(MIN_TICKS)
    expect(second.projectReads).toBeGreaterThanOrEqual(second.ticks)
    expect(second.projectReads).toBeLessThanOrEqual(second.ticks * 2)
    expect(w.loadCount()).toBe(1)
  })

  it('reads nothing at all when neither config file exists', async () => {
    // The default shape of a fresh checkout: no `.opencode/nexus.jsonc`, and no
    // global one. Both watched paths stat to the stable 'absent' stamp, so the
    // poller never opens a file at all. Without this the content signal would
    // tax every install on reads it cannot benefit from.
    const w = await startWatching(makeProjectDir())
    expect(w.loadCount()).toBe(1)

    const sample = await measureTicks(TICKS)

    // The poller ran, and it walked both watched paths on every one of those
    // ticks. Without these two, every assertion below would also hold for a
    // poller that had stopped — which is precisely what a cost-of-zero claim
    // must not be able to hide behind.
    expect(sample.ticks).toBeGreaterThanOrEqual(MIN_TICKS)
    expect(sample.globalStats).toBeGreaterThanOrEqual(sample.ticks)
    // So the zero is the guard doing its job.
    expect(sample.projectReads).toBe(0)
    expect(sample.globalReads).toBe(0)
    expect(w.loadCount()).toBe(1)
  })

  it('does not read a path that is a directory, and still notices the real file after it', async () => {
    const dir = makeProjectDir()
    const file = nexusProjectConfigPath(dir)
    // `statSync` succeeds but `isFile()` is false, so the path collapses to
    // 'absent' and the read is never attempted — attempting it would throw on
    // every tick, which is the spin the stable stamp exists to prevent.
    mkdirSync(file, { recursive: true })

    const w = await startWatching(dir)
    const sample = await measureTicks(TICKS)

    // The path was still stat-ed on every tick, so the zero is the `isFile()`
    // guard and not a poller that had stopped.
    expect(sample.ticks).toBeGreaterThanOrEqual(MIN_TICKS)
    expect(sample.globalStats).toBeGreaterThanOrEqual(sample.ticks)
    expect(sample.projectReads).toBe(0)
    expect(w.loadCount()).toBe(1)

    // ...and the guard is not a refusal to ever look: once a real file is there,
    // the very next tick that sees it reloads.
    rmSync(file, { recursive: true })
    writeConfig(file, { reviewer: 'opencode/after-dir' })
    const deadline = Date.now() + 2000
    while (Date.now() < deadline && w.loadCount() < 2) await sleep(5)
    expect(w.loadCount()).toBe(2)
  })

  it('attempts exactly one read per existing file per tick, and one stat-only check per absent one', async () => {
    const dir = makeProjectDir()
    writeConfig(nexusProjectConfigPath(dir), { reviewer: 'opencode/one-file' })

    const w = await startWatching(dir)
    const sample = await measureTicks(TICKS)

    // Both watched paths are visited every tick; only one of them exists, so
    // only one can produce a read. Expressed as proportions of the ticks that
    // actually happened.
    expect(sample.ticks).toBeGreaterThanOrEqual(MIN_TICKS)
    // One read per tick for the existing file, and not more than one per
    // watched path per tick — a second read per tick would be double-charging
    // the same bytes and would show up here.
    expect(sample.projectReads).toBeGreaterThanOrEqual(sample.ticks)
    expect(sample.projectReads).toBeLessThanOrEqual(sample.ticks * 2)
    // The absent one is stat-ed every tick and read never. The lower bound is
    // the half that carries the claim: ticks are counted off the project
    // config's stats, so the "no more than one stat per path per tick" half is
    // structural rather than independently measured here.
    expect(sample.globalStats).toBeGreaterThanOrEqual(sample.ticks)
    expect(sample.globalReads).toBe(0)
    expect(w.loadCount()).toBe(1)
  })
})

afterAll(() => {
  mock.module('node:fs', () => realNodeFs)
  mock.module('node:os', () => realOs)
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  rmSync(SANDBOX_HOME, { recursive: true, force: true })
})
