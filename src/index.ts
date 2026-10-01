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
import { installNexusSkills, nexusSkillsDir, overwriteWarning } from "./skills-install"
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
import { fileURLToPath } from "node:url"
import type { CostProvenance } from "./types"
import type { PerformanceScore } from "./performance"
import type { SkillInstallResult } from "./skills-install"

/**
 * Report what the skills installer did, one line per outcome worth naming.
 *
 * The reporting home for this feature, and the ONLY one. `installNexusSkills`
 * used to print the overwrite warning itself while the `unavailable` case was
 * reported here from the returned results, so one feature had two output
 * sites: the prefix, the tone and the judgement about what is worth saying were
 * each maintained twice, and a test capturing `console.warn` around the
 * installer could not see half the feature. Both are now sibling arms of one
 * loop over one array, so they share the `[nexus] ` prefix and the moment.
 *
 * EXTRACTED as a function rather than left inline in `plugin.setup` because
 * that is what makes it testable at all. The loop is three lines inside a
 * closure that boots an orchestrator, so an inline version could only be
 * covered by booting the whole plugin; this way the message text, the
 * per-file-not-summary shape and the silence on `created`/`unchanged` are all
 * assertable directly against a real `SkillInstallResult[]`.
 *
 * Returns nothing and never throws: a failure to report a skill must not be a
 * second way for the install to fail. `console.warn` is not worth a guard here
 * — it does not throw — but the shape is the same best-effort one the
 * surrounding load code uses.
 */
export function reportSkillInstalls(results: readonly SkillInstallResult[]): void {
  for (const { name, path, action } of results) {
    // A skill that did not ship is the whole feature failing silently, and this
    // is the only in-process signal there is. Named and loud, because
    // `docs/COMPATIBILITY.md` claims skills are supported.
    if (action === 'unavailable') {
      console.warn(`[nexus] Skill ${name} is not present in the installed package; skipping ${path}`)
    } else if (action === 'updated') {
      // The sibling arm. A user's edit may have just been discarded and they
      // cannot act on it retroactively, so it is said out loud — but it is a
      // warning and not an error, because the write is the specified policy and
      // it succeeded. `created` and `unchanged` fall through silently: a first
      // install loses nothing, and `unchanged` is the steady state on nearly
      // every load, so warning there would fire almost every startup.
      console.warn(overwriteWarning(name, path))
    }
  }
}

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

/**
 * Bundled agent markdown, resolved relative to this module exactly as
 * `nexusSkillsDir()` resolves `skills/` — so a published package finds it at
 * `<pkg>/assets/agents`, and a source checkout finds it at the repo root. The
 * `'..'` is the same hop `dist/index.js` and `src/index.ts` both need.
 */
export function nexusAgentsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'agents')
}

/** The sub-agent roles written on setup, in the order they are installed. */
const NEXUS_SUBAGENT_FILES = [
  'nexus-architect.md',
  'nexus-coder.md',
  'nexus-designer.md',
  'nexus-documenter.md',
  'nexus-explorer.md',
  'nexus-reviewer.md',
  'nexus-tester.md',
] as const

/**
 * One bundled agent definition, by filename.
 *
 * THROWS on a missing asset rather than returning an empty string. The
 * installer writes whatever it is handed without validating it, so a missing
 * file would otherwise install a silently incomplete agent set — and the roles
 * that went missing are exactly the ones `spawnAgent`'s `agentTypeMap` still
 * maps, so the failure would surface much later as a wrong-agent spawn. Naming
 * the missing path at setup is the cheap way to say it instead.
 */
function readNexusAgent(name: string): string {
  const path = join(nexusAgentsDir(), name)
  if (!existsSync(path)) {
    throw new Error(`[nexus] missing bundled agent definition: ${path}`)
  }
  return readFileSync(path, 'utf-8')
}

/**
 * Every bundled sub-agent, keyed by filename.
 *
 * Eager, so a partial asset directory fails here — at setup, naming the file —
 * rather than after an agent has been spawned into the wrong role.
 */
