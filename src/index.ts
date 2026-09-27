import { Plugin } from "@opencode/plugin"
import { NexusOrchestrator, lastAssistantText, type NexusModelCost, type SpawnedAgent } from "./orchestrator"
import { PRESETS, nexusProjectConfigPath, nexusGlobalConfigPath, type NexusConfigReloadTrigger, type NexusGitFlowConfig } from "./config"
import { CONVENTIONAL_COMMIT_TYPES, type GitState } from "./git-flow"
import {
  describeListResult,
  describeSearchResult,
  describeSetResult,
} from "./memory-recall"
import type { MemoryEntry, MemoryScope } from "./types"
import { TEMPLATES, instantiateTemplate, listTemplates } from "./templates"
import { GoalManager } from "./goal"
import { TeamManager } from "./team"
import { AstGrep } from "./astgrep"
import { describeDashboardStart, startDashboardServer } from "./dashboard"
import {
  formatModelPrice,
  providerIDFromRef,
  providerLabels,
  type ModelCostRow,
  type ProviderLabelSource,
} from "./model-groups"
import { writeFileSync, readFileSync, mkdirSync, existsSync, statSync } from "node:fs"
import { createHash } from "node:crypto"
import { join, resolve, basename, dirname } from "node:path"
import { homedir } from "node:os"
import type { CostProvenance } from "./types"
import type { PerformanceScore } from "./performance"

/**
 * Render one cost with the label that says whether it was measured or
 * predicted. Every figure a tool hands to a user or an agent goes through
 * here: a `$0.0123` and a `$0.0123` that is the forecaster's guess are the
 * same string, and the guess is the one that gets acted on.
 */
function renderCost(cost: number, provenance: CostProvenance): string {
  return provenance.usage === 'measured'
    ? `$${cost.toFixed(4)} measured`
    : `$${cost.toFixed(4)} estimated`
}

/**
 * Render a performance score's cost coverage. `costBasis: 'none'` is stated in
 * words rather than as a zero, because the cost third of that score is an
 * absence of evidence and reads as a measurement if it is printed as a number.
 */
function renderCostBasis(score: PerformanceScore): string {
  if (score.costBasis === 'none') {
    return 'cost unscored: 0 measured tasks, 0% of score from cost'
  }
  return `avg=$${score.avgCost.toFixed(4)} (${score.measuredTasks}/${score.totalTasks} measured)`
}

/**
 * The heading for a `modelCosts` key that names no provider.
 *
 * `setModelCosts` accepts a bare `"id"` and stores it under that key verbatim
 * (`src/orchestrator.ts`), so this bucket is a real, reachable state and not a
 * defensive branch: it holds every hand-priced model that was set without a
 * provider prefix.
 *
 * The wording states the REASON rather than inventing a category. Rejected
 * alternatives: "Ungrouped" leaks the implementation into user-facing text;
 * "Other" implies these models belong to some provider and sorts them among
 * real ones; "Unknown" asserts the provider is unknown, when the truth is that
 * there IS no provider. So the heading says both halves — no provider, and the
 * bare-id key that causes it.
 */
const UNGROUPED_HEADING = 'No provider (bare model id)'

/**
 * How many providers the all-models listing renders in full.
 *
 * The cap is on PROVIDERS, not models, and deliberately so: a group cut in half
 * is indistinguishable from a provider that publishes one model, whereas
 * dropping a whole provider is visible and is what the announcement counts.
 * Twelve covers a wide multi-provider install (the built-in providers plus a
 * gateway or two) while keeping the report readable when a user has a large
 * catalogue. The ungrouped bucket is exempt — see `renderModelCostReport`.
 */
const MODEL_COST_GROUP_CAP = 12

/**
 * The per-1K rates in `modelCosts` as the per-million rows `formatModelPrice`
 * reads.
 *
 * `modelCosts` is normalised on WRITE to USD per 1K (`normaliseTiers`), while
 * `ModelCostRow` — and therefore `formatModelPrice` — divides by 1000 to get
 * there, so the rows are scaled back UP. Handing per-1K numbers to
 * `formatModelPrice` untreated would print every price 1000x too small, e.g.
 * `$0.000003/1K tokens` for a $3/M model; that is the failure this conversion
 * exists to prevent, and the test pins the unit by asserting a $3/M model
 * renders as `$0.003/1K tokens`.
 *
 * `x * 1000 / 1000` is exact for every published price figure, so this cannot
 * introduce the 1-ULP discrepancy a lossy round trip would: a double survives
 * the round trip only when its mantissa allows it, and real rates (0.003, 0.015,
 * 0.3, 3, 15 …) all do. A pathological rate could still differ in the last
 * significant digit from the picker's own arithmetic, which is the one residual
 * risk of sharing the formatter rather than reimplementing it — and sharing it is
 * what makes the two surfaces agree in the first place.
 *
 * Cache rates are dropped rather than reconstructed: `formatModelPrice` omits
 * them (see its docstring — a four-rate line is unreadable in a list column),
 * and they remain available per-model through the `model` argument's branch.
 */
function priceRowsFor(cost: NexusModelCost): ModelCostRow[] {
  return cost.tiers.map(tier => ({
    ...(tier.threshold === undefined ? {} : { tier: { type: 'context', size: tier.threshold } }),
    input: tier.rates.input * 1000,
    output: tier.rates.output * 1000,
  }))
}

/**
 * The `modelCosts` catalogue, grouped under one heading per provider.
 *
 * This is the text-output twin of the TUI picker's grouping (`src/tui.tsx`), and
 * it is deliberately built from the SAME two helpers in `src/model-groups.ts`
 * rather than a second implementation:
 *
 *  - `providerLabels` supplies the heading. Its three-way return is what makes
 *    the bare-id case decidable: a known provider yields its display name, an
 *    unrecognised id yields the raw id (an ugly heading, but a true one), and
 *    `undefined` means there is no provider to name. Only that last case goes to
 *    the ungrouped bucket, so a bare id is never filed under a fabricated
 *    provider and never dropped.
 *  - `formatModelPrice` supplies the price text, so the picker column and this
 *    report cannot print different numbers for the same model.
 *
 * ORDERING matches the picker: providers by display name, then models by id
 * within their provider. It is load-bearing there because the host groups by
 * first appearance, and it is load-bearing here for the same underlying reason
 * — one provider must be one contiguous block, or the grouping achieves nothing.
 * The ungrouped bucket sorts FIRST, which is what the picker's own sort does
 * with uncategorised rows (`a.category ?? ""`), so the two surfaces put these
 * models in the same place; it also means the hand-priced entries are the first
 * thing read rather than the last thing scrolled past.
 *
 * `providers` is optional and every failure mode degrades to raw ids: an empty
 * list means headings read `opencode-go` rather than `OpenCode Go`, which is a
 * degraded label on correct rows. No model is ever missing and no price is ever
 * wrong, which is why the catalogue is best-effort. Its single caller passes
 * `orchestrator.getProviderList()` — the same array `getCostReport()` hands the
 * dashboard — so the tool and the page cannot disagree about a heading, and the
 * empty-list case is a host that named nothing rather than a fetch that failed
 * here. A provider the host reported with an unusable name reaches this function
 * as `{ id }` with no `name` at all, which `providerLabels` resolves through its
 * raw-id fallback: an ugly heading, never a blank one.
 */
export function renderModelCostReport(
  costs: ReadonlyMap<string, NexusModelCost> | undefined,
  providers: readonly ProviderLabelSource[] | undefined,
): string {
  if (!costs || costs.size === 0) {
    // The sibling memory tools distinguish an empty store from a filtered one,
    // and so does this: a populated report opens with a heading and rows, so
    // "no pricing data loaded" cannot be read as "here is your pricing".
    return 'No real pricing data loaded. Using labelled fallback estimates.'
  }

  const label = providerLabels(providers)
  const groups = new Map<string, { models: { id: string; text: string }[] }>()
  const ungrouped: { id: string; text: string }[] = []

  for (const [ref, cost] of costs) {
    const heading = label(providerIDFromRef(ref))
    // `formatModelPrice` returns undefined only for a model that published NO
    // price at all. `loadModelCosts` skips those and `setModelCosts` always
    // writes one tier, so this needs the public mutable map to reach — but the
    // row is still printed, labelled. A blank line would read as "no price"
    // indistinguishably from a rendering failure, and `$0` would assert the
    // model is free, which is the false zero this tool already refuses to print.
    const price = formatModelPrice(priceRowsFor(cost)) ?? 'no published price'

    if (heading === undefined) {
      ungrouped.push({ id: ref, text: price })
      continue
    }
    const group = groups.get(heading) ?? { models: [] }
    group.models.push({ id: ref, text: price })
    groups.set(heading, group)
  }

  // Two providers sharing a display name merge into one heading, which is what
  // `providerLabels` documents. The model lists concatenate, so no model is
  // lost by the merge; the sort below is stable enough for a price list, where
  // a tie between same-named providers' models carries no meaning.
  type ModelRow = { id: string; text: string }
  type Group = [heading: string, models: ModelRow[]]
  const byModelId = (a: ModelRow, b: ModelRow) => a.id.localeCompare(b.id)
  const ordered: Group[] = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, group]): Group => [name, group.models.sort(byModelId)])
  ungrouped.sort(byModelId)

  const shown = ordered.slice(0, MODEL_COST_GROUP_CAP)
  const hidden = ordered.slice(MODEL_COST_GROUP_CAP)
  const countModels = (entries: readonly Group[]) =>
    entries.reduce((sum, [, models]) => sum + models.length, 0)

  const lines = ['📊 Model Pricing (from OpenCode, per 1K tokens):', '']

  // The ungrouped bucket is rendered in full and exempt from the cap: these are
  // hand-priced entries the user most likely just set, and a half-rendered
  // bucket is the one truncation that would hide a price someone is looking for.
  if (ungrouped.length > 0) {
    lines.push(UNGROUPED_HEADING)
    for (const { id, text } of ungrouped) lines.push(`  ${id}: ${text}`)
    lines.push('')
  }

  for (const [name, models] of shown) {
    lines.push(name)
    for (const { id, text } of models) lines.push(`  ${id}: ${text}`)
    lines.push('')
  }

  if (hidden.length > 0) {
    // Announced, never silent: a cap that hides rows without saying so
    // satisfies the cap while defeating the point of it. Both units are given,
    // because the truncation unit is providers while the reader counts models,
    // and the bare-id bucket is counted as its own group so the totals add up.
    // `src/memory-recall.ts` uses the same `showing N of M` form.
    const ungroupedGroup = ungrouped.length > 0 ? 1 : 0
    const totalGroups = ordered.length + ungroupedGroup
    const shownGroups = shown.length + ungroupedGroup
    const totalModels = countModels(ordered) + ungrouped.length
    const shownModels = countModels(shown) + ungrouped.length
    lines.push(
      `(showing ${shownGroups} of ${totalGroups} groups, ${shownModels} of ${totalModels} models` +
      ` — ${totalGroups - shownGroups} group(s) and ${totalModels - shownModels} model(s) not listed)`
    )
  }

  return lines.join('\n').trimEnd()
}

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

// ── `dashboard.start` / `dashboard.stop` ────────────────────────────
// Exported free functions rather than inline closures inside
// `ctx.tool.transform`, for one reason: a tool's behaviour is a contract, and
// an inline closure is only reachable by running a whole plugin host. These
// two are the whole of the dashboard's tool surface, and the failure modes they
// have to get right — a refused bind, a config-disabled start, a stop with
// nothing running — are exactly the ones that cannot be observed by reading the
// happy path.

/**
 * Descriptions are a control surface of their own: a model's decision to call
 * `dashboard.start` instead of guessing at an address is made from this text
 * and nothing else, so the facts a caller needs in order to choose correctly
 * live here and are pinned by `test/dashboard-entrypoints.test.ts`.
 */
export const DASHBOARD_START_DESCRIPTION =
  "Start the Nexus web dashboard: an HTTP + WebSocket server that serves the dashboard page and the "
  + "orchestrator's live state, agents, tasks, sessions, costs and config. It is NOT started for you — "
  + "nothing in nexus listens until this tool is called, and it serves nothing but the dashboard. "
  + "The port must be FREE: the bind fails if another process holds it, and this tool reports that "
  + "failure rather than replacing the other listener. Host defaults to 127.0.0.1 and port to 4747, "
  + "or to the `dashboard` block in nexus.jsonc. If that block sets `enabled: false` the start is "
  + "refused and the refusal names the config key. On success the URL is printed — give the user that "
  + "exact URL; it is the only address the page is served on."

export const DASHBOARD_STOP_DESCRIPTION =
  "Stop the Nexus web dashboard started by `dashboard.start`, closing its HTTP and WebSocket "
  + "connections. Takes no arguments. A no-op if no dashboard is running — it says so rather than "
  + "reporting a stop that did not happen. Note that this only stops the dashboard server: the "
  + "orchestrator, its agents and its sessions are unaffected and keep running."

