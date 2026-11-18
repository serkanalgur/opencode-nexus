/**
 * Watching the two `nexus.jsonc` files and reloading on change. Moved out of
 * `src/index.ts` unchanged; `setup()` starts it and its disposer stops it.
 */
import { Plugin } from "@opencode/plugin"
import { NexusOrchestrator } from "./orchestrator"
import { nexusProjectConfigPath, nexusGlobalConfigPath, type NexusConfigReloadTrigger } from "./config"
import { readFileSync, statSync } from "node:fs"
import { createHash } from "node:crypto"
import { resolve, basename, dirname } from "node:path"

/**
 * Filesystem watchers fire several times for a single editor save (write,
 * truncate, rename-into-place, plus the editor's own atomic-save dance). Wait
 * for the burst to settle so one save causes one reload.
 */
export const CONFIG_RELOAD_DEBOUNCE_MS = 150

/**
 * How often the config files are checked for changes — a `stat` of the two
 * paths, plus a read of whichever of them exist.
 *
 * This is the *guaranteed* trigger. `filesystem.changed` is only a fast path:
 * OpenCode enumerates the specific paths it watches, and `nexus.jsonc` is
 * Nexus's own filename, so there is no reason to expect an event for it. A live
 * probe against a real server delivered zero such events, so a feature whose
 * whole purpose is eliminating silent staleness cannot depend on that event.
 */
export const CONFIG_POLL_INTERVAL_MS = 2000

/**
 * The slice of the plugin context the config watcher needs. `event` is
 * optional so the watcher degrades to a no-op on contexts that do not expose
 * an event stream, instead of throwing during setup.
 */
type ConfigWatchContext = Pick<Plugin.Context, 'location'> & {
  event?: Pick<Plugin.Context['event'], 'subscribe'>
}

/**
 * True when a changed file is one of the two config files the config manager
 * reads.
 *
 * The primary test is the resolved absolute path. The shape-based fallback
 * exists for when normalisation is unreliable — a symlinked home, or a
 * `location.directory` that is not the same string the loader saw — and
 * recognises the `<...>/.opencode/nexus.jsonc` shape itself. It is narrowed by
 * the event's own `location.directory` when the host supplies one: a nested
 * package in a monorepo ships its own `.opencode/nexus.jsonc`, and this project
 * does not read that file, so matching on shape alone would reload needlessly.
 */
function isNexusConfigFile(
  file: string,
  eventDirectory: string | undefined,
  projectDirectory: string,
  projectPath: string,
  globalPath: string,
): boolean {
  const resolved = resolve(file)
  if (resolved === projectPath || resolved === globalPath) return true

  if (eventDirectory !== undefined && resolve(eventDirectory) !== projectDirectory) return false

  return basename(resolved) === 'nexus.jsonc' && basename(dirname(resolved)) === '.opencode'
}

/**
 * Contexts that already have a live config subscription. `setup` is not
 * re-entered today, but two live watchers would mean two poll intervals and two
 * reloads per save, silently.
 */
const watchedContexts = new WeakSet<ConfigWatchContext>()

/**
 * Upper bound on how long the debounce may defer a reload.
 *
 * Without it, `scheduleReload` is a pure trailing-edge debounce: anything
 * arriving faster than `debounceMs` resets the timer forever and the reload
 * never runs. A file-sync client or `git checkout` loop rewriting
 * `nexus.jsonc` at more than ~7Hz is enough. An unbounded debounce here is
 * silent, permanent staleness — the exact defect this feature exists to remove.
 */
export const MAX_RELOAD_WAIT_MS = 1000

/**
 * Floor for the injected intervals. `watchConfigFiles` is exported, and
 * `setInterval(fn, 0)` would be a hot loop stat-ing continuously. The only
 * production caller passes the defaults, so this is defence in depth; the floor
 * is kept low enough that a test can drive the poller quickly.
 */
const MIN_INTERVAL_MS = 25

const clampInterval = (ms: number, fallback: number): number =>
  Number.isFinite(ms) && ms >= MIN_INTERVAL_MS ? ms : fallback

/**
 * The stable stamp for a path that is not an existing regular file. A missing
 * path, a path that cannot be stat-ed at all, and a directory in the way all
 * land here, so the poller can never spin on a path it cannot observe.
 */
const ABSENT = 'absent'

/**
 * The stable digest for a file that stats as a regular file but cannot be read
 * (EACCES, or a read that fails for any other reason).
 */
const UNREADABLE = 'unreadable'