function readNexusSubagents(): Record<string, string> {
  const agents: Record<string, string> = {}
  for (const name of NEXUS_SUBAGENT_FILES) {
    agents[name] = readNexusAgent(name)
  }
  return agents
}


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
      writeFileSync(orchestratorFile, readNexusAgent('nexus-orchestrator.md'), 'utf-8')

      // Create subagent files for Nexus roles — always update to latest version
      Object.assign(subagents, readNexusSubagents())
    } catch (error) {
      // Best-effort: an unwritable home must not stop the plugin loading. But
      // SILENTLY best-effort is what this used to be, and the two failures it
      // swallowed are not equally quiet.
      //
      // A WRITE failing leaves the agent files absent, which is visible — the
      // roles simply are not there. A READ failing means `readNexusSubagents`
      // threw the named missing path precisely so a broken publish would say
      // which file is absent, and that message used to die in this catch:
      // `subagents` stayed empty, the loop below installed zero role files, and
      // the failure surfaced much later as a wrong-agent spawn on
      // `nexus.spawn` — the exact late failure the throw exists to prevent.
      //
      // So the error is reported, not swallowed. One line, and it is the only
      // way that docstring's promise is kept.
      console.error('[nexus] could not install Nexus agent definitions:', error instanceof Error ? error.message : error)
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

    // Install the `nexus-*` design skills into `~/.config/opencode/skills/`.
    //
    // Same shape and same moment as the agent files above — on plugin load,
    // best-effort, never able to break startup — but a different destination and
    // a different trigger. These are compared by content and only written when
    // they differ, so a load that changes nothing leaves the files, and their
    // mtimes, alone. See `src/skills-install.ts` for why there is deliberately
    // no override mechanism here: OpenCode's own skill precedence already lets a
    // user's project `.opencode/skills` copy shadow this global one.
    try {
      reportSkillInstalls(installNexusSkills(nexusSkillsDir(), homedir()))
    } catch {
      // Best-effort, like every other file this plugin writes on load. The
      // skills are guidance; failing to install guidance must never be the
      // reason the orchestrator does not start.
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
        description: "Delegate one task to a Nexus sub-agent. By default it runs in the background and returns immediately with the session id plus the model and complexity chosen for it — collect the outcome later with nexus.result(sessionID). Pass wait:true to block until it finishes and get the result inline, or just use nexus.delegate for that. Prefer this over the built-in subagent/task tool when the work should be tracked by Nexus: it routes the role to its configured model, charges it against this run's cost budget, records it in the execution history, and links the child session to this one. Returns the agent name, task preview and session id, plus model and complexity info (non-wait) or the agent's full result (wait:true).",
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
          // Held OUTSIDE the try so the catch below can settle it. The agent is
          // in `orchestrator.agents` from the moment `spawnAgent` returns, and
          // this block marks it `working`; every exit that is not a deliberate
          // settle — a `session.wait` that rejects, a throw from any read, a
          // failing `storage.set` — used to leave it at `working` in
          // `getState().agents` for the rest of the process. A finished agent
          // that still claims to be working is a lie the page cannot see
          // through, so the failure path settles it rather than leaking it.
          let spawned: SpawnedAgent | null = null
          try {
            const agent = await spawnAndDeliver({ role, task, model }, toolCtx)
            spawned = agent

            agent.status = 'working'
            orchestrator.notifyStateChange()

            // If wait is requested, block until completion or timeout
            if (wait) {
              const waitTimeout = timeout || 120000
              const waitPromise = ctx.session.wait({ sessionID: agent.sessionID! })
              // A TIMEOUT and a REJECTED POLL arrive at the same `catch` and
              // mean opposite things, so they are tagged apart here rather than
              // conflated below. A timeout is our own deadline firing: the
              // session was never told to stop and may still be generating. A
              // rejection is `session.wait` itself dying — an aborted, evicted
              // or unknown session — and a dead poll is not a running session,
              // which is the distinction `executeTask` already draws when it
              // wraps the same call in a guard that cannot reject.
              const timeoutPromise = new Promise((_, reject) => {
                const expiry = new Error(`Timed out after ${waitTimeout}ms`)
                ;(expiry as Error & { nexusTimedOut?: boolean }).nexusTimedOut = true
                setTimeout(() => reject(expiry), waitTimeout)
              })

              try {
                await Promise.race([waitPromise, timeoutPromise])
              } catch (waitError: any) {
                // A TIMEOUT means the session may still be running, and
                // `working` is the honest status for it — left alone on
                // purpose. A REJECTED POLL means the wait itself died, and no
                // status here can be trusted to survive: this agent is not
                // working, and publishing it as though it were is the stuck-
                // `working` row from issue #100. What it settled AS depends on
                // whether the session produced anything, so the settle happens
                // at each exit below rather than here — one settle per outcome,
                // whichever is actually known.
                const pollDied = !(waitError as Error & { nexusTimedOut?: boolean })?.nexusTimedOut
                if (!pollDied) agent.status = 'working'
                orchestrator.notifyStateChange()

                // Try to get whatever results are available
                try {
                  const messages = await ctx.session.context({ sessionID: agent.sessionID! })
                  const partialText = lastAssistantText(messages)
                  if (partialText) {
                    if (pollDied) orchestrator.settleAgent(agent.id, 'completed')
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

                if (pollDied) orchestrator.settleAgent(agent.id, 'failed')
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

                orchestrator.settleAgent(agent.id, 'completed')
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
                orchestrator.settleAgent(agent.id, 'completed')
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
            //
            // `working` is left in place deliberately, and is the one case where
            // that is honest rather than a leak: this tool has NOT been told the
            // session finished, and a non-wait spawn has no waiter to hear it.
            // The caller is pointed at `nexus.result()`, which is the surface
            // that reports the outcome. Inventing a terminal status here would
            // be a worse lie than a running row.
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
            // The spawn itself never reached `spawned` on a spawn failure, and
            // there is then no agent in the map to settle. Once it HAS spawned,
            // this is a task that is over — by failure rather than by completion
            // — and leaving it at `working` is the bug this settles.
            if (spawned) orchestrator.settleAgent(spawned.id, 'failed')
            return { content: `Failed to spawn agent: ${error.message}` }
          }
        }
      })

      editor.add({
        name: "delegate",
        description: "Delegate one task to a Nexus sub-agent and BLOCK until it finishes, returning the agent's full output. This is exactly nexus.spawn with wait:true — the same role-to-model routing, cost budgeting, execution history and parent-session linking — so pick whichever reads better; use it when the result is a dependency of your next step, and nexus.spawn when it is not. Prefer both over the built-in subagent/task tool when the work should be tracked by Nexus. Returns the agent name, outcome (completed or timeout), session id, and the agent's full result text; on timeout the partial output is returned rather than discarded.",
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
          // See the `spawn` tool's own note: the agent is in the map and marked
          // `working` before anything below can throw, and this catch is the
          // exit that used to leave it there. `session.wait` REJECTING is the
          // ordinary way in here — an aborted or gone session rejects rather
          // than timing out — and that is not a session still working, so it
          // must not keep reporting one.
          let spawned: SpawnedAgent | null = null
          try {
            const agent = await spawnAndDeliver({ role, task, model }, toolCtx)
            spawned = agent

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

              // `timeout` leaves the agent `working` and it is right to: the
              // session was never told to stop and is still spending. Only a
              // completed wait is an outcome, and it settles like every other.
              if (outcome === 'completed') orchestrator.settleAgent(agent.id, 'completed')
              else agent.status = 'working'
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
              if (outcome === 'completed') orchestrator.settleAgent(agent.id, 'completed')
              else agent.status = 'working'
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
            // See the `spawn` tool's catch. A rejected `session.wait` lands here
            // and the agent is not working any more.
            if (spawned) orchestrator.settleAgent(spawned.id, 'failed')
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