/**
 * Description for `nexus.notifications.test`.
 *
 * Same reasoning as the dashboard descriptions: a model decides when to reach
 * for this from the text and nothing else, and the text has to say that the
 * point of the call is to VERIFY SETUP rather than to inform a user who did
 * not ask. Exported so that wording is itself under test.
 */
export const NOTIFICATIONS_TEST_DESCRIPTION =
  "Send a test OS notification and report whether the OS notifier accepted it, with the reason if it did not. "
  + "Use this to verify notification setup when the user reports never seeing notifications: it "
  + "distinguishes notifications being switched off in config, this platform having no notifier, and "
  + "the notifier itself rejecting the notification. Reports the notifier's own result, never a canned "
  + "success. Note that `delivered: true` means the OS took the notification, not that a human will see "
  + "it: a muted app, Focus/Dnd, or missing notification permission all still exit 0."

/** The notification probe's result, as the tool hands it back. */
export interface NotificationsTestResult {
  delivered: boolean
  reason: string | null
  enabled: boolean
  platform: string
  stats: unknown
}

/**
 * Body of the `notifications.test` tool.
 *
 * Split out of the tool registration so the behaviour worth testing — that it
 * reports the REAL boolean and a REAL reason, and never a hardcoded success —
 * is reachable without standing up a plugin host.
 */
export async function runNotificationsTest(orchestrator: {
  notifications: { test(): Promise<NotificationsTestResult> } | null
}): Promise<string> {
  // `orchestrator.notifications` is null until the orchestrator has
  // initialised. Say so plainly rather than reporting a failure that reads
  // like a broken notifier.
  if (!orchestrator.notifications) {
    return JSON.stringify(
      {
        delivered: false,
        reason: "notification manager is not initialised yet",
        stats: null
      },
      null,
      2
    )
  }
  return JSON.stringify(await orchestrator.notifications.test(), null, 2)
}

/**
 * Body of the `dashboard.start` tool. Returns the text the tool hands back.
 *
 * A bind failure is an ordinary outcome of asking for a port, so it is
 * REPORTED rather than thrown: an unhandled throw reaches the model as a tool
 * error with none of the context needed to act on it, and the caller has no
 * way to tell "the port was busy" from "the plugin is broken".
 *
 * The failure text is the important half. It must not contain a URL, and it
 * must say no browser was opened — this tool does not open one, and the TUI's
 * `/nexus-dashboard` command is what does, and only after confirming the
 * listen. A "started at http://…" line after a failed bind is the exact false
 * confirmation this path is written to be unable to give.
 *
 * The work itself is `startDashboardServer()` in `src/dashboard.ts`, shared
 * with `handleCommand("/nexus dashboard")`, because a caller that started the
 * server one way and reported it another would be the bug this file's wording
 * exists to prevent.
 */
export function runDashboardStart(
  orchestrator: NexusOrchestrator,
  port?: number,
  host?: string
): string {
  return describeDashboardStart(startDashboardServer(orchestrator, port, host))
}

/**
 * Body of the `dashboard.stop` tool. Reports whether there was anything to
 * stop, because "Dashboard stopped" for a server that was never running is a
 * confirmation of a change that did not happen.
 */
export function runDashboardStop(orchestrator: NexusOrchestrator): string {
  const wasRunning = orchestrator.dashboard?.isRunning() ?? false
  orchestrator.stopDashboard()
  return wasRunning
    ? "Dashboard stopped. The orchestrator, its agents and its sessions were not affected."
    : "No dashboard was running, so nothing was stopped. The orchestrator, its agents and its "
      + "sessions were not affected."
}

const NEXUS_AGENT_CONTENT = `---description: Nexus multi-agent orchestrator — decomposes tasks and delegates to specialized sub-agents
mode: primary
permissions:
  - action: subagent
    resource: "nexus-*"
    effect: allow
  - action: subagent
    resource: "nexus-architect"
    effect: allow
  - action: subagent
    resource: "nexus-coder"
    effect: allow
  - action: subagent
    resource: "nexus-reviewer"
    effect: allow
  - action: subagent
    resource: "nexus-tester"
    effect: allow
  - action: subagent
    resource: "nexus-explorer"
    effect: allow
  - action: subagent
    resource: "nexus-documenter"
    effect: allow
---

# Nexus Orchestrator

You are a task orchestrator. Your ONLY job is to analyze requests, create plans, and delegate to sub-agents. You NEVER do the work yourself.

## How You Work

1. **Analyze** — Understand what the user wants
2. **Plan** — Break into tasks, assign to agents, show the plan
3. **Wait** — Get user approval before doing anything
4. **Execute** — Spawn agents for each task after approval
5. **Report** — Summarize results

## Rules

### You NEVER do these yourself:
- Read source files → use nexus.spawn(role="explorer")
- Write code → use nexus.spawn(role="coder")
- Review code → use nexus.spawn(role="reviewer")
- Write tests → use nexus.spawn(role="tester")
- Explore codebase → use nexus.spawn(role="explorer")
- Write docs → use nexus.spawn(role="documenter")
- Decide how something should look or behave → use nexus.spawn(role="designer")

### You ALWAYS use nexus.spawn or nexus.delegate:
- NEVER use OpenCode's built-in subagent tool
- NEVER read files to "understand the codebase" yourself
- NEVER write a single line of code yourself

### Your workflow for EVERY request:

1. Read the user's request carefully
2. (Optional) Spawn an explorer agent to understand the codebase if needed
3. Create a plan listing:
   - Each task with its role (explorer, coder, reviewer, tester, documenter, architect, designer)
   - Dependencies between tasks (what must finish before what)
   - Which tasks can run in parallel
4. Present the plan to the user: "Here's my plan: [tasks]. Should I proceed?"
5. **Wait for user approval** — NEVER start executing without approval
6. After approval, spawn agents using nexus.spawn() or nexus.delegate()
7. Monitor progress and report when done

## Task Plan Format

When presenting a plan, use this format:

\`\`\`
Plan:

1. [explorer] Analyze the current implementation
   → Needed before: nothing (runs first)

2. [coder] Implement feature X
   → Depends on: task 1
   → Can run in parallel with: nothing

3. [tester] Write tests for feature X
   → Depends on: task 2
   → Can run in parallel with: task 4

4. [coder] Implement feature Y
   → Depends on: task 1
   → Can run in parallel with: task 3

5. [reviewer] Review all changes
   → Depends on: tasks 3, 4
   → Final step

Should I proceed?
\`\`\`

## Spawning Agents

After user approval, spawn agents:

\`\`\`
# Sequential (wait for result)
nexus.delegate(role="explorer", task="Analyze the auth module structure")

# Parallel (don't wait)
nexus.spawn(role="coder", task="Implement JWT auth", wait=false)
nexus.spawn(role="coder", task="Implement refresh tokens", wait=false)
\`\`\`

## Available Roles
- **explorer** — Read-only codebase analysis, architecture understanding
- **coder** — Write and modify code
- **reviewer** — Review code for bugs, security, quality (read-only)
- **tester** — Write and run tests
- **documenter** — Write documentation
- **architect** — Design system architecture (read-only)
- **designer** — Decide UI/UX direction: layout, hierarchy, states, copy (read-only, writes nothing)

### Choosing the designer
The designer **decides and does not build**. Spawn it when the open question is *"how should this look or behave?"* — where a user cannot act today, what the primary action is, what loading/empty/error look like, whether a change is consistent with the rest of the product. It returns a written direction; a coder then implements it.

Do **not** spawn it when:
- The shape of the thing is still undecided — that is the **architect** (schemas, services, API shape). The designer works inside a shape the architect has already settled, and starts at the screen.
- The code already exists and you want it fixed — that is the **coder**, or the **reviewer** if you want it judged rather than changed.
- The layout is already decided and the ask is simply "make this match" — that is **coder** work, and paying a design director to ratify a decision is a cost with no output.
- There is no design problem. A working screen with a clear primary action does not need a designer.

It reads the source and writes nothing, so it is safe to spawn early, before a coder exists, and it is the only role that can answer a design question without first committing to an implementation.

## Cost & Config
- Models configured in nexus.jsonc or ~/.config/opencode/nexus.jsonc
- Use nexus.forecast() to estimate costs before spawning
- Use nexus.costs() to check budget
- Use nexus.performance.best(role) to pick best model for a role

## Git Workflow

When code changes are needed, follow this workflow:

### 1. Pre-Flight
- Detect git status (clean? on which branch?)
- Check for CI/CD config (.github/, .gitlab-ci.yml)
- Verify git identity is set (user.name, user.email)

### 2. Branching
- NEVER commit directly to main
- Create feature branch: feat/description, fix/description, chore/description
- Use conventional branch naming

### 3. Commits
- Use conventional commits: feat:, fix:, docs:, chore:, refactor:, test:
- One logical change per commit
- Imperative mood in commit message
- Reference issues if applicable

### 4. Pull Request
- Create PR with descriptive title and body
- Include: what changed, why, how to test
- Link related issues
- Request review

### 5. Merge
- Squash merge for clean history
- Delete feature branch after merge
- Never force push to shared branches

## Delegation Standard

When spawning a sub-agent, provide:
1. TASK — Atomic, specific goal
2. EXPECTED OUTCOME — Concrete success criteria
3. MUST DO — Exhaustive requirements
4. MUST NOT DO — Forbidden actions
5. REQUIRED TOOLS — What tools to use
6. CONTEXT — File paths, patterns, constraints

## Quality Gates

Before marking a task complete:
1. Code compiles/builds without errors
2. Tests pass
3. No security vulnerabilities (use nexus.security.scan)
4. Follows project conventions
5. Has appropriate test coverage
`

/** Result body every `preset` tool invocation returns. */
interface PresetToolResult {
  content: string
}

/**
 * `preset` with mode 'clear': drop the session-scoped preset override so the
 * disk config is in control again.
 *
 * Goes through `resetToDefaults()` rather than touching `storageConfig`, so
 * the TUI and this tool share one definition of "hand control back to disk".
 * The resolved map is read *after* the clear, so the caller can confirm the
 * outcome instead of taking it on trust — and when there was no override to
 * drop, that is stated rather than dressed up as a successful change.
 */
function clearPresetOverride(orchestrator: NexusOrchestrator): PresetToolResult {
  const configManager = orchestrator.configManager
  const hadOverride = configManager.resetToDefaults()
  const models = configManager.getResolvedModels()
  const resolved = Object.entries(models)
    .map(([role, model]) => `${role}=${model}`)
    .join(' ')

  return {
    content: hadOverride
      ? `Cleared the session preset override. nexus.jsonc is in control again — no config file was modified.\n`
        + `Resolved models now: ${resolved}\n`
        + `sessionOverride: false`
      : `No session preset override was set, so nothing was cleared — nexus.jsonc was already in control. No config file was modified.\n`
        + `Resolved models now: ${resolved}\n`
        + `sessionOverride: false`
  }
}

/**
 * The git convention, as markdown appended to every generated agent file.
 *
 * WHY IT IS A FUNCTION OF THE CONFIG BLOCK AND NOT A CONSTANT: each of the four
 * keys has to be able to switch off the sentence it names, or the key would be
 * a knob that reads as a control and is inert — the defect this repository has
 * shipped twice (`dashboard.enabled`, `notifications.enabled`). Every clause
 * below is therefore reachable from exactly one key, and a clause whose key is
 * off is not emitted at all.
 *
 * The wording is DELIBERATELY about the agent's own conduct. It does not say
 * "nexus will reject", because nothing here rejects anything: the check reports
 * and the user decides. An agent told it will be blocked starts gaming the
 * check; an agent told what is expected simply does the work.
 */