/**
 * Reload the Nexus config whenever one of the files the config manager reads
 * changes, so a `nexus.jsonc` edit takes effect without restarting the service.
 *
 * Two triggers feed one bounded-debounced reload, so there is a single code
 * path and a single set of semantics:
 *
 *  - `filesystem.changed` — the fast path. Handles all three kinds: `change`
 *    (edited), `add` (created) and `unlink` (deleted, which falls back to the
 *    next level rather than keeping the deleted file's values), because a
 *    reload re-reads every level, so the deleted level stops contributing.
 *  - stat/content polling — the guarantee. It watches exactly the two files the
 *    loader reads, so unlike the event it needs no shape heuristics and cannot
 *    be scoped to (or missed because of) another project's config. Polling is
 *    installed unconditionally: it must not depend on the event stream, since
 *    the event is the trigger we cannot demonstrate. The signature is
 *    `mtime:size` plus a SHA-1 of the bytes, so the guarantee does not depend on
 *    the filesystem updating mtime — see `stampOf`.
 *
 * `config.init` writes these exact two files, so running it produces a second
 * load ~150ms later. That re-read is idempotent and harmless; the extra log
 * line is expected, not a bug.
 *
 * The returned disposer clears the poll interval, aborts the subscription and
 * clears a pending debounce timer, so neither mechanism can fire after plugin
 * unload.
 */
export function watchConfigFiles(
  ctx: ConfigWatchContext,
  orchestrator: NexusOrchestrator,
  debounceMs: number = CONFIG_RELOAD_DEBOUNCE_MS,
  pollMs: number = CONFIG_POLL_INTERVAL_MS,
): () => void {
  if (watchedContexts.has(ctx)) return () => {}
  watchedContexts.add(ctx)

  const debounce = clampInterval(debounceMs, CONFIG_RELOAD_DEBOUNCE_MS)
  const pollEvery = clampInterval(pollMs, CONFIG_POLL_INTERVAL_MS)

  const projectDirectory = resolve(ctx.location.directory)
  const projectPath = nexusProjectConfigPath(ctx.location.directory)
  const globalPath = nexusGlobalConfigPath()
  const watchedPaths = [projectPath, globalPath]

  const controller = new AbortController()
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let firstScheduledAt = 0

  const clearPendingReload = (): void => {
    if (debounceTimer === null) return
    clearTimeout(debounceTimer)
    debounceTimer = null
  }

  /**
   * Content digest of one path: SHA-1 over the raw bytes.
   *
   * A digest rather than the bytes themselves, because the signature is
   * retained per watched path and a fixed-size value keeps it that way no
   * matter how large the file is. These two files are hundreds of bytes, so the
   * hash is not the interesting cost — the `readFileSync` is, and it is the
   * same read the config loader already performs on every load. This is change
   * detection, not a trust boundary, so SHA-1's collision resistance is
   * irrelevant; `createHash` is simply the stdlib option that needs no new
   * dependency.
   *
   * Every failure collapses to UNREADABLE, on the same terms as the stat
   * below: a throw here would kill the interval and silently void the
   * guarantee, and a stable value means a path that cannot be read (EACCES)
   * resolves to the same stamp forever instead of spinning the poller.
   */
  const digestOf = (filePath: string): string => {
    try {
      return createHash('sha1').update(readFileSync(filePath)).digest('hex')
    } catch {
      return UNREADABLE
    }
  }

  /**
   * Change signature for one path: `mtimeMs:size|digest`.
   *
   * mtime and size are both compared so a same-tick edit that changes length is
   * caught, and the content digest is compared alongside them so an edit that
   * changes *neither* is caught too. The digest is what closes the gap that
   * made the poll's guarantee conditional on the filesystem: a network mount
   * with attribute caching, or a coarse timestamp granularity where two edits
   * land in the same tick at the same length, both leave mtime:size identical
   * while the content differs. Without a content signal, a change could be
   * invisible and the config silently stale again — the one failure this
   * feature exists to prevent.
   *
   * The content read is the price, and it is paid on every tick that finds an
   * existing regular file, because "unchanged mtime" and "changed under a
   * broken mtime" are indistinguishable without looking at the bytes. That is
   * irreducible: the read is the only way to know. It is cheap for the sizes
   * involved (two files of hundreds of bytes, twice a second at the production
   * interval, dominated by the syscall rather than the hash) and it is the
   * same order of cost the config loader already pays on every reload. A
   * pathologically enormous config would make each tick expensive rather than
   * wrong, and such a file is already fully read on every reload, so capping
   * the digest would buy nothing and reopen the hole. What the read *does*
   * save: any path that is not an existing regular file — the default case
   * for most installs, which have no project config at all — is a `stat` and
   * nothing more, and never a read.
   *
   * Every failure collapses to a stable value, so no failure can spin the
   * poller: a `stat` that throws or names a non-file gives ABSENT, and a read
   * that throws leaves the stat half intact with UNREADABLE as the digest. A
   * throw out of here would kill the interval and silently stop the guarantee.
   *
   * Synchronous, and it assumes a local filesystem: on a hung NFS/WSL/sshfs
   * mount this blocks the event loop for the duration, the read now included.
   * That is accepted deliberately for the same reason the `stat` was — it is
   * the cost of making reload guaranteed, and the alternative (an async stamp,
   * and the interleaving that comes with it) is more moving parts than the risk
   * justifies. A hung read stalls the loop, it does not corrupt state, and
   * `MAX_RELOAD_WAIT_MS` bounds the consequence.
   */
  const stampOf = (filePath: string): string => {
    let stat: string
    try {
      const stats = statSync(filePath)
      if (!stats.isFile()) return ABSENT
      stat = `${stats.mtimeMs}:${stats.size}`
    } catch {
      return ABSENT
    }
    return `${stat}|${digestOf(filePath)}`
  }

  // Record the starting state, so the first poll cannot fire a spurious reload
  // for a file that has not moved since the last load. The seed is a full
  // signature — stat and digest alike — so the first tick compares like with
  // like. A seed that carried only the cheap half would report a change on
  // tick one for every file that exists, and a reload storm would follow.
  const lastSeen = new Map<string, string>(watchedPaths.map(p => [p, stampOf(p)]))

  /**
   * The reload body, shared by the debounce timer and the bounded-wait escape.
   *
   * The try/catch is required, not defensive decoration. This runs unguarded
   * inside an unattended timer for the plugin's lifetime, and it fans out to
   * `orchestrator.emit`, which invokes every `on(...)` handler with no
   * per-handler isolation. `orchestrator.on` is a public callable, so a
   * third-party or LLM-registered handler that throws would otherwise become an
   * uncaught exception in a timer callback — which can take down the host
   * process, triggered by nothing more than a user editing a config file.
   */
  const runReload = (trigger: NexusConfigReloadTrigger): void => {
    // Re-stamp BEFORE reloading. Stamping afterwards could miss an edit that
    // lands mid-reload, and a missed edit is the exact failure this feature
    // exists to prevent; a redundant reload is merely wasteful. The re-stamp is
    // a full signature, so the post-reload baseline carries a digest and an
    // edit that only changes content is still visible to the next tick.
    for (const filePath of watchedPaths) lastSeen.set(filePath, stampOf(filePath))
    try {
      orchestrator.reloadConfigFromDisk(trigger)
    } catch (err) {
      console.warn(`[nexus] config reload failed (${trigger}): ${String(err)}`)
    }
  }

  /**
   * The one path both triggers go through. Bounded wait: the first arrival in
   * any window always gets its reload, so a sustained stream cannot starve it.
   */
  const scheduleReload = (trigger: NexusConfigReloadTrigger): void => {
    // How long the *pending* reload has already been deferred, measured from
    // when this window opened. With nothing pending there is no accumulated
    // wait, so this is a fresh window and the normal debounce applies —
    // treating "nothing pending" as an infinite wait would run every isolated
    // event immediately and defeat the debounce.
    const pending = debounceTimer !== null
    const waited = pending ? Date.now() - firstScheduledAt : 0
    clearPendingReload()
    if (pending && waited >= MAX_RELOAD_WAIT_MS) {
      runReload(trigger)
      return
    }
    // Set only when the window opens. Re-stamping on every reset would keep
    // `waited` pinned near zero and the cap would never fire — the starvation
    // this is here to prevent.
    if (!pending) firstScheduledAt = Date.now()
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      runReload(trigger)
    }, debounce)
  }

  const poll = (): void => {
    let changed = false
    for (const filePath of watchedPaths) {
      const current = stampOf(filePath)
      if (lastSeen.get(filePath) === current) continue
      lastSeen.set(filePath, current)
      changed = true
    }
    // At most one reload per tick, however many paths moved.
    if (changed) scheduleReload('poll')
  }

  // `unref()` so a purely background watcher cannot hold the process open. It is
  // not unit of work that must complete — the config already in effect stays in
  // effect — so nothing is lost by letting the process exit without it. The
  // disposer below owns the interval and clears it explicitly.
  const pollTimer = setInterval(poll, pollEvery)
  pollTimer.unref()

  // N1: the event stream is the *optional* fast path, so it must not gate the
  // poller. A context without one still gets guaranteed reloads. This is
  // declared after the poller on purpose — the poller above is unconditional.
  const eventDomain = ctx.event
  if (typeof eventDomain?.subscribe !== 'function') {
    console.warn('[nexus] no config event stream on this context; polling is the only config reload trigger')
    return () => {
      clearInterval(pollTimer)
      clearPendingReload()
      controller.abort()
    }
  }

  const consume = async (): Promise<void> => {
    try {
      for await (const event of eventDomain.subscribe({ signal: controller.signal })) {
        if (event.type !== 'filesystem.changed') continue
        // A malformed event must not kill the fast path for the whole session.
        const file: unknown = event.data?.file
        if (typeof file !== 'string') continue
        if (!isNexusConfigFile(file, event.location?.directory, projectDirectory, projectPath, globalPath)) continue
        scheduleReload('event')
      }
      // Reaching here without an abort means the stream ended on its own —
      // a dropped connection, most likely. Say so: a silent end makes that
      // indistinguishable from "the host does not deliver events for these
      // files", which is the question the trigger attribution exists to answer.
      if (!controller.signal.aborted) {
        console.warn('[nexus] config event stream ended; polling remains the only config reload trigger')
      }
    } catch (err) {
      console.warn(`[nexus] config event stream failed; polling remains the only config reload trigger: ${String(err)}`)
    }
  }

  void consume()

  return () => {
    clearInterval(pollTimer)
    clearPendingReload()
    controller.abort()
  }
}