export function buildGitFlowConventionSection(
  config: NexusGitFlowConfig,
  state: GitState
): string {
  const lines: string[] = [
    '## Git Convention',
    '',
    `This project is a git work tree${state.branch ? `, currently on \`${state.branch}\`` : ''}. Follow the conventions below unless the user tells you otherwise.`,
    ''
  ]

  if (config.requireBranch) {
    lines.push(
      '- **Work on a branch.** Do not commit directly to the default branch. If the user asks for a change, create or use a feature branch for it.',
      '- Never create a branch, switch branches, or run any git command that rewrites history unless the user asked for it in this conversation.',
      ''
    )
  }

  if (config.conventionalCommits) {
    lines.push(
      '- **Conventional commit subjects.** When you are asked to commit, the subject line is `type(scope): description`, where `type` is one of '
        + CONVENTIONAL_COMMIT_TYPES.join(', ')
        + '. A `!` before the colon marks a breaking change. Example: `feat(parser): support nested arrays`.',
      '- Keep the subject under ~72 characters and in the imperative mood ("add", not "added").',
      ''
    )
  }

  if (config.prBeforeMerge) {
    lines.push(
      '- **Open a pull request; do not merge.** When work is ready for review, push the branch and open a PR rather than merging it into the branch you are on.',
      ''
    )
  }

  lines.push(
    '- **Never commit, push, or merge on your own initiative.** Report the change you made and let the user decide. If the user explicitly asks you to commit, push or merge, that is the one case where you do.',
    '',
    'You can check where things stand with `nexus.git.check`. It only reports — it never changes anything and never refuses.',
    '',
    'The `gitFlow` block in `.opencode/nexus.jsonc` controls which of these apply. Setting `gitFlow.enabled: false` removes this section entirely on the next plugin start.'
  )

  return lines.join('\n')
}

export default Plugin.define({
  id: "nexus",
  async setup(ctx) {
    // Held here rather than written here: the git convention section appended to
    // each file depends on the RESOLVED config and the detected git state, and
    // neither exists until the orchestrator has loaded `nexus.jsonc` and run
    // detection. The write happens below, after `initialize()`; the content does
    // not move with it.
    const subagents: Record<string, string> = {}

    // Auto-create nexus-orchestrator agent if it doesn't exist
    try {
      const agentDir = join(homedir(), '.config', 'opencode', 'agents')
      mkdirSync(agentDir, { recursive: true })
      
      // Create primary orchestrator agent — always update to latest version
      const orchestratorFile = join(agentDir, 'nexus-orchestrator.md')
      writeFileSync(orchestratorFile, NEXUS_AGENT_CONTENT, 'utf-8')

      // Create subagent files for Nexus roles — always update to latest version
      Object.assign(subagents, {
        'nexus-architect.md': `---
description: Nexus Architect agent — designs system architecture with cost-aware model selection
mode: subagent
permissions:
  - action: edit
    resource: "*"
    effect: allow
  - action: shell
    resource: "*"
    effect: allow
---

# Nexus Architect Agent

You are a senior software architect. You design systems that are scalable, resilient, and secure.

## Core Principles
- **Bounded Contexts**: Decompose by business capability, not technical layer
- **Dependency Inversion**: Depend on abstractions, not concretions
- **Single Responsibility**: Each module does one thing well
- **Interface Segregation**: Small, focused interfaces over large monolithic ones
- **Open/Closed**: Open for extension, closed for modification

## Your Process
1. **Understand Requirements** — Parse functional and non-functional requirements
2. **Identify Boundaries** — Find service boundaries, data ownership, trust zones
3. **Design APIs** — REST for CRUD, GraphQL for complex queries, gRPC for internal services
4. **Plan Data Flow** — Event-driven where decoupling matters, sync where latency matters
5. **Address Cross-Cutting** — Auth, logging, monitoring, rate limiting, caching

## Output Format
- Architecture diagram (text-based or Mermaid)
- Component responsibilities and interfaces
- Data model with relationships
- API contracts (OpenAPI/GraphQL schema)
- Deployment topology
- Risk assessment with mitigation strategies

## Anti-Patterns to Avoid
- God objects/modules that do everything
- Circular dependencies between services
- Shared databases across service boundaries
- Synchronous chains that create tight coupling
- Over-engineering simple problems (YAGNI)`,

        'nexus-coder.md': `---
description: Nexus Coder agent — implements code following SOLID, DRY, KISS, YAGNI
mode: subagent
permissions:
  - action: edit
    resource: "*"
    effect: allow
  - action: shell
    resource: "*"
    effect: allow
---

# Nexus Coder Agent

You are a senior software engineer who writes clean, maintainable, production-ready code.

## Non-Negotiable Principles
- **SOLID**: Single Responsibility, Open/Closed, Liskov Substitution, Interface Segregation, Dependency Inversion
- **DRY**: Don't Repeat Yourself — extract shared logic into reusable abstractions
- **KISS**: Keep It Simple, Stupid — the simplest solution that works is the best
- **YAGNI**: You Aren't Gonna Need It — don't build for hypothetical future requirements

## Code Quality Standards
- **Type Safety**: Use TypeScript strict mode, avoid \`any\`, prefer \`unknown\` with type guards
- **Error Handling**: Never swallow errors; always propagate meaningful context. Use custom error classes.
- **Immutability**: Prefer \`const\`, \`readonly\`, immutable data structures. Mutate only when performance demands it.
- **Pure Functions**: Side effects are explicit and isolated. Pure logic is testable by default.
- **Naming**: Variables describe content, functions describe action, types describe shape. No abbreviations.

## Security-First Development
- Input validation at every boundary (API, CLI, file, env)
- Parameterized queries — never string concatenation for SQL/NoSQL
- No hardcoded secrets — use env vars, vaults, or secret managers
- Sanitize output to prevent XSS/injection
- Use established crypto libraries, never roll your own

## Implementation Process
1. **Read Before Write** — Understand existing patterns before adding new code
2. **Plan the Interface** — Define types and contracts before implementation
3. **Implement Minimum Viable** — Ship the smallest working version, then iterate
4. **Test Alongside** — Write tests for each function/module as you build
5. **Refactor When Done** — Clean up, extract shared logic, improve naming

## Output
- Clean, well-structured code following existing project patterns
- Type definitions for all public interfaces
- Error handling with meaningful messages
- Tests covering happy path, edge cases, and error paths
- Brief inline comments for complex logic (why, not what)`,

        'nexus-explorer.md': `---
description: Nexus Explorer agent — explores codebases and provides architecture analysis
mode: subagent
permissions:
  - action: edit
    resource: "*"
    effect: deny
---

# Nexus Explorer Agent

You are a code archaeologist. You navigate unknown codebases efficiently and build accurate architectural understanding.

## Exploration Strategy
1. **Entry Points First** — Find main files, index files, config files, README
2. **Dependency Graph** — Map imports/exports, identify module boundaries
3. **Data Flow** — Trace how data moves through the system (input → processing → output)
4. **Design Patterns** — Identify GoF, architectural, or domain-specific patterns
5. **Cross-Cutting Concerns** — Find auth, logging, error handling, caching patterns

## Discovery Techniques
- **Config-Driven**: Read package.json, tsconfig, docker-compose, CI configs
- **Import Analysis**: Follow import chains to understand module relationships
- **Type Exploration**: Use TypeScript types to understand data shapes and contracts
- **API Surface**: Find route handlers, CLI entry points, exposed interfaces
- **Test Coverage**: Tests reveal intended behavior and edge cases

## Output Format
- Module map with responsibilities
- Dependency graph (text-based or Mermaid)
- Key data structures and their relationships
- API surface (endpoints, CLI commands, events)
- Architecture pattern identification
- Potential issues or technical debt

## Rules
- Read-only exploration — never modify files
- Be thorough but efficient — follow the most important paths first
- Report uncertainty explicitly — don't guess about unexamined code
- Cite specific file paths and line numbers for all findings`,

        'nexus-tester.md': `---
description: Nexus Tester agent — writes meaningful tests that catch real bugs
mode: subagent
permissions:
  - action: edit
    resource: "*"
    effect: allow
  - action: shell
    resource: "*"
    effect: allow
---

# Nexus Tester Agent

You are a QA engineer who writes tests that catch real bugs, not just increase coverage numbers.

## Test Strategy
- **60% Behavioral Unit Tests** — Test what the code does, not how it does it
- **25% Integration Tests** — Test module interactions and data flow
- **15% Edge Cases** — Boundary values, error paths, concurrency, time-dependent behavior

## Test Quality Criteria
- Each test has a clear, specific assertion — not just "it doesn't crash"
- Tests are independent — no shared state between tests
- Tests are deterministic — same input always produces same result
- Tests are fast — unit tests in milliseconds, integration in seconds
- Tests are maintainable — clear names, minimal setup, obvious intent

## Coverage Priorities
1. **Happy Path** — The expected behavior works
2. **Error Paths** — Invalid input, missing data, network failures
3. **Boundary Values** — Empty arrays, max length, zero values, overflow
4. **State Transitions** — State machine edges, lifecycle events
5. **Concurrency** — Race conditions, parallel execution, timing issues
6. **Regression** — Previously found bugs don't reappear

## What NOT to Test
- Implementation details (private methods, internal state)
- Third-party libraries (trust their own tests)
- Trivial getters/setters
- Tests that always pass regardless of implementation

## Output
- Test file following project conventions
- Clear test names that describe the scenario
- Arrange-Act-Assert structure
- Edge case coverage alongside happy path
- Mock/stub strategy that doesn't hide real bugs`,

        'nexus-reviewer.md': `---
description: Nexus Reviewer agent — reviews code for correctness, security, and quality
mode: subagent
permissions:
  - action: edit
    resource: "*"
    effect: deny
---

# Nexus Reviewer Agent

You are a senior code reviewer. You are brutally honest — you do not praise code, you find problems.

## 3-Tier Review Process

### Tier 1: Correctness
- Does the code do what it claims to do?
- Are edge cases handled (null, empty, overflow, timeout)?
- Is error handling comprehensive and meaningful?
- Are race conditions and concurrency issues addressed?
- Does the code follow existing project patterns?

### Tier 2: Security (OWASP Top 10)
- **Injection**: SQL, NoSQL, command, XSS, template injection
- **Authentication**: Broken auth, session fixation, credential stuffing
- **Authorization**: IDOR, privilege escalation, missing access control
- **Secrets**: Hardcoded keys, tokens, passwords in code
- **Crypto**: Weak algorithms, static IVs, improper key management
- **Data Exposure**: PII leaks, verbose errors, debug mode in production
- **Dependencies**: Known vulnerabilities in imported packages

### Tier 3: Performance & Maintainability
- Algorithmic complexity (O(n²) on large datasets?)
- Memory allocation patterns (unnecessary copies, leaks)
- Database query efficiency (N+1 queries, missing indexes)
- Code duplication (DRY violations)
- Naming clarity (can you understand intent from the name?)
- Documentation gaps (why is non-obvious logic there?)

## Output Format
For each finding:
- **Severity**: Critical / High / Medium / Low / Info
- **Location**: File path + line number
- **Issue**: What's wrong and why it matters
- **Fix**: Concrete suggestion with code example
- **Test**: How to verify the fix works

## Rules
- Be specific — reference exact lines, not vague areas
- Be constructive — every problem comes with a suggested fix
- Be honest — if code is good, say nothing. No empty praise.
- Be thorough — check for issues the author might have missed
- Prioritize — Critical/High issues first, then Medium/Low`,

        'nexus-documenter.md': `---
description: Nexus Documenter agent — writes clear, comprehensive technical documentation
mode: subagent
permissions:
  - action: edit
    resource: "*"
    effect: allow
  - action: shell
    resource: "*"
    effect: allow
---

# Nexus Documenter Agent

You are a technical writer who creates documentation that developers actually want to read.

## Documentation Types

### API Documentation
- Every public function/class/type has a doc comment
- Include: purpose, parameters (with types), return value, exceptions, examples
- Document side effects, thread safety, performance characteristics

### README Files
- What it does (one sentence)
- Quick start (copy-paste commands)
- Installation (multiple methods)
- Configuration (with examples)
- API reference (link to detailed docs)
- Contributing guidelines

### Architecture Docs
- System overview with diagram
- Component responsibilities
- Data flow through the system
- Design decisions and trade-offs (ADRs)
- Deployment and scaling considerations

## Writing Principles
- **Clear**: No jargon without explanation, no ambiguity
- **Concise**: Say it once, say it well. No repetition.
- **Complete**: Cover edge cases, error states, limitations
- **Current**: Documentation that's wrong is worse than none
- **Scannable**: Headers, bullet points, code blocks, tables

## Code Documentation
- Comments explain WHY, not WHAT (code explains what)
- Complex algorithms get a brief explanation of the approach
- TODO/FIXME/HACK comments are tracked and explained
- Changelog follows semantic versioning with clear descriptions`,

        'nexus-designer.md': `---
description: Nexus Designer agent — decides UI/UX direction and writes it up; never implements
mode: subagent
permissions:
  - action: edit
    resource: "*"
    effect: deny
  - action: shell
    resource: "*"
    effect: deny
---

# Nexus Designer Agent

You are a design director. You decide how a thing should look and behave. You do not build it.

The single distinction that defines this role: **you decide, someone else implements.** Every rule below follows from that. A design director who starts editing files has stopped being a design director and become a coder with opinions — and a worse one, because a coder with opinions has no reviewer.

## What You Decide
- **Information architecture**: what the screen is for, what the primary action is, what a user sees first
- **Layout and hierarchy**: what is prominent, what is secondary, what is deliberately absent
- **Interaction model**: what happens on click, on submit, on failure, on empty, on slow
- **State design**: the visual difference between loading, empty, error, and success
- **Tone and copy**: what the words should say, and what they should stop saying
- **Consistency**: whether this matches how the rest of the product already behaves

## What You Never Do
- Write, edit, or patch a file. \`edit\` is denied, and no amount of "just a small change" makes it yours.
- Choose a library, a data structure, or an API shape. That is the architect's call.
- Write tests. A test asserts that the thing is right; deciding what right means comes first.
- Review code for defects. That is the reviewer's call, and it happens after you, not instead of you.
- Redraw an existing implementation as an ASCII diagram and call that a design.

## Reading Is How You Work
You cannot see a rendered screen. You work from source: the component tree, the styles, the markup, the copy, and whatever the user has told you about the problem.

So read before you decide, and be explicit about what you could not see. A direction written without reading the component it describes is a guess, and a guess delivered with the same confidence as a reading is the most expensive thing you can do.

Reading files is how you work; *running* things is not. \`shell\` is denied, deliberately, and the reason is that a design conclusion has to be reproducible from the source. If you start a dev server, run a build, or install a package, the state you are describing stops being the state anyone else will see — and you have quietly become the coder, on a model chosen for judgement rather than for building. Use the read, grep and glob tools for everything you need. If a question genuinely cannot be answered without executing the code, that is an **Open question** in your output, not a command you run.

## Output Format
A design decision, in this shape:

- **Problem**: what a user cannot do today, in one sentence
- **Direction**: the decision itself, stated as a rule rather than a suggestion
- **Rationale**: why this and not the obvious alternative — name the alternative
- **States**: loading, empty, error, success. Every one. A design that only specifies the happy path is not a design.
- **Constraints for the coder**: what the implementer must not break, and what is explicitly out of scope
- **Open questions**: what you could not determine and what would settle it. Say so rather than inventing an answer.

## Rules
- **Decide, don't hedge.** "Consider using a sidebar" is not a direction. "The filter panel is a right-hand sidebar, persistent on desktop, a sheet on mobile" is.
- **Name what you rejected.** Every decision has an alternative; the alternative you passed over is the most useful sentence in the document.
- **Separate the decision from the taste.** "Users need to see all filters at once" is a decision. "Blue feels cleaner" is a preference, and preferences need a reason to survive review.
- **Respect what exists.** A codebase with a working pattern should be extended, not replaced for variety. Proposing a rewrite of a sound existing pattern is a bigger claim and needs a bigger argument.
- **No implementation.** Not a diff, not a snippet "for illustration", not a file rename. The output is a document a coder reads.
- **If there is no design problem, say so.** A working interface with a clear primary action does not need a design director. Inventing work is a cost, and the orchestrator paid for it.`
      })
    } catch {
      // Agent creation is best-effort
    }

    // Ask OpenCode to turn its own LSP support on, by inserting `"lsp": true`
    // into the user's global `opencode.jsonc`.
    //
    // This is the WHOLE of nexus's LSP involvement, and it is deliberately
    // described as such at every level it surfaces: a one-line best-effort
    // config edit, done once, to a file that already exists. There is no
    // language list, no LSP state, and nothing for any nexus surface to
    // display — which is why the capability table in `README.md` says this and
    // not "auto-enabled for 30+ languages". A claim about a subsystem this
    // package does not read is a promise about someone else's code.
    //
    // Best-effort throughout: no file, an unreadable file, a file that already
    // mentions "lsp", or a rewrite that does not match the trailing-brace
    // pattern all leave the file alone rather than risk damaging it.
    try {
      const configPath = join(homedir(), '.config', 'opencode', 'opencode.jsonc')
      if (existsSync(configPath)) {
        const configContent = readFileSync(configPath, 'utf-8')
        // Check if LSP is already configured
        if (!configContent.includes('"lsp"')) {
          // Add lsp: true before the closing brace
          const updated = configContent.replace(
            /\}(\s*)$/,
            ',\n  "lsp": true\n}$1'
          )
          writeFileSync(configPath, updated, 'utf-8')
        }
      }
    } catch {
      // LSP enablement is best-effort
    }

    const orchestrator = new NexusOrchestrator()
    const goalManager = new GoalManager()

    // Write the subagent files, now that `gitFlow` has resolved against the
    // loaded config and the checkout has been inspected.
    //
    // These files are rewritten on EVERY plugin load (documented in 2.9.0,
    // because a hand-edit is destroyed at the next start), which is what makes
    // this the durable place for a convention: there is nowhere else in the
    // system a convention could live and survive a restart.
    //
    // THE FRICTION THIS ACCEPTS, stated plainly: these files live in the user's
    // GLOBAL `~/.config/opencode/agents` and are therefore shared by every
    // project they run nexus in. Injecting repo-specific guidance into a shared
    // file is not project-scoped, and two projects open at once will overwrite
    // each other's copy. That is a real limitation, not a hypothetical.
    //
    // The choice is to CONDITION on the detected state rather than always
    // inject. Outside a work tree — and on a detached HEAD, which cannot hold a
    // branch at all — the files come out byte-identical to what 2.9.0 wrote, so
    // a user with no repository sees no change and the section never asserts a
    // repo-specific fact it cannot see. The costs are stated rather than
    // hidden: the convention is ABSENT in a repository whose state detection
    // failed, and two projects disagree about the shared file's contents.
    // Conditioning was chosen over an unconditional section because telling an
    // agent to work on a branch in a directory that has no branches is the kind
    // of confidently wrong instruction that costs a user an afternoon, and a
    // generic always-on section would have to be vague enough to be true in both
    // cases — which would make it too weak to be a convention at all.
    try {
      const gitState = orchestrator.getGitState()
      const gitFlowResolved = orchestrator.resolveGitFlow()
      const gitFlowSection = gitFlowResolved.active && gitState.isRepo && !gitState.detached
        ? buildGitFlowConventionSection(gitFlowResolved.config, gitState)
        : null

      const agentDir = join(homedir(), '.config', 'opencode', 'agents')
      for (const [filename, content] of Object.entries(subagents)) {
        // Appended, never spliced into the role prose: a convention that
        // rewrote the body would collide with the next release's version of that
        // body, and the section is by construction independent of which role
        // reads it.
        writeFileSync(join(agentDir, filename), gitFlowSection ? `${content}\n\n${gitFlowSection}` : content, 'utf-8')
      }
    } catch {
      // Best-effort, exactly as the primary agent file is. A convention layer
      // that can prevent the agent files from being written is a convention
      // layer that has broken something else to add guidance.
    }

    // Initialize orchestrator with OpenCode context for real session API access
    await orchestrator.initialize(ctx, () => {
      // State change callback - persist to storage for TUI consumption
      const state = orchestrator.getState()
      ctx.storage.set("orchestrator-state", JSON.parse(JSON.stringify(state))).catch(() => {}
      )
      // Also persist sidebar-specific state for the TUI plugin
      const sidebarState = {
        agents: state.agents,
        totalCost: state.totalSpent,
        budgetRemaining: state.budgetRemaining
      }
      ctx.storage.set("nexus-sidebar-state", JSON.parse(JSON.stringify(sidebarState))).catch(() => {})
    })

    // Persist initial state
    await ctx.storage.set("orchestrator-state", JSON.parse(JSON.stringify(orchestrator.getState())))
    // Persist initial sidebar state for TUI plugin
    const initialState = orchestrator.getState()
    await ctx.storage.set("nexus-sidebar-state", JSON.parse(JSON.stringify({
      agents: initialState.agents,
      totalCost: initialState.totalSpent,
      budgetRemaining: initialState.budgetRemaining
    })))

    /**
     * Create a child session and make sure the task reaches it exactly once.
     * Shared by the `spawn` and `delegate` tools.
     *
     * The parent session is taken from the calling tool's own execution context:
     * it is what OpenCode links the child session to (parentID), and it is passed
     * explicitly rather than latched on the orchestrator, which would let
     * internal spawns reuse a foreign parent session. On the subagent-tool path
     * the tool itself delivers the task, so the manual `session.prompt` below
     * only runs on the `session.create` fallback.
     */
    const spawnAndDeliver = async (
      opts: { role: string; task: string; model?: string },
      toolCtx: any,
    ): Promise<SpawnedAgent> => {
      const agent = await orchestrator.spawnAgent({ role: opts.role, model: opts.model }, {
        toolContext: {
          sessionID: toolCtx?.sessionID || '',
          agent: toolCtx?.agent,
          messageID: toolCtx?.messageID,
          callID: toolCtx?.id,
          signal: toolCtx?.signal,
        },
        task: opts.task,
      })

      if (agent.spawnPath !== 'subagent-tool') {
        await ctx.session.prompt({
          sessionID: agent.sessionID!,
          // `agent.deliveredText`, NOT `opts.task`. This fallback re-delivers
          // the task itself, and `spawnAgent` composes any recollection block
          // into the text it delivers on the subagent-tool path. Sending
          // `opts.task` here sent the caller's original string and dropped the
          // block, so the degraded spawn — already the one flagged as
          // `lastDegradedSpawn` — was also the one spawn that recalled nothing.
          //
          // Falls back to `opts.task` so a caller that built its own agent
          // object cannot make this send `undefined`.
          text: agent.deliveredText ?? opts.task
        })
      }

      return agent
    }

    // Register tools
    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "nexus",
        description: "Adaptive multi-agent orchestration tools"
      })

      editor.add({
        name: "status",
        description: "Get orchestrator status, metrics, and the config files currently in effect (paths consulted, which existed, resolved role -> model map)",
        input: {
          type: "object",
          properties: {
            detailed: { type: "boolean", description: "Include detailed metrics" }
          },
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { detailed } = input as { detailed?: boolean }
          const status = orchestrator.getStatus(detailed)
          // Persist after reading
          await ctx.storage.set("orchestrator-state", JSON.parse(JSON.stringify(orchestrator.getState())))
          return { content: status }
        }
      })

      editor.add({
        name: "agents",
        description: "List all active agents",
        input: {
          type: "object",
          properties: {
            filter: { type: "string", description: "Filter by status" }
          },
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { filter } = input as { filter?: string }
          return { content: orchestrator.listAgents(filter) }
        }
      })

      editor.add({
        name: "costs",
        description: "Get cost report and budget status",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async () => {
          return { content: orchestrator.getCostReport() }
        }
      })

      editor.add({
        name: "notifications.test",
        description: NOTIFICATIONS_TEST_DESCRIPTION,
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async () => {
          return { content: await runNotificationsTest(orchestrator) }
        }
      })

      editor.add({
        name: "dashboard",
        description: "Get full orchestrator state for dashboard display",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async () => {
          const state = orchestrator.getState()
          await ctx.storage.set("orchestrator-state", JSON.parse(JSON.stringify(state)))
          return { content: JSON.stringify(state, null, 2) }
        }
      })

      editor.add({
        name: "queue",
        description: "Show current task queue with priorities",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async () => {
          const state = orchestrator.getState()
          const tasks = state.tasks || []
          return { content: JSON.stringify(tasks, null, 2) }
        }
      })

      editor.add({
        name: "config.save",
        description: "Save Nexus config to disk (project or global)",
        input: {
          type: "object",
          properties: {
            level: { type: "string", enum: ["project", "global"], description: "Config level to save" },
            basePath: { type: "string", description: "Project root (for project-level, defaults to cwd)" }
          },
          required: ["level"],
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { level, basePath } = input as { level: 'project' | 'global'; basePath?: string }
          orchestrator.configManager.saveConfig(level, basePath || process.cwd())
          const location = level === 'project'
            ? `${basePath || process.cwd()}/.opencode/nexus.jsonc`
            : '~/.config/opencode/nexus.jsonc'
          return { content: `Config saved to ${level} level at ${location}` }
        }
      })

      editor.add({
        name: "config.init",
        description: "Initialize default config files for project and/or global",
        input: {
          type: "object",
          properties: {
            level: { type: "string", enum: ["project", "global", "both"], description: "Which config to initialize" },
            basePath: { type: "string", description: "Project root" }
          },
          required: ["level"],
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { level, basePath } = input as { level: 'project' | 'global' | 'both'; basePath?: string }
          const path = basePath || process.cwd()
          const locations: string[] = []
          if (level === 'project' || level === 'both') {
            orchestrator.configManager.initProjectConfig(path)
            locations.push(`${path}/.opencode/nexus.jsonc`)
          }
          if (level === 'global' || level === 'both') {
            orchestrator.configManager.initGlobalConfig()
            locations.push('~/.config/opencode/nexus.jsonc')
          }
          return { content: `Config initialized at ${level} level(s): ${locations.join(', ')}` }
        }
      })

      editor.add({
        name: "preset",
        description: "Apply a session preset (model/budget selection), or clear it with mode 'clear' to hand control back to nexus.jsonc. A preset shadows the config file's models, so call mode 'clear' if the user edited nexus.jsonc but no model changed.",
        input: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["apply", "clear"],
              description: "'apply' (default) applies the named preset for this session. 'clear' drops the session preset override so nexus.jsonc is in control again — use it whenever edits to nexus.jsonc appear to have no effect."
            },
            name: {
              type: "string",
              description: "Preset name (minimal, balanced, enterprise, cost-optimized). Required for mode 'apply'; ignored by 'clear'."
            }
          },
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { mode, name } = input as { mode?: 'apply' | 'clear'; name?: string }

          if (mode === 'clear') return clearPresetOverride(orchestrator)

          if (!name) {
            // Do not silently do nothing: a missing name is a mistake, and the
            // fix is either a valid preset name or mode 'clear'.
            return { content: `Error: mode 'apply' needs a \`name\` (${orchestrator.configManager.listPresets().join(', ')}). To hand control back to nexus.jsonc instead, call preset with mode: 'clear'.` }
          }
          try {
            orchestrator.configManager.applyPreset(name)
            // A preset replaces the whole models level, so it now shadows
            // nexus.jsonc. Say that here, at the moment the user is told the
            // preset was applied — otherwise a later edit that does nothing is
            // the same silent surprise as a missing reload.
            return {
              content: `Applied preset: ${PRESETS[name]?.name || name}\n`
                + `⚠️ This preset now overrides the \`models\` section of nexus.jsonc. `
                + `Edits to models in the config file will NOT take effect until the preset is cleared. `
                + `Clear it with this tool (mode: 'clear'), or from the TUI (config manager), to hand control back to disk. `
                + `Budget and self-healing values from the file still apply.`,
            }
          } catch (error: any) {
            return { content: `Error: ${error.message}` }
          }
        }
      })

      editor.add({
        name: "dashboard.start",
        description: DASHBOARD_START_DESCRIPTION,
        input: {
          type: "object",
          properties: {
            port: { type: "number", description: "Port to listen on (default: 4747, or `dashboard.port` from nexus.jsonc). Must be free." },
            host: { type: "string", description: "Bind address (default: 127.0.0.1, or `dashboard.host` from nexus.jsonc)" }
          },
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { port, host } = input as { port?: number; host?: string }
          return { content: runDashboardStart(orchestrator, port, host) }
        }
      })

      editor.add({
        name: "dashboard.stop",
        description: DASHBOARD_STOP_DESCRIPTION,
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async () => {
          return { content: runDashboardStop(orchestrator) }
        }
      })

      editor.add({
        name: "model.costs",
        description: "Show real model pricing from OpenCode, or set custom costs. All prices are USD per 1K tokens.",
        input: {
          type: "object",
          properties: {
            model: { type: "string", description: "Model to show cost for, as 'provider/id', 'provider/id#variant', or a bare 'id' (optional, shows all if omitted). A '#variant' is priced as the underlying model: variants carry no price of their own, so effort changes token volume, not rate." },
            setInput: { type: "number", description: "Set input cost in USD per 1K tokens for a model (e.g. 0.003 for $3 per million tokens)" },
            setOutput: { type: "number", description: "Set output cost in USD per 1K tokens for a model (e.g. 0.015 for $15 per million tokens)" }
          },
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { model, setInput, setOutput } = input as { model?: string; setInput?: number; setOutput?: number }

          // Every price `modelCosts` holds is USD per 1K tokens.
          const per1k = (v: number) => `$${v}/1K tokens`

          // A tiered price list, rendered one line per row. `tiers` is ordered
          // untiered-base-first by `loadModelCosts` / `setModelCosts`, and a
          // context tier is labelled with the prompt size it applies ABOVE.
          const renderTiers = (cost: NexusModelCost): string =>
            cost.tiers
              .map(t => (t.threshold === undefined
                ? `base: in=${per1k(t.rates.input)}, out=${per1k(t.rates.output)}, cache_read=${per1k(t.rates.cacheRead)}, cache_write=${per1k(t.rates.cacheWrite)}`
                : `over ${t.threshold} prompt tokens: in=${per1k(t.rates.input)}, out=${per1k(t.rates.output)}, cache_read=${per1k(t.rates.cacheRead)}, cache_write=${per1k(t.rates.cacheWrite)}`))
              .join('\n            ')

          if (model && setInput !== undefined && setOutput !== undefined) {
            // Set custom cost
            orchestrator.setModelCosts({ [model]: { input: setInput, output: setOutput } })
            return { content: `Set ${model}: input=${per1k(setInput)}, output=${per1k(setOutput)}` }
          }

          if (model) {
            // Show specific model cost. `modelCosts` is keyed by
            // "providerID/id" but users type either that or a bare id, so
            // `getModelCost` resolves both.
            const cost = orchestrator.getModelCost(model)
            if (cost) {
              return { content: `${model} (real pricing, from OpenCode):\n            ${renderTiers(cost)}` }
            }
            // No real pricing. Source this from the forecaster so the number
            // carries the rate AND the table it came from: the old
            // `estimateModelCost` printed a bare `estimated $X/1K tokens` whose
            // X was not a price at all but the mean of a real rate and a
            // hand-tuned relative table entry. A number with no unit and no
            // provenance is the one output this tool must never produce.
            const { pricing, source } = orchestrator.forecaster.priceFor(model)
            const label = source === 'model-costs'
              ? 'real pricing'
              : source === 'fallback-table'
                ? 'ESTIMATE (fallback table, not provider pricing)'
                : 'ESTIMATE (unknown model — no table knows this rate)'
            return { content: `${model}: no real pricing data.\n            ${label}: in=${per1k(pricing.input)}, out=${per1k(pricing.output)}, cache_read=${per1k(pricing.cacheRead)}, cache_write=${per1k(pricing.cacheWrite)}` }
          }

          // Show all loaded costs, grouped by provider.
          //
          // Grouping and price text both come from `src/model-groups.ts`, the
          // same helpers the TUI picker uses, so the two surfaces cannot drift
          // apart. The display names come from the ORCHESTRATOR's catalogue
          // (`getProviderList`, loaded once at `initialize()`), not from a
          // `ctx.provider.list()` here: this tool used to run its own fetch on
          // every call, which meant the dashboard and this report were reading
          // two different snapshots of the same data and could print different
          // headings for the same models. One snapshot, one answer. The cost of
          // that is boot-time staleness, which is stated in `loadProviderNames`
          // and in the README.
          //
          // `renderTiers` is NOT used here: it prints four rates per tier and a
          // multi-line block per model, which is right for the single-model
          // report above and unreadable as a catalogue. The single-model branch
          // keeps it, and keeps its cache rates, so nothing this branch stops
          // showing is unreachable.
          return {
            content: renderModelCostReport(
              orchestrator.modelCosts,
              orchestrator.getProviderList(),
            )
          }
        }
      })

      editor.add({
        name: "spawn",
        description: "Spawn a sub-agent for a task. Use wait=true to wait for completion.",
        input: {
          type: "object",
          properties: {
            role: { type: "string", description: "Agent role (architect, coder, reviewer, tester, explorer, documenter, designer). 'designer' decides UI/UX direction (layout, hierarchy, loading/empty/error states, copy) and writes a direction a coder implements — it never writes code itself." },
            task: { type: "string", description: "Task description" },
            model: { type: "string", description: "Model override (optional), as 'providerID/modelID' or 'providerID/modelID#variant' (e.g. 'anthropic/claude-sonnet-4-6#high'). The delimiter is a hash, not an at-sign. A bare model id is auto-completed against the configured models and throws if none matches." },
            wait: { type: "boolean", description: "Wait for completion (default: false)" },
            timeout: { type: "number", description: "Timeout in ms when waiting (default: 120000)" }
          },
          required: ["role", "task"],
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown, toolCtx: any) => {
          const { role, task, model, wait, timeout } = input as { role: string; task: string; model?: string; wait?: boolean; timeout?: number }
          try {
            const agent = await spawnAndDeliver({ role, task, model }, toolCtx)

            agent.status = 'working'
            orchestrator.notifyStateChange()

            // If wait is requested, block until completion or timeout
            if (wait) {
              const waitTimeout = timeout || 120000
              const waitPromise = ctx.session.wait({ sessionID: agent.sessionID! })
              const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`Timed out after ${waitTimeout}ms`)), waitTimeout)
              )

              try {
                await Promise.race([waitPromise, timeoutPromise])
              } catch (waitError: any) {
                // Timeout or cancellation — agent may still be running
                agent.status = 'working'
                orchestrator.notifyStateChange()

                // Try to get whatever results are available
                try {
                  const messages = await ctx.session.context({ sessionID: agent.sessionID! })
                  const partialText = lastAssistantText(messages)
                  if (partialText) {
                    agent.status = 'completed'
                    await ctx.storage.set("orchestrator-state", JSON.parse(JSON.stringify(orchestrator.getState())))
                    const taskPreview = task.length > 80 ? task.substring(0, 77) + '...' : task
                    return {
                      content: [
                        `${agent.name}`,
                        `📋 Task: ${taskPreview}`,
                        `⏱️ Status: ${waitError.message || 'timeout'}`,
                        `📎 Session: ${agent.sessionID}`,
                        `\n--- Partial Result ---`,
                        partialText
                      ].join('\n')
                    }
                  }
                } catch {
                  // Context read also failed
                }

                return {
                  content: [
                    `${agent.name}`,
                    `📋 Task: ${task.length > 80 ? task.substring(0, 77) + '...' : task}`,
                    `⏱️ Status: ${waitError.message || 'timeout'}`,
                    `📎 Session: ${agent.sessionID}`,
                    `💡 Use nexus.result(sessionID="${agent.sessionID}") to check later`
                  ].join('\n')
                }
              }

              // Wait completed — get final results
              try {
                const messages = await ctx.session.context({ sessionID: agent.sessionID! })
                const result = lastAssistantText(messages) || 'Task completed (no output captured)'

                agent.status = 'completed'
                await ctx.storage.set("orchestrator-state", JSON.parse(JSON.stringify(orchestrator.getState())))

                const taskPreview = task.length > 80 ? task.substring(0, 77) + '...' : task
                return {
                  content: [
                    `${agent.name}`,
                    `📋 Task: ${taskPreview}`,
                    `✅ Status: completed`,
                    `📎 Session: ${agent.sessionID}`,
                    `\n--- Result ---`,
                    typeof result === 'string' ? result : JSON.stringify(result)
                  ].join('\n')
                }
              } catch {
                // Context read failed after successful wait
                agent.status = 'completed'
                await ctx.storage.set("orchestrator-state", JSON.parse(JSON.stringify(orchestrator.getState())))
                return {
                  content: [
                    `${agent.name}`,
                    `✅ Status: completed`,
                    `📎 Session: ${agent.sessionID}`,
                    `⚠️ Could not read result output`
                  ].join('\n')
                }
              }
            }

            // Non-wait: return spawn info with complexity analysis
            const complexity = orchestrator.analyzeComplexity({
              id: `spawn-${Date.now()}`,
              name: task,
              description: task,
              files: { include: [] },
              dependencies: [],
              requiredRole: role,
              complexity: { overall: 0, factors: { fileCount: 0, codeLines: 0, dependencyDepth: 0, domainKnowledge: 0, riskLevel: 'low' } },
              priority: 'normal',
              status: 'running'
            })
            agent.complexity = complexity

            const modelSelection = orchestrator.selectModel(role, complexity)

            await ctx.storage.set("orchestrator-state", JSON.parse(JSON.stringify(orchestrator.getState())))
            const taskPreview = task.length > 80 ? task.substring(0, 77) + '...' : task
            const output = [
              `${agent.name}`,
              `📋 Task: ${taskPreview}`,
              `📊 Complexity: ${complexity.overall}/100 (${complexity.factors.riskLevel} risk)`,
              `🤖 Model reasoning: ${modelSelection.reasoning}`,
              `📎 Session: ${agent.sessionID}`,
              `💡 Use wait=true to wait for completion, or nexus.result() to fetch later`
            ].join('\n')
            return { content: output }
          } catch (error: any) {
            return { content: `Failed to spawn agent: ${error.message}` }
          }
        }
      })

      editor.add({
        name: "delegate",
        description: "Delegate a task to a sub-agent and wait for result (convenience wrapper around spawn+wait)",
        input: {
          type: "object",
          properties: {
            role: { type: "string", description: "Agent role (architect, coder, reviewer, tester, explorer, documenter, designer). 'designer' decides UI/UX direction (layout, hierarchy, loading/empty/error states, copy) and writes a direction a coder implements — it never writes code itself." },
            task: { type: "string", description: "Task description" },
            model: { type: "string", description: "Model override (optional), as 'providerID/modelID' or 'providerID/modelID#variant'. The delimiter is a hash, not an at-sign." },
            timeout: { type: "number", description: "Timeout in ms (default: 120000)" }
          },
          required: ["role", "task"],
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown, toolCtx: any) => {
          const { role, task, model, timeout } = input as { role: string; task: string; model?: string; timeout?: number }
          try {
            const agent = await spawnAndDeliver({ role, task, model }, toolCtx)

            agent.status = 'working'
            orchestrator.notifyStateChange()

            const waitTimeout = timeout || 120000
            const waitPromise = ctx.session.wait({ sessionID: agent.sessionID! })
            const timeoutPromise = new Promise<'timeout'>((resolve) =>
              setTimeout(() => resolve('timeout'), waitTimeout)
            )

            const outcome = await Promise.race([waitPromise.then(() => 'completed' as const), timeoutPromise])

            // Get the result regardless of outcome
            try {
              const messages = await ctx.session.context({ sessionID: agent.sessionID! })
              const resultContent = lastAssistantText(messages) || (outcome === 'timeout' ? 'Timed out — agent may still be running' : 'Completed with no output')

              agent.status = outcome === 'timeout' ? 'working' : 'completed'
              orchestrator.notifyStateChange()
              await ctx.storage.set("orchestrator-state", JSON.parse(JSON.stringify(orchestrator.getState())))

              const statusIcon = outcome === 'timeout' ? '⏱️' : '✅'
              return {
                content: [
                  `${agent.name}`,
                  `📋 Task: ${task.length > 80 ? task.substring(0, 77) + '...' : task}`,
                  `${statusIcon} Status: ${outcome}`,
                  `📎 Session: ${agent.sessionID}`,
                  `\n--- Result ---`,
                  typeof resultContent === 'string' ? resultContent : JSON.stringify(resultContent)
                ].join('\n')
              }
            } catch {
              agent.status = outcome === 'timeout' ? 'working' : 'completed'
              orchestrator.notifyStateChange()
              return {
                content: [
                  `${agent.name}`,
                  `${outcome === 'timeout' ? '⏱️' : '✅'} Status: ${outcome}`,
                  `📎 Session: ${agent.sessionID}`,
                  `⚠️ Could not read result output`
                ].join('\n')
              }
            }
          } catch (error: any) {
            return { content: `Delegate failed: ${error.message}` }
          }
        }
      })

      editor.add({
        name: "template",
        description: "List or instantiate task templates",
        input: {
          type: "object",
          properties: {
            name: { type: "string", description: "Template name to instantiate (or 'list' to show all)" },
            baseDir: { type: "string", description: "Base directory for file paths" }
          },
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { name, baseDir } = input as { name?: string; baseDir?: string }
          if (!name || name === 'list') {
            const templates = listTemplates()
            return { content: templates.map(t => `${t}: ${TEMPLATES[t].description}`).join('\n') }
          }
          try {
            const tasks = instantiateTemplate(name, baseDir || process.cwd())
            return { content: JSON.stringify(tasks, null, 2) }
          } catch (error: any) {
            return { content: `Error: ${error.message}` }
          }
        }
      })

      editor.add({
        name: "performance.scores",
        description: "Show agent performance scores by model and role",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async () => {
          const scores = orchestrator.performanceTracker.getScores()
          if (scores.length === 0) return { content: "No performance data yet. Scores build up as tasks are executed." }
          const lines = scores.map(s => `${s.role}/${s.model}: score=${s.overallScore.toFixed(1)} success=${(s.successRate*100).toFixed(0)}% ${renderCostBasis(s)} (${s.totalTasks} tasks)`)
          return { content: lines.join('\n') }
        }
      })

      editor.add({
        name: "performance.best",
        description: "Get best model for a specific role",
        input: {
          type: "object",
          properties: {
            role: { type: "string", description: "Agent role to find best model for" }
          },
          required: ["role"],
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { role } = input as { role: string }
          const best = orchestrator.performanceTracker.getBestModel(role)
          if (!best) return { content: `No performance data for role '${role}' yet.` }
          return { content: `Best for ${role}: ${best.model} (score: ${best.overallScore.toFixed(1)}, success: ${(best.successRate*100).toFixed(0)}%, ${renderCostBasis(best)})` }
        }
      })

      editor.add({
        name: "security.scan",
        description: "Scan content for security issues",
        input: {
          type: "object",
          properties: {
            content: { type: "string", description: "Code content to scan" },
            filename: { type: "string", description: "Filename for context" }
          },
          required: ["content"],
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { content, filename } = input as { content: string; filename?: string }
          const issues = orchestrator.securityScanner.scanContent(content, filename || 'unknown')
          const result = orchestrator.securityScanner.getResult()
          return { content: JSON.stringify({ issues: issues.length, score: result.score, details: issues }, null, 2) }
        }
      })

      editor.add({
        name: "history.list",
        description: "List execution history",
        input: {
          type: "object",
          properties: {
            count: { type: "number", description: "Number of recent entries" }
          },
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { count } = input as { count?: number }
          const records = count ? orchestrator.executionHistory.getRecent(count) : orchestrator.executionHistory.getAll()
          if (records.length === 0) return { content: "No execution history yet." }
          const lines = records.map(r => `${r.status === 'success' ? '✅' : '❌'} ${r.taskName} (${r.role}) — ${renderCost(r.cost, r.costProvenance)} — ${r.duration}ms`)
          return { content: lines.join('\n') }
        }
      })

      editor.add({
        name: "history.stats",
        description: "Show execution statistics",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async () => {
          const stats = orchestrator.executionHistory.getStats()
          // `totalCost` sums measured and estimated charges, so it is reported
          // with the split rather than on its own.
          return { content: `Total: ${stats.total} | Success: ${(stats.successRate * 100).toFixed(1)}% | Cost: $${stats.totalCost.toFixed(4)} (measured $${stats.costSplit.measuredCost.toFixed(4)} over ${stats.costSplit.measuredEntries} tasks, estimated $${stats.costSplit.estimatedCost.toFixed(4)} over ${stats.costSplit.estimatedEntries} tasks) | Avg: ${stats.avgDuration.toFixed(0)}ms\nBy role: ${JSON.stringify(stats.byRole)}` }
        }
      })

      // ── Memory ───────────────────────────────────────────────────────────
      //
      // Three tools, and the split between them is the point: `set` and
      // `search`/`list` are REACTIVE (an agent has to remember to call them,
      // and agents forget), while the recollection block injected at spawn is
      // PROACTIVE and is what makes a written note actually get used. These
      // tools are also the day-one value: the store ships EMPTY, so the
      // injection half recalls nothing for anyone until something is written
      // here.
      //
      // `scope` on `set` is a THREE-value enum, not the full `MemoryScope`,
      // and the two excluded values are excluded on purpose:
      //   - `session` is the orchestrator's own escalation-transfer channel.
      //     Letting an agent write there would let it fabricate a context blob
      //     that reads as one the orchestrator produced.
      //   - `learning` is an unused string in the table that shares a name with
      //     a different mechanism (`src/learning.ts`) which is written
      //     AUTOMATICALLY on every failure. Never writable, never injected.

      editor.add({
        name: "memory.set",
        description: "Write a durable note. Nothing is ever written automatically — this is the only way in, and nothing is injected into a task's prompt unless the key is `file:<path>` naming a file that task is scoped to. Appends, so correcting a note writes a new version rather than replacing the old. Scope is project (durable) or temp (scratch); session and learning are not writable.",
        input: {
          type: "object",
          properties: {
            key: {
              type: "string",
              description: "The note's key. Use `file:<path>` (e.g. `file:src/memory-store.ts`) to have it injected automatically into tasks touching that file. Any other key is reachable only by search."
            },
            value: { description: "The note. A string, or any JSON value." },
            scope: {
              type: "string",
              enum: ["project", "temp"],
              description: "project = durable and never evicted by count. temp = scratch, FIFO-evicted. Default: project."
            },
            author: {
              type: "string",
              description: "Who is writing this. Required, and SELF-REPORTED: nothing verifies it, and it is shown to readers as a claim rather than a record."
            },
            confidence: {
              type: "number",
              description: "How sure you are, 0–1. Optional. OMIT IT if you are not sure — an entry that records no confidence is not a low-confidence entry, and inventing a number makes your uncertainty invisible to whoever reads it later."
            },
            tags: { type: "array", items: { type: "string" }, description: "Optional labels." },
            ttl: { type: "number", description: "Optional expiry in ms. Off by default, and for `project` notes that is deliberate: nothing revalidates or rewrites a note, so an expiry would delete it permanently." }
          },
          required: ["key", "value", "author"],
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { key, value, scope, author, confidence, tags, ttl } = input as {
            key: string; value: unknown; scope?: 'project' | 'temp'; author: string
            confidence?: number; tags?: string[]; ttl?: number
          }
          const targetScope: MemoryScope = scope ?? 'project'
          try {
            const entry = orchestrator.memoryStore.set({
              key,
              value,
              scope: targetScope,
              author,
              confidence: confidence ?? null,
              tags: tags ?? [],
              ...(ttl ? { ttl } : {})
            })
            orchestrator.notifyMemoryWritten(entry)
            // Read AFTER the write, so the count is the number that exists now
            // and includes the entry just written.
            const versionsUnderKey = orchestrator.memoryStore.getByKey(key, targetScope).length
            const eviction = orchestrator.memoryStore.takeEviction()
            return {
              content: describeSetResult({
                entry,
                versionsUnderKey,
                evicted: eviction ? { scope: eviction.scope, count: eviction.count } : null,
              })
            }
          } catch (err) {
            // Reported as text, for the same reason `git.check` reports rather
            // than throws: a tool result the agent can read and relay beats an
            // exception it has to interpret. And it says what did NOT happen, so
            // a failed write is never read as a successful one.
            return { content: `memory.set did not write anything: ${err instanceof Error ? err.message : String(err)}. The store is unchanged.` }
          }
        }
      })

      editor.add({
        name: "memory.search",
        description: "Search notes by substring, over keys AND values. Unranked, so a result count is hits not relevance, and nothing is verified against the code. Project scope only unless you ask for internal session context.",
        input: {
          type: "object",
          properties: {
            query: { type: "string", description: "Substring to look for. A path or an identifier matches better than a description." },
            includeSession: {
              type: "boolean",
              description: "Also return internal escalation context — snapshots a failed agent wrote when it exhausted its retries. Those are labelled, never presented as notes, and are never injected into a task. For debugging escalations only."
            }
          },
          required: ["query"],
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { query, includeSession } = input as { query: string; includeSession?: boolean }
          // D1, enforced here rather than inside `searchMemory` so the allowlist
          // is visible at the surface that could get it wrong: project by
          // default, project + session only on an explicit opt-in, and never
          // `learning` — which is not a note store at all but the name of a
          // different, automatically-written mechanism.
          const scopes: MemoryScope[] = includeSession ? ['project', 'session'] : ['project']
          const results = orchestrator.searchMemory(query, scopes)
          const stats = orchestrator.memoryStore.getStats()
          return {
            content: describeSearchResult({
              query,
              results,
              storeTotal: stats.total,
              dbPath: orchestrator.memoryStore.path,
              includeSession: includeSession === true,
            })
          }
        }
      })

      editor.add({
        name: "memory.list",
        description: "List notes in a scope, newest version of each key first, with the entry counts by scope and anything evicted for exceeding a per-scope cap. Nothing here is verified against the code.",
        input: {
          type: "object",
          properties: {
            scope: {
              type: "string",
              enum: ["project", "session", "temp"],
              description: "Which scope to list. Default: project."
            },
            limit: { type: "number", description: "Maximum notes to show. Default 50." }
          },
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { scope, limit } = input as { scope?: MemoryScope; limit?: number }
          const targetScope: MemoryScope = scope ?? 'project'
          const cappedAt = Number.isFinite(limit) && (limit as number) > 0 ? Math.floor(limit as number) : 50
          const { entries, versionsSuperseded } = orchestrator.listMemory(targetScope, cappedAt)
          const stats = orchestrator.memoryStore.getStats()
          return {
            content: describeListResult({
              scope: targetScope,
              entries,
              versionsSuperseded,
              byScope: stats.byScope,
              evicted: stats.evicted,
              truncatedAt: cappedAt,
              dbPath: orchestrator.memoryStore.path,
            })
          }
        }
      })

      editor.add({
        name: "roles.list",
        description: "List all custom agent roles",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async () => {
          const roles = orchestrator.customRoles.list()
          if (roles.length === 0) return { content: "No custom roles defined. Add them in .opencode/nexus.jsonc under 'customRoles', or register one for this session with roles.add." }
          const lines = roles.map(r => `${r.emoji} ${r.displayName} (${r.name}): ${r.prompt.substring(0, 60)}...`)
          return { content: lines.join('\n') }
        }
      })

      editor.add({
        name: "roles.add",
        description: "Add a custom agent role",
        input: {
          type: "object",
          properties: {
            name: { type: "string", description: "Role identifier (lowercase, no spaces)" },
            displayName: { type: "string", description: "Display name" },
            emoji: { type: "string", description: "Emoji for the role" },
            prompt: { type: "string", description: "System prompt for this role" },
            model: { type: "string", description: "First-choice model for the role (optional). It is the first candidate the ranker considers, not the model the spawn necessarily uses: a models[role] entry takes precedence over it, and the ranker is free to select another candidate." }
          },
          required: ["name", "displayName", "prompt"]
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { name, displayName, emoji, prompt, model } = input as any
          orchestrator.customRoles.register({ name, displayName, emoji: emoji || '🤖', prompt, model })
          // Session-only, and said so here because it no longer is: a config
          // reload replaces the registry from the file, so a role added this
          // way and not written to `nexus.jsonc` stops resolving on the next
          // reload. The tool used to imply it had registered something durable.
          return { content: `Custom role '${displayName}' registered for this session. To keep it across config reloads and restarts, add it to .opencode/nexus.jsonc under 'customRoles'.` }
        }
      })

      editor.add({
        name: "forecast",
        description: "Estimate cost before executing tasks",
        input: {
          type: "object",
          properties: {
            tasks: { type: "string", description: "JSON array of tasks with role, model, and complexity" }
          },
          required: ["tasks"]
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { tasks } = input as { tasks: string }
          const taskList = JSON.parse(tasks)
          const remaining = orchestrator.budget.maxTotalCost - orchestrator.totalSpent

          // Support both formats: full Task objects or simple {role, model, complexity}
          const normalizedTasks = taskList.map((t: any) => ({
            task: t.task || {
              id: `forecast-${Date.now()}`,
              name: t.name || `${t.role} task`,
              description: t.description || '',
              files: { include: [] },
              dependencies: [],
              requiredRole: t.role,
              complexity: typeof t.complexity === 'number'
                ? { overall: t.complexity, factors: { fileCount: 0, codeLines: 0, dependencyDepth: 0, domainKnowledge: 0, riskLevel: 'low' as const } }
                : { overall: 50, factors: { fileCount: 0, codeLines: 0, dependencyDepth: 0, domainKnowledge: 0, riskLevel: 'low' as const } },
              priority: 'normal' as const,
              status: 'pending' as const
            },
            role: t.role,
            model: t.model,
            complexity: typeof t.complexity === 'number'
              ? { overall: t.complexity, factors: { fileCount: 0, codeLines: 0, dependencyDepth: 0, domainKnowledge: 0, riskLevel: 'low' as const } }
              : t.complexity || { overall: 50, factors: { fileCount: 0, codeLines: 0, dependencyDepth: 0, domainKnowledge: 0, riskLevel: 'low' as const } }
          }))

          const result = orchestrator.forecaster.forecastAll(normalizedTasks, remaining)
          const lines = result.estimates.map(e => `${e.taskName}: ~$${e.estimatedCost.toFixed(4)} (${e.model})`)
          lines.push(`\nTotal: ~$${result.totalEstimatedCost.toFixed(4)}`)
          lines.push(`Budget remaining: $${remaining.toFixed(2)}`)
          lines.push(`Within budget: ${result.withinBudget ? '✅' : '❌'}`)
          return { content: lines.join('\n') }
        }
      })

      editor.add({
        name: "worktree.enable",
        description: "Enable git worktree isolation for agents",
        input: { type: "object", properties: { repoRoot: { type: "string", description: "Repository root (defaults to cwd)" } } },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { repoRoot } = input as { repoRoot?: string }
          orchestrator.enableWorktrees(repoRoot || process.cwd())
          return { content: "Git worktree isolation enabled." }
        }
      })

      // Reports, never blocks. The description says so in the tool's own
      // listing, because the single most important property of this tool is the
      // one a model cannot infer from its name: it does not change the
      // repository, and it does not refuse.
      editor.add({
        name: "git.check",
        description: "Report on the git convention for this repository: branch, conventional commit subjects, and whether the branch is published. Read-only — it runs no git commit, push or merge, and never refuses. With `decision`, record this repository's one-time answer instead.",
        input: {
          type: "object",
          properties: {
            decision: {
              type: "string",
              enum: ["on", "off"],
              description: "Record the answer for this repository and stop asking. Omit to just report."
            },
            cwd: { type: "string", description: "Directory to inspect. Defaults to the working directory." }
          },
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { decision, cwd } = input as { decision?: 'on' | 'off'; cwd?: string }
          try {
            if (decision) {
              const recorded = orchestrator.recordGitFlowDecision(decision, cwd)
              return {
                content: [
                  `Recorded the git convention decision for this repository: ${recorded}.`,
                  `It is keyed by the resolved repository root and stored in ~/.config/opencode/nexus-gitflow.json,`,
                  `which is nexus's own global config directory — nothing was written to your repository and no git command was run.`,
                  `This will not be asked again for this repository.`,
                  `Current effective state: ${orchestrator.resolveGitFlow(cwd).reason}`
                ].join(' ')
              }
            }
            const report = orchestrator.checkGitFlow(cwd)
            // STATUS-SHAPED, and the ask travels through here. A subagent is
            // driven by tool calls and has no channel to a human, so the only
            // way to ask is to TELL the agent it must ask: the instruction is
            // in the tool result the agent is already reading, and the agent
            // carries it to the user in its own next message. It is emitted only
            // when the answer is genuinely undecided, so a second run in a repo
            // that has already answered stays silent.
            const lines = [
              report.summary,
              '',
              ...report.commits.map(c => `  ${c.conventional ? '✅' : '❌'} ${c.sha.slice(0, 8)} ${c.subject}`),
              report.commits.length === 0 ? '  (no commit subjects were read)' : '',
              '',
              `Scope: commits on this branch since \`${report.scope.base}\` (${report.scope.baseSource}).`,
              `This check ${report.didNot.join('; ')}.`
            ].filter(Boolean)
            if (report.decision === null) {
              lines.push('',
                'ACTION FOR YOU, NOT FOR A TOOL: the git convention is enabled by default and no answer has been recorded for this repository.',
                'Ask the user ONCE, in your own reply, and do not proceed past the question without an answer:',
                '  1. whether nexus should follow the branch / conventional-commit / PR path in this repository, or stay out of its git entirely;',
                '  2. then call this tool again with decision: "on" or decision: "off" to record the answer.',
                'Report what you found either way — this tool never refuses and never writes to the repository.'
              )
            }
            return { content: lines.join('\n') }
          } catch (err) {
            // The one failure this tool can surface is a decision recorded
            // outside a repository, which is a genuine "there is nothing to
            // record" rather than a crash. Reported as text, because a tool
            // result the agent can read and relay beats an exception it has to
            // interpret.
            return { content: `git.check could not complete: ${err instanceof Error ? err.message : String(err)}. No git command was run and nothing was written.` }
          }
        }
      })

      editor.add({
        name: "worktree.list",
        description: "List active agent worktrees",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: true },
        execute: async () => {
          if (!orchestrator.worktreeManager) return { content: "Worktree isolation not enabled." }
          const wts = orchestrator.worktreeManager.list()
          if (wts.length === 0) return { content: "No active worktrees." }
          return { content: wts.map(w => `${w.agentId}: ${w.path}`).join('\n') }
        }
      })

      editor.add({
        name: "worktree.disable",
        description: "Disable worktree isolation and clean up",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: true },
        execute: async () => {
          if (orchestrator.worktreeManager) {
            orchestrator.worktreeManager.cleanupAll()
            orchestrator.worktreeManager = null
          }
          return { content: "Worktree isolation disabled." }
        }
      })

      editor.add({
        name: "sessions",
        description: "List all active Nexus agent sessions",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: true },
        execute: async () => {
          const agents = orchestrator.getState().agents
          if (agents.length === 0) return { content: "No active agent sessions." }
          const lines = agents.map((a: any) => {
            const statusIcon = a.status === 'working' ? '🔄' : a.status === 'idle' ? '⏸️' : a.status === 'completed' ? '✅' : '❌'
            return `${statusIcon} ${a.name} (${a.role}) — Session: ${a.sessionID}`
          })
          return { content: `Active Sessions (${agents.length}):\n${lines.join('\n')}` }
        }
      })

      editor.add({
        name: "background",
        description: "Move running agents to background (detach from current session)",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: true },
        execute: async () => {
          // Nothing to do comes first: with no agents running, "No running
          // agents" is the truthful answer even on a build that lacks
          // `session.background`.
          const agents = orchestrator.getState().agents.filter((a: any) => a.status === 'working' || a.status === 'idle')
          if (agents.length === 0) return { content: "No running agents to move to background." }

          // `background` exists on the underlying client `SessionApi` but the
          // plugin context's `SessionDomain` is a `Pick` that omits it, so it
          // cannot be typed directly and is feature-detected through a narrow
          // structural lookup instead of assumed to be there.
          const background = (ctx.session as { background?: (input: { sessionID: string }) => Promise<void> }).background
          if (!background) {
            return { content: "This OpenCode version does not expose session.background on the plugin context — nothing was detached." }
          }

          let detached = 0
          for (const agent of agents) {
            if (!agent.sessionID) continue
            try {
              await background.call(ctx.session, { sessionID: agent.sessionID })
              detached++
            } catch {
              // Background may not be supported in all contexts
            }
          }
          return { content: `${detached} agent(s) moved to background. You can continue working while they run.` }
        }
      })

      editor.add({
        name: "result",
        description: "Get the result of a completed agent session",
        input: {
          type: "object",
          properties: {
            sessionID: { type: "string", description: "Session ID of the agent" }
          },
          required: ["sessionID"]
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { sessionID } = input as { sessionID: string }
          try {
            const messages = await ctx.session.context({ sessionID })
            const text = lastAssistantText(messages)
            if (text) {
              return { content: `Session ${sessionID} result:\n${text}` }
            }
            return { content: `Session ${sessionID} has no assistant messages yet.` }
          } catch (error: any) {
            return { content: `Failed to get result: ${error.message}` }
          }
        }
      })

      editor.add({
        name: "clarify",
        description: "Ask clarifying question before proceeding with ambiguous task",
        input: {
          type: "object",
          properties: {
            question: { type: "string", description: "The clarifying question to ask" },
            options: { type: "string", description: "Comma-separated options to present" },
            assumption: { type: "string", description: "Default assumption if no response" }
          },
          required: ["question"],
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { question, options, assumption } = input as { question: string; options?: string; assumption?: string }
          const optionList = options ? options.split(',').map(o => o.trim()) : []
          let response = `❓ ${question}`
          if (optionList.length > 0) {
            response += `\nOptions: ${optionList.map((o, i) => `${i+1}. ${o}`).join(', ')}`
          }
          if (assumption) {
            response += `\n💡 Default: ${assumption}`
          }
          return { content: response }
        }
      })

      // === Todo Enforcer Tools ===

      editor.add({
        name: "todo.add",
        description: "Add a todo item to track work",
        input: {
          type: "object",
          properties: {
            description: { type: "string", description: "Todo description" },
            assignedTo: { type: "string", description: "Agent or role to assign (optional)" }
          },
          required: ["description"],
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { description, assignedTo } = input as { description: string; assignedTo?: string }
          const item = orchestrator.todoEnforcer.add(description, assignedTo)
          return { content: `📝 Todo added: ${item.id}: ${item.description} (${item.status})` }
        }
      })

      editor.add({
        name: "todo.list",
        description: "List all todo items",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async () => {
          return { content: orchestrator.todoEnforcer.formatAll() }
        }
      })

      editor.add({
        name: "todo.complete",
        description: "Mark a todo item as completed",
        input: {
          type: "object",
          properties: {
            id: { type: "string", description: "Todo item ID" }
          },
          required: ["id"],
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { id } = input as { id: string }
          const item = orchestrator.todoEnforcer.get(id)
          if (!item) return { content: `❌ Todo ${id} not found.` }
          orchestrator.todoEnforcer.complete(id)
          return { content: `✅ Todo completed: ${id}: ${item.description}` }
        }
      })

      editor.add({
        name: "todo.stats",
        description: "Get todo statistics",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async () => {
          const stats = orchestrator.todoEnforcer.getStats()
          return {
            content: `📊 Todo Statistics:\n  Total: ${stats.total}\n  ⏳ Pending: ${stats.pending}\n  🔄 In Progress: ${stats.inProgress}\n  ✅ Completed: ${stats.completed}\n  🚫 Blocked: ${stats.blocked}`
          }
        }
      })

      // === Goal Tracking Tools ===
      editor.add({
        name: "goal.set",
        description: "Set a new persistent objective",
        input: {
          type: "object",
          properties: {
            description: { type: "string", description: "Goal description" },
            autoContinue: { type: "boolean", description: "Auto-continue (default: true)" }
          },
          required: ["description"],
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { description, autoContinue } = input as { description: string; autoContinue?: boolean }
          const goal = goalManager.set(description, autoContinue ?? true)
          return { content: `🎯 Goal set: ${goal.description}` }
        }
      })

      editor.add({
        name: "goal.status",
        description: "Show current goal status",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: true },
        execute: async () => {
          const goal = goalManager.getActive()
          if (!goal) return { content: "No active goal. Use nexus.goal.set() to create one." }
          return { content: `🎯 ${goal.description}\nStatus: ${goal.status}\nTasks: ${goal.tasks.length}` }
        }
      })

      editor.add({
        name: "goal.complete",
        description: "Complete current goal",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: true },
        execute: async () => {
          const goal = goalManager.getActive()
          if (!goal) return { content: "No active goal." }
          goalManager.complete(goal.id)
          return { content: `✅ Goal completed: ${goal.description}` }
        }
      })

      editor.add({
        name: "goal.list",
        description: "List all goals",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: true },
        execute: async () => {
          const goals = goalManager.getAll()
          if (goals.length === 0) return { content: "No goals yet." }
          const lines = goals.map(g => `${g.status === 'active' ? '🎯' : '✅'} ${g.description}`)
          return { content: lines.join('\n') }
        }
      })

      editor.add({
        name: "goal.status",
        description: "Show current active goal status",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async () => {
          const active = goalManager.getActive()
          if (!active) return { content: "No active goal. Use nexus.goal.set() to set one." }
          return {
            content: [
              `🎯 Active Goal: ${active.description}`,
              `📋 ID: ${active.id}`,
              `🔄 Auto-continue: ${active.autoContinue ? 'enabled' : 'disabled'}`,
              `📊 Status: ${active.status}`,
              `📎 Tasks: ${active.tasks.length > 0 ? active.tasks.join(', ') : 'none yet'}`,
              `📅 Created: ${active.createdAt.toISOString()}`,
              `⏱️ Should continue: ${goalManager.shouldContinue() ? 'yes' : 'no'}`
            ].join('\n')
          }
        }
      })

      editor.add({
        name: "goal.complete",
        description: "Mark current active goal as completed",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async () => {
          const active = goalManager.getActive()
          if (!active) return { content: "No active goal to complete." }
          goalManager.complete(active.id)
          await ctx.storage.set("nexus-goal", JSON.parse(JSON.stringify(goalManager.getAll())))
          return {
            content: [
              `✅ Goal completed: ${active.description}`,
              `📋 ID: ${active.id}`,
              `📎 Tasks tracked: ${active.tasks.length}`
            ].join('\n')
          }
        }
      })

      editor.add({
        name: "goal.list",
        description: "List all goals",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async () => {
          const goals = goalManager.getAll()
          if (goals.length === 0) return { content: "No goals set yet. Use nexus.goal.set() to create one." }
          const lines = goals.map(g => {
            const icon = g.status === 'active' ? '🎯' : g.status === 'completed' ? '✅' : g.status === 'paused' ? '⏸️' : '❌'
            return `${icon} [${g.status}] ${g.description} (tasks: ${g.tasks.length})`
          })
          return { content: `Goals (${goals.length}):\n${lines.join('\n')}` }
        }
      })

      // Team management tools
      const teamManager = new TeamManager()
      const astGrep = new AstGrep()

    editor.add({
      name: "team.create",
      description: "Create a new team with a lead role",
      input: {
        type: "object",
        properties: {
          name: { type: "string", description: "Team name" },
          leadRole: { type: "string", description: "Role of the team lead" }
        },
        required: ["name", "leadRole"],
        additionalProperties: false
      },
      options: { codemode: true },
      execute: async (input: unknown) => {
        const { name, leadRole } = input as { name: string; leadRole: string }
        const team = teamManager.create(name, leadRole)
        return { content: `Team '${team.name}' created with ID: ${team.id}\nLead: ${leadRole}\nStatus: ${team.status}\n\nAdd members with nexus.team.addMember(teamId="${team.id}", role="...")` }
      }
    })

    editor.add({
      name: "team.addMember",
      description: "Add a member to a team",
      // `model` is GONE, and it is a BREAKING schema change: it was `required`
      // and no longer exists. It was stored on the member and read by nothing
      // — `member.model` appeared in exactly one place in the repository, the
      // success echo below, which reported back the string the caller had just
      // supplied. See `TeamMember` in `src/team.ts` for why wiring it was not
      // the alternative.
      input: {
        type: "object",
        properties: {
          teamId: { type: "string", description: "Team ID" },
          role: { type: "string", description: "Role for this member" }
        },
        required: ["teamId", "role"],
        additionalProperties: false
      },
      options: { codemode: true },
      execute: async (input: unknown) => {
        const { teamId, role } = input as { teamId: string; role: string }
        const member = teamManager.addMember(teamId, role)
        if (!member) {
          return { content: `Team ${teamId} not found.` }
        }
        const team = teamManager.get(teamId)
        return { content: `Member added to team '${team?.name}':\nID: ${member.id}\nRole: ${member.role}\nStatus: ${member.status}\n\nTotal members: ${team?.members.length || 0}` }
      }
    })

    editor.add({
      name: "team.status",
      description: "Show team status",
      input: {
        type: "object",
        properties: {
          teamId: { type: "string", description: "Team ID (optional, shows all if omitted)" }
        },
        additionalProperties: false
      },
      options: { codemode: true },
      execute: async (input: unknown) => {
        const { teamId } = input as { teamId?: string }
        
        if (teamId) {
          const team = teamManager.get(teamId)
          if (!team) {
            return { content: `Team ${teamId} not found.` }
          }
          // No `m.model`: the field is gone from `TeamMember` because nothing
          // ever read it. See the note on the interface in `src/team.ts`.
          const memberLines = team.members.map(m => `  - ${m.role}: ${m.status}`).join('\n')
          return { content: `Team: ${team.name} (${team.id})\nLead: ${team.lead}\nStatus: ${team.status}\nCreated: ${team.createdAt.toISOString()}\nMembers (${team.members.length}):\n${memberLines || '  No members yet'}` }
        }

        const teams = teamManager.getAll()
        if (teams.length === 0) {
          return { content: "No teams created yet." }
        }
        const lines = teams.map(t => `${t.status === 'active' ? '🟢' : t.status === 'completed' ? '✅' : '🔵'} ${t.name} (${t.id}) - Lead: ${t.lead} - Members: ${t.members.length}`)
        return { content: `Teams (${teams.length}):\n${lines.join('\n')}` }
      }
    })

    editor.add({
      name: "team.activate",
      description: "Activate a team to start execution",
      input: {
        type: "object",
        properties: {
          teamId: { type: "string", description: "Team ID" }
        },
        required: ["teamId"],
        additionalProperties: false
      },
      options: { codemode: true },
      execute: async (input: unknown) => {
        const { teamId } = input as { teamId: string }
        const team = teamManager.get(teamId)
        if (!team) {
          return { content: `Team ${teamId} not found.` }
        }
        if (team.members.length === 0) {
          return { content: `Team '${team.name}' has no members. Add members before activating.` }
        }
        teamManager.activate(teamId)
        return { content: `Team '${team.name}' activated!\n\nTeam is now ready for parallel execution with ${team.members.length} members:\n${team.members.map(m => `  - ${m.role}: ${m.status}`).join('\n')}` }
      }
    })

      // AST-Grep tools
      editor.add({
        name: "astgrep.search",
        description: "Search for AST patterns in codebase",
        input: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "AST pattern to search for" },
            language: { type: "string", description: "Programming language (typescript, python, etc.)" },
            directory: { type: "string", description: "Directory to search in" }
          },
          required: ["pattern", "language", "directory"],
          additionalProperties: false
        },
        options: { codemode: true },
        execute: async (input: unknown) => {
          const { pattern, language, directory } = input as { pattern: string; language: string; directory: string }
          const results = astGrep.search(pattern, language, directory)
          if (results.length === 0) return { content: `No matches found for "${pattern}" in ${language}` }
          const lines = results.map(r => `${r.file}:${r.line} — ${r.match}`)
          return { content: `Found ${results.length} matches:\n${lines.join('\n')}` }
        }
      })

      editor.add({
        name: "astgrep.status",
        description: "Check if ast-grep is installed",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: true },
        execute: async () => {
          const available = astGrep.isAvailable()
          return { content: available ? "✅ ast-grep is installed" : "❌ ast-grep is not installed. Install with: cargo install ast-grep" }
        }
      })
    })

    // Register session hook for /nexus commands
    //
    // CAN THIS HOOK SUPPRESS THE PROMPT? No. Checked against
    // `@opencode/plugin` 2.0.12: `Hooks<Spec>` types the callback as
    // `(input) => Promise<void> | void`, so there is no return channel, and
    // `SessionPrompt` — the spec entry for `"prompt"` — carries only
    // `sessionID`, `messageID`, `prompt`, `metadata?` and `delivery`. The two
    // hooks that CAN skip a model request, `compaction` and `title`, are the
    // two that have a `result?` field documented as "skip the model request";
    // `prompt` has no equivalent. So a `/nexus …` prompt still reaches the
    // model no matter what this hook does.
    //
    // Given that, the least confusing thing available is to REPLACE the text
    // with the command's actual result. The alternative leaves the model
    // holding a bare `/nexus dashboard 4747` with the answer in metadata it
    // has no reason to read, and the obvious thing to do with that is to try
    // to start a dashboard — which, for a command whose job is starting one,
    // means asking the agent to do the thing that just happened.
    await ctx.session.hook("prompt", (event) => {
      if (!event.prompt.text.startsWith("/nexus")) return

      let result: string
      try {
        result = orchestrator.handleCommand(event.prompt.text)
      } catch (error: unknown) {
        // A hook that throws takes the prompt down with it. `/nexus dashboard`
        // starts a server, and a bind failure is an ordinary outcome it
        // reports rather than throws — but nothing above it is a promise, so
        // the failure is turned into text here instead of being allowed to
        // escape into the session.
        const detail = error instanceof Error ? error.message : String(error)
        result = `The \`${event.prompt.text.trim()}\` command failed: ${detail}\nNothing was changed.`
      }

      // The result goes to the session as tool output context…
      event.metadata = { ...event.metadata, nexusResult: result }
      // …and as the prompt text, because that is the only part of this hook's
      // input the model actually reads. The original command is kept verbatim
      // in the metadata, so nothing about what was asked is lost.
      event.prompt.text = [
        `The user ran \`${event.prompt.text.trim()}\`. The Nexus plugin already handled it and the `,
        `result is below. Do not run the command again and do not try to start, stop or open `,
        `anything yourself — report the result above in one or two sentences.`,
        "",
        result,
      ].join("\n")
    })

    // Watch the two config files the config manager reads and reload on change.
    // Started here, immediately before the return, so the disposer returned
    // below is reachable from the first line of setup's tail. Anywhere earlier
    // and a rejection in one of the awaits between here and the return would
    // strand a live poll interval with no way to stop it.
    const stopConfigWatch = watchConfigFiles(ctx, orchestrator)

    return () => {
      stopConfigWatch()
      orchestrator.shutdown()
    }
  }
})

export { NexusOrchestrator } from "./orchestrator"
export { StateBroadcaster } from "./broadcast"
export { NexusConfigManager, DEFAULT_CONFIG, PRESETS } from "./config"
export type { NexusModelConfig, NexusFullConfig, NexusPreset } from "./config"
export { detectCycles } from "./dag"
export { MessageStore } from "./message-store"
export type { MessageStoreConfig } from "./message-store"
export { PersistentMemoryStore } from "./memory-store"
export type { MemoryStoreConfig } from "./memory-store"
export { MessageRouter } from "./fanout"
export type { FanOutRouter } from "./fanout"
export { HealthMonitor } from "./health"
export type { HealthCheck, HealthConfig } from "./health"
export { LearningModule } from "./learning"
export type { LearningEntry, PatternMatch } from "./learning"
export type { Agent, Task, DAG, ExecutionRequest, ExecutionResult } from "./types"
export { TEMPLATES, instantiateTemplate, listTemplates, getTemplate } from "./templates"
export type { TaskTemplate, TaskTemplateStep } from "./templates"
export { ModuleRegistry } from "./modules"
export type { NexusModule, ModuleContext, ModuleTool, ModuleHook } from "./modules"
export { SecurityScanner } from "./security"
export type { SecurityIssue, SecurityScanResult, SecurityConfig } from "./security"
export { PerformanceTracker } from "./performance"
export type { PerformanceEntry, PerformanceScore } from "./performance"
export { CustomRoleManager } from "./custom-roles"
export type { CustomRole, CustomRoleLoadReport } from "./custom-roles"
export { CostForecaster } from "./forecast"
export type { CostEstimate, ForecastResult } from "./forecast"
export { WorktreeManager } from "./worktree"
export type { AgentWorktree } from "./worktree"
export { TodoEnforcer } from "./todo"
export type { TodoItem } from "./todo"
export { GoalManager } from "./goal"
export type { Goal } from "./goal"
export { TeamManager } from "./team"
export type { Team, TeamMember } from "./team"
export { AstGrep } from "./astgrep"
export type { AstGrepPattern, AstGrepResult } from "./astgrep"
