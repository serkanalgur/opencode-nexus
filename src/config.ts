// Configuration management for Nexus
// Supports project-level and global configuration with precedence

import type { BudgetConstraint, NexusConfig } from "./types"
import { MODEL_EFFORT_LADDER, isModelEffort, type ModelEffort } from "./model-ref"
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname, resolve } from "node:path"

export interface NexusModelConfig {
  architect?: string
  coder?: string
  reviewer?: string
  tester?: string
  explorer?: string
  documenter?: string
  /**
   * The design director's model, a NAMED field like the six above rather than
   * a bare index-signature key. The index signature would accept
   * `models: { desginer: "..." }` just as happily, so a misspelling is
   * invisible either way — but a named field is discoverable at the type and
   * in the editor, and `getRoles()` can be checked against these names.
   */
  designer?: string
  [key: string]: string | undefined
}

/**
 * The dashboard's on/off switch and where it listens.
 *
 * FILE-SETTABLE, unlike the orchestrator's own `NexusConfig.dashboard` block
 * (see `src/types.ts`): this level is one of the three the config manager
 * actually merges, so `dashboard: { "enabled": false }` in `nexus.jsonc`
 * reaches the one place that decides whether a server starts. It used to reach
 * nothing at all — a knob that read as a control and was inert, which is worse
 * than having no knob.
 */
export interface NexusDashboardConfig {
  /**
   * Whether the dashboard may be started at all.
   *
   * Honoured by `NexusOrchestrator.startDashboard()`, which refuses and says
   * so. Honoured by the TUI's `nexus.web` command, which then explains the
   * refusal instead of opening a browser at an address that will never answer.
   */
  enabled: boolean
  /** Default port. An explicit `dashboard.start` port still wins. */
  port: number
  /** Default bind address. `127.0.0.1` — the server has no auth story. */
  host: string
}

/**
 * Whether OS notifications may be sent at all.
 *
 * FILE-SETTABLE for the same reason `dashboard` is, and because it fixes the
 * same defect: the orchestrator used to hardcode `new NotificationManager(true)`,
 * so this block would have been a knob that read as a control and was inert.
 * There is only one field today, but the block is shaped to grow, and it is
 * merged field by field for that reason rather than by spread.
 */
export interface NexusNotificationsConfig {
  /**
   * Whether notifications are sent.
   *
   * Honoured at the single gate every notification flows through
   * (`NexusOrchestrator.sendNotification()`), so one switch covers the task
   * complete/failed sites and the budget sites alike.
   */
  enabled: boolean
}

/**
 * Whether the orchestrator steers agents into a conventional
 * branch/commit/PR path.
 *
 * FILE-SETTABLE, and merged field by field for the same reason `dashboard` is:
 * a level that sets only `enabled` must not blank out the three toggles
 * resolved beneath it. It was spread-merged once, and the result was a level
 * setting `gitFlow: { "enabled": false }` silently resetting the convention
 * toggles to their defaults — the dashboard block's lost-sibling bug reached by
 * a different route.
 *
 * EVERY KEY HERE IS READ. That is the design constraint, not an accident: a
 * knob that reads as a control and is inert is worse than no knob, and this
 * repository has shipped two of them (`dashboard.enabled` and
 * `notifications.enabled`, both dead until 2.7.0). Each of the four resolves
 * through the ONE gate in `src/git-flow.ts` (`resolveGitFlow`), and each is
 * spelled out in the generated agent markdown.
 */
export interface NexusGitFlowConfig {
  /**
   * Whether the convention applies at all.
   *
   * The bottom of the gate, and the only key that turns everything off. An
   * OFF per-repo decision still wins over a `true` here — the more specific
   * statement beats the more general one.
   */
  enabled: boolean
  /**
   * Whether commit subjects are held to Conventional Commits.
   *
   * Read twice: it decides whether the conventional-commit rule appears in the
   * generated agent markdown, and whether `nexus.git.check` validates subjects
   * at all. Turning it off does not make a non-conventional commit good; it
   * stops the layer from claiming it is bad.
   */
  conventionalCommits: boolean
  /**
   * Whether agents are told to work on a branch rather than on the default one.
   *
   * Read once, in the agent-markdown section. Also the reason the report says
   * "detached HEAD, so there is nothing to enforce" rather than failing: a
   * checkout that cannot hold a branch is not a rule violation, it is an
   * environment that has no place for the rule.
   */
  requireBranch: boolean
  /**
   * Whether agents are told to open a pull request rather than merge into the
   * branch they are on.
   *
   * Read once, in the agent-markdown section. The check does NOT enforce it:
   * whether a PR is open is not knowable from a local checkout, and the report
   * says so rather than guessing from the presence of a remote.
   */
  prBeforeMerge: boolean
}

/**
 * Whether the orchestrator picks a reasoning effort for each task from the
 * difficulty it already measured.
 *
 * REQUEST SHAPING, NOT PRICING, and the distinction is load-bearing rather than
 * a disclaimer. `ModelVariant` is `{ id, settings?, headers?, body? }` and
 * carries NO `cost` — `cost` lives on `Model.Info` — so a variant changes what
 * the model is asked to do, never what a token costs. Higher effort means MORE
 * reasoning tokens at the SAME per-token rate, and this repository already bills
 * reasoning tokens separately from output (`priceTokens`, which charges
 * `usage.output + usage.reasoning` against the output rate). There is
 * deliberately no variant axis on `ModelPricingTiers`, whose only axis is
 * context size: adding one would be a category error, because a rate is not a
 * function of how hard the model was asked to think.
 *
 * OFF BY DEFAULT. Not because the feature is doubtful but because it changes
 * which request a spawn makes, and a change nobody asked for should not arrive
 * in a release. With `enabled: false` no selection outcome differs in any way —
 * `test/effort-selection.test.ts` proves that differentially rather than
 * asserting it.
 *
 * FILE-SETTABLE, and merged field by field for the same reason `gitFlow` is: a
 * level that sets only `enabled` must not blank out the two numbers resolved
 * beneath it.
 *
 * EVERY KEY HERE IS READ, and each is read at the ONE gate in
 * `selectBestModel` — `enabled` decides whether the automatic choice is made at
 * all, `maxEffort` clamps it, `minDifficulty` skips tasks too easy to be worth
 * the tokens. Nothing else in `src/` reads this block.
 */
export interface NexusEffortConfig {
  /**
   * Whether an effort is chosen automatically.
   *
   * The bottom of the gate, and the only key that turns the feature on. `false`
   * is a TRUE no-op rather than a default that happens to match today's
   * behaviour: a model reference the user wrote with an explicit `#variant`
   * keeps it, and a variant-free one gets no suffix, exactly as before.
   */
  enabled: boolean
  /**
   * The highest effort any task may be asked for — a CEILING over the ladder
   * in `src/model-ref.ts`, and the cost policy of the whole feature.
   *
   * Defaults to `high`, which is the deliberate claim: the two hardest buckets
   * (`xhigh`, `max`) exist in the mapping and are NOT reachable at the default,
   * because an estimate of how hard a task is does not justify spending
   * several times the reasoning budget to answer it. Raising this is how a user
   * says their tasks are better judged than that; lowering it is how a user
   * says the opposite.
   *
   * A ceiling can only LOWER the mapping. Setting it above the level the
   * mapping reaches for a given task changes nothing, and that is what a
   * ceiling means — not a dead knob, but a one-directional one.
   *
   * It wins even when it is BELOW the mapping's floor. `effortForDifficulty`
   * never returns anything under `low`, so `maxEffort: 'minimal'` is a level
   * the mapping cannot produce; the ceiling is still applied, and the outcome is
   * whatever the model publishes at or below `minimal` — which is frequently
   * nothing, because most catalogues publish `low` as their lowest rung. That
   * is reported, with the ceiling and the published list, rather than silently
   * rounded UP to the floor: rounding up would spend more reasoning budget than
   * the ceiling permits, and a cost control that can be overridden by the thing
   * it controls is not a cost control.
   *
   * A name off the ladder (`"enormous"`) is rejected, not clamped: see
   * `validateEffortConfig`.
   */
  maxEffort: ModelEffort
  /**
   * The `overall` difficulty a task must REACH to be given an effort at all, on
   * `0-100`. Default `0`, which means "every task, however easy".
   *
   * THE RULE, as one sentence: a task is asked for the highest published level
   * at or below `min(effortForDifficulty(overall), maxEffort)`, and is asked for
   * nothing only when `overall < minDifficulty`. This key is the ONLY way that
   * happens — the difficulty table in `src/model-ref.ts` runs from `low`
   * upwards and has no bucket meaning "too easy to bother", precisely so that
   * one setting owns that decision and a user moving this one is not
   * contradicted by the table.
   *
   * Defaults to 0 DELIBERATELY, and that is now a statement rather than a
   * consequence of the table happening to absorb the easy end. `0` says "never
   * skip a task", which is the honest reading of a feature that is itself off by
   * default: the user who sets `enabled: true` asked for effort on their work,
   * and a nonzero default would quietly withhold it on routine tasks — a policy
   * nobody asked for, chosen by a release rather than by a user. The cost of
   * `0` is real and is the price of that: with the default, the floor bucket
   * `low` applies to every task, including a one-line fix. A user who wants
   * less sets this number, and every value of it changes the outcome of at least
   * one score — the test that says so is in `test/effort-selection.test.ts`, and
   * it is there because at the old default this key did nothing at all.
   *
   * Out-of-range and non-finite values are CLAMPED to `0-100` rather than
   * rejected, because a threshold outside the score's own range is a harmless
   * over-reach that still has one honest reading ("always" / "never"), and
   * failing a config load over it would be the harsher mistake.
   */
  minDifficulty: number
}

/**
 * Resolve `maxEffort` down the merge levels, warning about each bad spelling.
 *
 * Walks the same precedence `getConfig()` does and takes the first level that
 * names a real rung, so an invalid project value falls THROUGH to the global
 * one rather than to the default — which is the honest reading, since the
 * level that said something is the level that said something wrong, and the
 * level beneath it is the user's actual preference.
 *
 * The fallback is `DEFAULT_CONFIG.effort.maxEffort` rather than a throw,
 * because a `nexus.jsonc` is hand-written JSONC and `"maxEffort": "highh"` is a
 * typo, not an attack. Failing the config load over one misspelled key would be
 * the harsher mistake, and silently disabling the feature would be worse than
 * either — so a misspelling degrades to the documented default and SAYS SO.
 * Every bad spelling is reported, not just the first, so fixing it is one pass.
 */
function resolveMaxEffort(...levels: readonly (ModelEffort | undefined)[]): ModelEffort {
  for (const level of levels) {
    if (level === undefined) continue
    if (isModelEffort(level)) return level
    console.warn(
      `[nexus] effort.maxEffort ${JSON.stringify(level)} is not a reasoning effort level; skipping it. ` +
      `Valid levels: ${MODEL_EFFORT_LADDER.join(', ')}.`
    )
  }
  return DEFAULT_CONFIG.effort.maxEffort
}

/**
 * Clamp a configured `minDifficulty` into the `0-100` range `overall` lives in.
 *
 * A NON-FINITE value becomes `0` ("no minimum") rather than propagating: `NaN`
 * in a `>=` comparison is always false, so a `NaN` threshold would silently
 * mean "skip EVERY task" — effort selection would do nothing and the reason
 * would be invisible. `0` fails toward doing the thing the user enabled.
 */
function clampDifficulty(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

/**
 * One entry of the `customRoles` block, as authored in `nexus.jsonc`.
 *
 * This is the SHAPE A WELL-FORMED ENTRY HAS, not a promise that the file
 * contains well-formed entries: the value arrives from `JSON.parse`, so it is
 * validated where it is used (`CustomRoleManager.loadFromConfig`) and a
 * malformed entry is reported and skipped rather than registered.
 *
 * `name` and `prompt` are the two required fields and are both load-bearing —
 * the name is the lookup key a spawn resolves, and the prompt is the system
 * prompt `buildRolePrompt` hands the agent (an empty one would fall through to
 * a generic "You are a <role>" sentence, so a promptless role is a role that
 * looks configured and behaves as if it were not). `displayName` and `emoji`
 * are presentation and default to the name and to `🤖`.
 *
 * `model` is the role's default model. It is NOT what a spawn runs: model
 * selection is the ranker's, and this is the first CANDIDATE for the role
 * (see `getModelForRole`). Writing the same string under `models` instead has
 * exactly the same effect and is the older, equivalent spelling.
 */
export interface NexusCustomRoleConfig {
  name: string
  prompt: string
  displayName?: string
  emoji?: string
  model?: string
}

export interface NexusFullConfig {
  models: NexusModelConfig
  budget: {
    maxTotalCost: number
    maxCostPerTask: number
    alertThreshold: number
  }
  /**
   * `retryDelay` is here, and in `NexusConfig.selfHealing`, and was in NEITHER
   * sense optional before. The escalation policy is built from
   * `selfHealing.retryDelay` in the orchestrator's constructor
   * (`retryDelay: this.config.selfHealing.retryDelay`), so a user editing
   * `selfHealing` in `nexus.jsonc` had a live setting they could not express
   * and no way to learn it existed — the file shape listed three fields and the
   * behaviour depended on a fourth.
   *
   * It is listed here so the two shapes agree. `getSaveableConfig()` writes
   * this block out in full (see the note there), so a user's `retryDelay`
   * survives a TUI model save rather than being replaced by the default.
   */
  selfHealing: {
    enabled: boolean
    maxRetries: number
    retryDelay: number
    contextTransfer: boolean
  }
  dashboard: NexusDashboardConfig
  notifications: NexusNotificationsConfig
  gitFlow: NexusGitFlowConfig
  /**
   * Effort selection, the eighth block.
   *
   * Listed here and in `getSaveableConfig()` for the same reason as the other
   * seven, and the omission is the same loss: `saveProjectConfig` writes
   * `getSaveableConfig()`'s return value as the ENTIRE file body, so a block
   * missing from it is a block deleted from the user's `nexus.jsonc` the first
   * time they change a model in the TUI.
   *
   * DELIBERATELY ABSENT from `updateStorageConfig()`'s literal, unlike
   * `selfHealing`. That method REPLACES three blocks with fresh literals, and
   * `getConfig()` merges storage LAST, so a key written there shadows the
   * project and global files even when the value written is the default — the
   * `retryDelay` bug. `storageConfig` is a `Partial`, so omitting the block is
   * the correct fix rather than a type workaround, and the omission is what
   * makes a call that set only `models` harmless.
   */
  effort: NexusEffortConfig
  customRoles: NexusCustomRoleConfig[]
  /**
   * The durable note store, the ninth block.
   *
   * This block used to live on the wider embedder type `NexusConfig` and was
   * REMOVED from it, correctly: nothing read any of it. `enabled` gated
   * nothing, `maxEntriesPerScope` was written into a defaults literal and read
   * by no consumer, and a knob a user can set with no effect is worse than no
   * knob — see `src/types.ts:465` for the full reasoning. It is listed here
   * now because that is no longer true: `recallForTask` is called
   * unconditionally at both injection points (`orchestrator.ts:2512` in
   * `executeTask`, `orchestrator.ts:3742` in `spawnAgent`), so memory is
   * unconditionally ON and the knob below is the first honest way to turn it
   * off. It returns on the FILE-settable type rather than the embedder type
   * because every field here has a consumer, which is what the removed block
   * did not.
   *
   * Field by field, and named against its consumer:
   * - `enabled` — the gate at the TOP of `recallForTask`
   *   (`orchestrator.ts:4801`). `true` by default, and `true` is what is
   *   already happening, so the default is behaviour-preserving.
   * - `storage` — the sqlite file path, `MemoryStoreConfig.dbPath`, resolved
   *   at USE time through the resolver the orchestrator passes to
   *   `new PersistentMemoryStore(...)` (`orchestrator.ts`). A change of path
   *   closes the open database and opens the new one on the next call, so it
   *   needs no restart — see `database` in `src/memory-store.ts`.
   * - `maxEntries` — `MemoryStoreConfig.maxEntries`, the per-scope FIFO cap
   *   enforced by `evictOverflow` in `src/memory-store.ts` and re-read on every
   *   write. The `project` scope is exempt from it BY DESIGN (a human's durable
   *   notes must not be evicted by disposable entries), and that exemption is
   *   not to be "fixed" here.
   *
   * There is deliberately NO `inject` field — considered and rejected. A second
   * boolean that turns the prompt block on while leaving retrieval running would
   * be a half-differentiated switch whose two states a user cannot tell apart
   * after the fact, which is the SAME failure the block removed from
   * `NexusConfig` was: a knob that changes nothing observable. `enabled` is
   * the only knob, and it is wired to a real early return.
   */
  memory: {
    enabled: boolean
    storage: string
    maxEntries: number
  }
}

/**
 * Strip single-line and multi-line comments from a JSONC string.
 * Handles strings properly — comments inside quoted strings are preserved.
 */
function stripJsonComments(jsonc: string): string {
  const result: string[] = []
  let i = 0
  const len = jsonc.length

  while (i < len) {
    const ch = jsonc[i]

    // Inside a double-quoted string — copy verbatim (handle escapes)
    if (ch === '"') {
      result.push(ch)
      i++
      while (i < len && jsonc[i] !== '"') {
        if (jsonc[i] === '\\') {
          result.push(jsonc[i], jsonc[i + 1] ?? '')
          i += 2
        } else {
          result.push(jsonc[i])
          i++
        }
      }
      if (i < len) {
        result.push(jsonc[i]) // closing quote
        i++
      }
      continue
    }

    // Single-line comment
    if (ch === '/' && jsonc[i + 1] === '/') {
      // Skip until end of line
      while (i < len && jsonc[i] !== '\n') i++
      continue
    }

    // Multi-line comment
    if (ch === '/' && jsonc[i + 1] === '*') {
      i += 2
      while (i < len && !(jsonc[i] === '*' && jsonc[i + 1] === '/')) i++
      i += 2 // skip */
      continue
    }

    result.push(ch)
    i++
  }

  return result.join('')
}

/**
 * Outcome of consulting one config file.
 *
 * `existed` and `parsed` are kept apart on purpose: "there is no project
 * config" and "there is a project config but it is broken" are different
 * problems, and conflating them is what made a missing project file
 * indistinguishable from a normal load in the field.
 */
export interface NexusConfigFileInfo {
  /**
   * Path that was consulted, with the home directory collapsed to `~`. Safe to
   * log and to hand to a model — an absolute home path leaks the OS account
   * name into CI output and pasted bug reports. Anything that genuinely needs
   * the absolute path builds it with `nexusProjectConfigPath` /
   * `nexusGlobalConfigPath`.
   */
  path: string
  /** Whether a readable file was present where the config path points. */
  existed: boolean
  /** Whether the file parsed into a usable config object. */
  parsed: boolean
}

/**
 * What caused a config load.
 *
 * `initial` is the load at orchestrator startup; `event` and `poll` are the two
 * reload triggers. Recorded on every load so a stale model can be traced to the
 * mechanism that should have refreshed it — notably, `poll` on every reload
 * means the host is not delivering `filesystem.changed` for these files.
 */
export type NexusConfigReloadTrigger = 'initial' | 'event' | 'poll'

/** Everything a single config load consulted, and what it resolved to. */
export interface NexusConfigLoadInfo {
  project: NexusConfigFileInfo
  global: NexusConfigFileInfo
  /**
   * Resolved `role -> model` map after defaults -> global -> project -> storage.
   * When `sessionOverride` is true this includes an in-process override, so the
   * map is NOT a statement about what is on disk.
   */
  models: Record<string, string>
  /**
   * True when a session-scoped override (the `preset` tool, TUI settings) is
   * layered on top of the disk config. Reported alongside `models` so a
   * disk-only reading of that map is never presented as the whole story.
   */
  sessionOverride: boolean
  /** ISO timestamp of this load. */
  loadedAt: string
  /** 1 for the initial load, >1 for reloads. */
  loadCount: number
  /** Which mechanism caused this load. */
  trigger: NexusConfigReloadTrigger
}

/** The two config files a load consulted. */
interface NexusConfigLoadSources {
  project: NexusConfigFileInfo
  global: NexusConfigFileInfo
}

/** Result of trying to read and parse one JSONC file from disk. */
interface JsoncReadResult {
  config: Partial<NexusFullConfig> | null
  existed: boolean
}

/**
 * Try to read and parse a JSONC file from disk. `config` is null on any error;
 * `existed` reports whether a readable file was there at all.
 */
function readJsoncFile(filePath: string): JsoncReadResult {
  try {
    const raw = readFileSync(filePath, 'utf-8')
    const stripped = stripJsonComments(raw)
    const parsed: unknown = JSON.parse(stripped)
    // `JSON.parse` accepts `42`, `"oops"` and `[]`. Those parse fine and then
    // contribute nothing, so accepting them would log `[loaded]` for a file
    // that is in fact doing nothing — a false assurance in exactly the case
    // this reporting exists to catch.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn(`[nexus] Ignoring config from ${filePath}: expected a JSON object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`)
      return { config: null, existed: true }
    }
    reportUndeclaredKeys(parsed as Record<string, unknown>, filePath)
    return { config: parsed as Partial<NexusFullConfig>, existed: true }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    const message = err instanceof Error ? err.message : String(err)
    // ENOENT and ENOTDIR both mean "there is no config file here": the path is
    // missing, or a parent component is a regular file. Everything else
    // (EACCES on a real config, EISDIR, a syntax error) means a file IS there
    // and we simply could not use it, which must keep reporting existed=true.
    const absent = code === 'ENOENT' || code === 'ENOTDIR'
    if (!absent) {
      console.warn(`[nexus] Failed to load config from ${filePath}: ${message}`)
    }
    return { config: null, existed: !absent }
  }
}

/**
 * Name every key in a parsed config file that `NexusFullConfig` does not
 * declare, once per file, on one line.
 *
 * ── WHY THIS IS NEEDED AT ALL ──
 *
 * `getConfig()` builds each closed block FIELD BY FIELD, so a key the schema
 * dropped does not survive the merge: `{ "budget": { "maxCostPerAgent": 2 } }`
 * contributes nothing. That is the correct behaviour — a key no code reads
 * should not be a value Nexus carries — but it is silent, and the consequence
 * lands later and elsewhere: `getSaveableConfig()` writes `getConfig()` as the
 * user's WHOLE file, so the next TUI save deletes the key from their
 * `nexus.jsonc` with nothing said at any point.
 *
 * A setting that vanishes on save is the same defect class as a setting that
 * was never read, approached from the other side, and the fix for both is to
 * say so. The config panel cannot do it: by the time a panel exists the key is
 * already gone from the merged object, so there is no row to disable and no row
 * to explain. Reporting at the LOAD is the only point where the key is still
 * visible and still attributable to a file.
 *
 * ── WHY IT IS A WARNING AND NOT AN ERROR ──
 *
 * Same reasoning as `resolveMaxEffort`: a `nexus.jsonc` is hand-written JSONC
 * and an unknown key is a leftover from an older Nexus, not an attack. Refusing
 * to load the file over it would be the harsher mistake, and the file's other
 * keys are perfectly good. Every undeclared key is named, not just the first, so
 * upgrading is one pass.
 *
 * ── WHAT IS NOT REPORTED ──
 *
 * `models` and `customRoles`, because their key sets are the user's to invent (a
 * role name, a custom role) — see `OPEN_KEYED_BLOCKS`. An unknown key INSIDE one
 * of those is not reported either, for the same reason: inside a `customRoles`
 * entry, `displayName` is declared but a user's own extra field is theirs, and
 * Nexus passes entries through rather than filtering them.
 */
function reportUndeclaredKeys(parsed: Record<string, unknown>, filePath: string): void {
  const declared = declaredConfigLeaves()
  const undeclared: string[] = []

  for (const [block, value] of Object.entries(parsed)) {
    const keys = declared.get(block)
    // `null` is an open block — nothing to check against, and nothing to report.
    if (keys === null) continue
    // `undefined` is a block Nexus has no idea about, reported by name rather
    // than key by key: the fix is to delete the block, and naming its four
    // contents separately would read as four separate problems.
    if (keys === undefined) {
      undeclared.push(`${block} (whole block)`)
      continue
    }
    if (!isPlainRecord(value)) continue
    for (const key of Object.keys(value)) {
      if (!keys.includes(key)) undeclared.push(`${block}.${key}`)
    }
  }

  if (undeclared.length === 0) return
  console.warn(
    `[nexus] ${redactHome(filePath)} has ${undeclared.length} key(s) Nexus does not read: ` +
    `${undeclared.join(', ')}. They are ignored, and the next save from the config dialogs will ` +
    'remove them from the file.'
  )
}

/** Absolute path of the project-level config: `{basePath}/.opencode/nexus.jsonc`. */
export function nexusProjectConfigPath(basePath: string): string {
  return resolve(join(basePath, '.opencode', 'nexus.jsonc'))
}

/** Absolute path of the global-level config: `~/.config/opencode/nexus.jsonc`. */
export function nexusGlobalConfigPath(): string {
  return resolve(join(homedir(), '.config', 'opencode', 'nexus.jsonc'))
}

/**
 * Collapse a leading home directory to `~`. The global config path is fully
 * derivable from `~`, so spelling out `/Users/<name>/...` in a log line or in
 * the status payload buys no diagnosis and costs the user's account name.
 */
function redactHome(filePath: string): string {
  const home = homedir()
  if (filePath === home) return '~'
  const prefix = home.endsWith('/') ? home : `${home}/`
  return filePath.startsWith(prefix) ? `~${filePath.slice(home.length)}` : filePath
}

/** Compact per-file state for the one-line load log. */
function describeFile(file: NexusConfigFileInfo): string {
  if (file.parsed) return 'loaded'
  if (file.existed) return 'unparseable'
  return 'absent'
}

/**
 * One-line summary of a load: which paths were consulted, which existed, and
 * the role -> model map they resolved to. Printed on every load and reload.
 */
export function formatConfigLoadLog(info: NexusConfigLoadInfo): string {
  const models = Object.entries(info.models)
    .map(([role, model]) => `${role}=${model}`)
    .join(' ')
  // A preset replaces the whole `models` level, so while one is set the models
  // above are NOT the disk file. Say so explicitly, and say how to get control
  // back — a user who edits the file and watches nothing change needs that.
  // Name the in-band way first (`preset` with mode 'clear'), since that is
  // the one an agent can act on without the user leaving the session.
  const override = info.sessionOverride
    ? ' (+session override: storage; disk edits to models are IGNORED while a preset is set — call the preset tool with mode "clear", or reset in the TUI, to hand control back to disk)'
    : ''
  return `[nexus] config loaded (#${info.loadCount} trigger=${info.trigger} at=${info.loadedAt}) `
    + `project=${info.project.path} [${describeFile(info.project)}] `
    + `global=${info.global.path} [${describeFile(info.global)}] `
    + `models:${override} ${models}`
}

const DEFAULT_CONFIG: NexusFullConfig = {
  models: {
    architect: "anthropic/claude-sonnet-4-6",
    coder: "anthropic/claude-sonnet-4-6",
    reviewer: "openai/gpt-5-mini",
    tester: "anthropic/claude-haiku-4-5",
    explorer: "google/gemini-2.5-flash",
    documenter: "anthropic/claude-haiku-4-5",
    // A DEFAULT, not an omission. The unset-fallback chain in
    // `getModelForRole` ends at `config.models.coder`, so a `designer` key
    // absent from here would put every design director on the coder's model —
    // a different model's judgement, at coder prices, with nothing logged.
    // A design director decides and does not implement, which is the architect's
    // job description, so it takes the architect's model here for the same
    // reason the architect does.
    designer: "anthropic/claude-sonnet-4-6"
  },
  budget: {
    maxTotalCost: 10.00,
    maxCostPerTask: 1.00,
    alertThreshold: 0.2
  },
  selfHealing: {
    enabled: true,
    maxRetries: 3,
    retryDelay: 1000,
    contextTransfer: true
  },
  // Kept identical to the orchestrator's own `NexusConfig.dashboard` defaults so
  // the two agree when neither a config file nor a constructor says otherwise.
  dashboard: {
    enabled: true,
    port: 4747,
    host: "127.0.0.1"
  },
  // Kept aligned with the orchestrator's own `NexusConfig.notifications`
  // default so the two agree when neither a config file nor a constructor
  // says otherwise.
  notifications: {
    enabled: true
  },
  // On by default, for the reason spelled out at the one gate in
  // `src/git-flow.ts`: the convention validates rather than blocks, and nothing
  // in that file writes to git. Kept identical to the orchestrator's own
  // `NexusConfig.gitFlow` defaults so the two agree when neither a config file
  // nor a constructor says otherwise.
  gitFlow: {
    enabled: true,
    conventionalCommits: true,
    requireBranch: true,
    prBeforeMerge: true
  },
  // Off by default, which is the DEFAULT worth having: the block changes the
  // request a spawn makes, and `maxEffort: 'high'` is already a considered
  // ceiling rather than the top of the ladder. See `NexusEffortConfig`.
  effort: {
    enabled: false,
    maxEffort: 'high',
    minDifficulty: 0
  },
  // Empty rather than absent: a user with no custom roles is the default, and
  // an empty list is what every merge level falls through to, so "no
  // `customRoles` block anywhere" and "an empty one" resolve the same way.
  customRoles: [],
  // On by default, and the default is what is ALREADY happening: `recallForTask`
  // is called unconditionally at `orchestrator.ts:2512` and `~:3742`, so `false`
  // would be a behaviour change and `true` is merely the first honest way to
  // say it. This is the deliberate difference from the `memory` block that was
  // removed from `NexusConfig` — there, `enabled` gated nothing.
  memory: {
    enabled: true,
    // MUST mirror `MemoryStoreConfig.DEFAULT_CONFIG.dbPath`
    // (`src/memory-store.ts`) exactly, expression and all. The two literals are
    // the same value by CONSTRUCTION, not by a "change both" convention resting
    // on review: the orchestrator constructs the store with a RESOLVER over
    // `configManager.getConfig().memory` (`orchestrator.ts`, `new
    // PersistentMemoryStore(() => …)`), so this is the value the store opens and
    // the store's own default only applies when a caller passes no config at
    // all. `test/config-knobs.test.ts` asserts the two agree, so a one-sided
    // change fails the suite rather than shipping a path the config does not
    // name.
    //
    // The resolution is LIVE: editing this takes effect on the next store call,
    // with no restart. See `database` in `src/memory-store.ts`.
    storage: join(process.env.HOME || '~', '.local', 'share', 'opencode-nexus', 'memory.db'),
    // Mirrors `MemoryStoreConfig.DEFAULT_CONFIG.maxEntries`
    // (`src/memory-store.ts`), which is a PER-SCOPE cap: `project` is exempt
    // by design, so a smaller number here still never evicts a durable note.
    // Also live — re-read on every `set`, no reopen involved.
    maxEntries: 1000
  }
}

/**
 * The keys each CLOSED config block declares, as `Object.keys` of the
 * corresponding `DEFAULT_CONFIG` block.
 *
 * ── WHY `DEFAULT_CONFIG` IS THE AUTHORITY ──
 *
 * It is declared `const DEFAULT_CONFIG: NexusFullConfig`, so TypeScript
 * requires it to state every required key of every block: it cannot silently
 * omit `retryDelay`, and it cannot carry a key `NexusFullConfig` does not
 * declare. That makes it the one place in this repository where "the keys the
 * TYPE names" is available at RUNTIME, which is what a config panel needs and
 * what a type cannot give it. `test/config-knobs.test.ts` guards the mapping
 * against the interfaces themselves, so the two cannot drift.
 *
 * ── WHY A MAP AND NOT A SET ──
 *
 * `PanelRow.label` is not unique and a key name is not an address — five blocks
 * each have an `enabled`. The map is keyed by BLOCK for that reason, and the
 * caller walks a row's path segment by segment rather than matching a flat set.
 *
 * ── THE `null` BLOCKS ──
 *
 * `models` and `customRoles` are OPEN by design: a role is a key a user invents
 * and a custom role is an entry a user invents, so there is no closed key set
 * to intersect against and `null` says "no filtering applies here". Treating them
 * as closed would make every real value in them look stale, which is the failure
 * this function exists to prevent, pointed the other way.
 */
export function declaredConfigLeaves(): ReadonlyMap<string, readonly string[] | null> {
  const leaves = new Map<string, readonly string[] | null>()
  for (const [block, value] of Object.entries(DEFAULT_CONFIG)) {
    if (OPEN_KEYED_BLOCKS.has(block) || !isPlainRecord(value)) {
      leaves.set(block, null)
      continue
    }
    leaves.set(block, Object.keys(value).sort())
  }
  return leaves
}

/**
 * Blocks whose key set is the user's to invent, so no closed set applies.
 *
 * Listed rather than inferred from the value, because inference cannot tell an
 * open map from a closed one: `models` is a plain object whose keys are role
 * names, and structurally identical to a block with a fixed key list.
 */
const OPEN_KEYED_BLOCKS: ReadonlySet<string> = new Set(['models', 'customRoles'])

/** A non-null, non-array object — the only shape whose keys are a key set. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class NexusConfigManager {
  private projectConfig: Partial<NexusFullConfig> | null = null
  private globalConfig: Partial<NexusFullConfig> | null = null
  /**
   * The session-scoped override level.
   *
   * `Partial` because `updateStorageConfig()` genuinely builds a partial — it
   * fills in the three blocks a TUI dialog can edit and leaves the rest
   * absent — and the type used to claim otherwise. That claim is load-bearing
   * now: `getConfig()` reads `storageConfig?.dashboard.enabled`, which is a
   * TypeError on a non-null `storageConfig` with no `dashboard` key.
   */
  private storageConfig: Partial<NexusFullConfig> | null = null
  private loadInfo: NexusConfigLoadInfo | null = null
  /**
   * Programmatic starting point for the `dashboard` block, beneath the file
   * levels and above `DEFAULT_CONFIG`.
   *
   * Exists so `NexusConfig.dashboard` has exactly ONE consumer. The
   * orchestrator seeds it from its own constructor config, and everything else
   * — the start gate, the TUI command, the port and host defaults — reads the
   * merged result from `getConfig()`. Without it the same setting would be
   * readable from two places with no defined precedence between them, which is
   * how `enabled` ended up readable from neither.
   */
  private dashboardBase: NexusDashboardConfig
  /**
   * Programmatic starting point for the `notifications` block, beneath the
   * file levels and above `DEFAULT_CONFIG`. Same single-consumer rationale as
   * `dashboardBase`.
   */
  private notificationsBase: NexusNotificationsConfig
  /**
   * Programmatic starting point for the `gitFlow` block, beneath the file
   * levels and above `DEFAULT_CONFIG`. Same single-consumer rationale as
   * `dashboardBase`: the orchestrator seeds it from its own constructor config
   * and every consumer reads the merged result, so the setting is readable from
   * one place with a defined precedence rather than two without one.
   */
  private gitFlowBase: NexusGitFlowConfig
  /**
   * Programmatic starting point for the `effort` block, beneath the file
   * levels and above `DEFAULT_CONFIG`. Same single-consumer rationale as
   * `gitFlowBase`: the orchestrator seeds it from its own constructor config and
   * every consumer reads the merged result.
   */
  private effortBase: NexusEffortConfig
  /**
   * Programmatic starting point for the `customRoles` block, beneath the file
   * levels and above `DEFAULT_CONFIG`. Same single-consumer rationale as
   * `dashboardBase`.
   *
   * Copied rather than held by reference: the orchestrator passes the array
   * straight out of its own merged constructor config, and a caller mutating
   * that array afterwards would otherwise retroactively change what a later
   * config load resolves.
   */
  private customRolesBase: NexusCustomRoleConfig[]
  /**
   * Programmatic starting point for the `budget` block, beneath the file levels
   * and above `DEFAULT_CONFIG`. Same single-consumer rationale as
   * `dashboardBase`.
   *
   * `Partial<BudgetConstraint>` rather than `NexusFullConfig['budget']` because
   * the two shapes are deliberately not the same: `hardLimit` is on
   * `BudgetConstraint` and is NOT on `NexusFullConfig.budget`. Accepting the
   * wider type lets an embedder seed a hard limit without the manager pretending
   * the FILE can express one — `getConfig()` returns the three-key shape, so a
   * `hardLimit` in `nexus.jsonc` remains unreachable. See the note on
   * `NexusFullConfig.budget` for why the file does not grow the key.
   *
   * Stored as the three-key shape rather than as the `Partial` it arrives as, so
   * every `??` chain that bottoms out here is total. A `Partial` field would
   * force a trailing `?? DEFAULT_CONFIG` onto all three keys, and reaching for
   * that default is exactly what the chains above exist to avoid.
   */
  private budgetBase: NexusFullConfig['budget']
  /**
   * Programmatic starting point for the `selfHealing` block, beneath the file
   * levels and above `DEFAULT_CONFIG`. Same single-consumer rationale as
   * `dashboardBase`.
   */
  private selfHealingBase: NexusFullConfig['selfHealing']
  /**
   * Programmatic starting point for the `memory` block, beneath the file levels
   * and above `DEFAULT_CONFIG`. Same single-consumer rationale as
   * `dashboardBase`: the orchestrator seeds it and every consumer reads the
   * merged result, so the setting is readable from one place with a defined
   * precedence.
   *
   * There is deliberately NO stored copy of `memory.enabled` on the
   * orchestrator. The flag is read through `getConfig()` at the gate in
   * `recallForTask`, so a second copy could not be updated by a TUI edit or a
   * file reload and would go on answering with the value it was constructed
   * with — which is the exact failure `dashboardBase`'s doc comment describes.
   */
  private memoryBase: NexusFullConfig['memory']

  constructor(
    dashboardBase?: Partial<NexusDashboardConfig>,
    notificationsBase?: Partial<NexusNotificationsConfig>,
    customRolesBase?: readonly NexusCustomRoleConfig[],
    gitFlowBase?: Partial<NexusGitFlowConfig>,
    effortBase?: Partial<NexusEffortConfig>,
    budgetBase?: Partial<BudgetConstraint>,
    selfHealingBase?: Partial<NexusFullConfig['selfHealing']>,
    memoryBase?: Partial<NexusFullConfig['memory']>
  ) {
    // Config files are loaded later via loadFromPath(basePath)
    this.projectConfig = null
    this.globalConfig = null
    this.dashboardBase = { ...DEFAULT_CONFIG.dashboard, ...dashboardBase }
    this.notificationsBase = { ...DEFAULT_CONFIG.notifications, ...notificationsBase }
    this.customRolesBase = customRolesBase ? customRolesBase.map(role => ({ ...role })) : []
    this.gitFlowBase = { ...DEFAULT_CONFIG.gitFlow, ...gitFlowBase }
    // `maxEffort` goes through the same rung check a file value does, so a
    // programmatic seed cannot install a ceiling the ladder has no rung for —
    // the constructor is a config level, and this one is a public parameter.
    this.effortBase = {
      ...DEFAULT_CONFIG.effort,
      ...effortBase,
      maxEffort: resolveMaxEffort(effortBase?.maxEffort, DEFAULT_CONFIG.effort.maxEffort)
    }
    // The last two, and the last two to be added, which is why they are worth a
    // sentence. `getConfig()` merged `DEFAULT_CONFIG` straight into these two
    // blocks with no level in between, so a constructor-supplied budget or
    // self-healing block had nowhere to live: it was not a level, and every
    // consumer read the merged result. Adding a base is what makes the
    // precedence `storage > project > global > constructor > defaults` for all
    // seven object blocks instead of six of them plus a special case.
    // `hardLimit` is dropped HERE, deliberately and by name. The parameter is a
    // `Partial<BudgetConstraint>` so an embedder can seed one, but the stored
    // field is the three-key file shape: it is a constructor-only enforcement
    // switch, and letting it into this object would put a key the file schema
    // does not offer into `getConfig()`'s result, and from there into
    // `getSaveableConfig()`'s `{ ...current.budget }` — which is written as the
    // user's WHOLE `nexus.jsonc` on the next TUI save.
    this.budgetBase = {
      maxTotalCost: budgetBase?.maxTotalCost ?? DEFAULT_CONFIG.budget.maxTotalCost,
      maxCostPerTask: budgetBase?.maxCostPerTask ?? DEFAULT_CONFIG.budget.maxCostPerTask,
      alertThreshold: budgetBase?.alertThreshold ?? DEFAULT_CONFIG.budget.alertThreshold
    }
    this.selfHealingBase = { ...DEFAULT_CONFIG.selfHealing, ...selfHealingBase }
    // Last one added, so last one seeded. A spread rather than three `??`
    // chains because this block has no file-shape subset to protect: there is
    // no constructor-only key in it, unlike `budget`'s `hardLimit`.
    //
    // …but the seed is FILTERED first, and that filter is the point. Object
    // spread copies own enumerable keys INCLUDING ones whose value is
    // `undefined`, so `{ storage: undefined }` would not fall through to the
    // default — it would DELETE `storage` from the base. The orchestrator's 8th
    // seed is built as a literal of possibly-absent fields
    // (`{ storage: memoryStoreConfig?.dbPath, maxEntries: ... }`), which is
    // exactly that shape, so an unfiltered spread here left
    // `getConfig().memory` as `{ enabled: true }`: `getSaveableConfig()` then
    // wrote `"memory": {"enabled": true}` on the next save, `discoverConfig`
    // classified both lost keys `opaque`, and `getConfig().memory.storage`
    // disagreed with `memoryStore.path` with nothing logging it. Assigning a
    // field only when its source is `!== undefined` keeps the "the store's
    // config and the store agree" promise the mirror comments above make.
    const memorySeed: Partial<NexusFullConfig['memory']> = {}
    if (memoryBase?.storage !== undefined) memorySeed.storage = memoryBase.storage
    if (memoryBase?.maxEntries !== undefined) memorySeed.maxEntries = memoryBase.maxEntries
    this.memoryBase = { ...DEFAULT_CONFIG.memory, ...memorySeed }
  }

  /**
   * Load config files from disk and store as project/global config.
   * Called by loadFromPath() — not during construction anymore.
   */
  private loadConfigs(basePath: string): NexusConfigLoadSources {
    // Reset the session-scoped override on the FIRST load only. The initial
    // load runs at init, before anything can have set `storageConfig`, so
    // clearing it there only guarantees disk wins. A reload, however, can
    // happen at any time — including after `nexus.preset` layered an override
    // on top — and clearing unconditionally would silently discard it.
    if (this.loadInfo === null) this.storageConfig = null

    // Project-level: .opencode/nexus.jsonc
    const projectPath = nexusProjectConfigPath(basePath)
    const project = readJsoncFile(projectPath)
    this.projectConfig = project.config

    // Global-level: ~/.config/opencode/nexus.jsonc
    const globalPath = nexusGlobalConfigPath()
    const global = readJsoncFile(globalPath)
    this.globalConfig = global.config

    return {
      project: { path: redactHome(projectPath), existed: project.existed, parsed: project.config !== null },
      global: { path: redactHome(globalPath), existed: global.existed, parsed: global.config !== null }
    }
  }

  /**
   * Public entry point for config file loading.
   * Call during orchestrator initialization with the workspace root, and again
   * on every reload. A reload uses this same path, so all precedence levels are
   * re-read consistently.
   *
   * A session-scoped override applied in-process (the `preset` tool, TUI
   * settings) survives a reload: only the first load clears it, so editing a
   * config file on disk never silently discards a preset the user just chose.
   * The load reports `sessionOverride` so the resulting `models` map is never
   * mistaken for a disk-only reading.
   */
  loadFromPath(basePath: string, trigger: NexusConfigReloadTrigger = 'initial'): void {
    const sources = this.loadConfigs(basePath)
    this.loadInfo = {
      project: sources.project,
      global: sources.global,
      models: this.getResolvedModels(),
      sessionOverride: this.hasSessionOverride(),
      loadedAt: new Date().toISOString(),
      loadCount: (this.loadInfo?.loadCount ?? 0) + 1,
      trigger
    }
    console.log(formatConfigLoadLog(this.loadInfo))
  }

  /**
   * What the most recent load consulted and resolved, or null if no load has
   * run yet. Lets callers answer "which config am I actually using?" without
   * scraping logs.
   */
  getLoadInfo(): NexusConfigLoadInfo | null {
    return this.loadInfo
  }

  /**
   * The `role -> model` map as currently in effect — defaults -> global ->
   * project -> storage.
   *
   * Read live rather than off `getLoadInfo()`, because a session-scoped
   * override can be applied (or reset) between loads. A load-time snapshot
   * would answer "which model will my next subagent use?" with the value from
   * before the user applied a preset.
   */
  getResolvedModels(): Record<string, string> {
    const models: Record<string, string> = {}
    for (const [role, model] of Object.entries(this.getConfig().models)) {
      if (model) models[role] = model
    }
    return models
  }

  /**
   * True when a session-scoped override (the `preset` tool, TUI settings) is
   * currently layered on top of the disk config.
   */
  hasSessionOverride(): boolean {
    return this.storageConfig !== null
  }

  // Get merged config with precedence: storage > project > global > defaults
  // (`storageConfig` is the session-scoped override, cleared only by the first
  // load and by resetToDefaults())
  getConfig(): NexusFullConfig {
    return {
      models: {
        ...DEFAULT_CONFIG.models,
        ...this.globalConfig?.models,
        ...this.projectConfig?.models,
        ...this.storageConfig?.models
      },
      // FIELD BY FIELD, not spread, and the reason is `hardLimit`. `budgetBase`
      // is a `Partial<BudgetConstraint>` — the wider type, so an embedder can
      // seed a hard limit — but the RETURNED shape is the three-key file shape.
      // A spread would put `hardLimit` into that object at runtime, and
      // `getSaveableConfig()` writes `{ ...current.budget }` as the whole file
      // body: a `spread` here would start writing a `hardLimit` key into every
      // user's `nexus.jsonc` that a config schema does not offer. Dropping the
      // key explicitly also makes the answer to "is `hardLimit` file-settable?"
      // `false` rather than "true but ignored".
      //
      // The base is the constructor seed, the same level `dashboardBase` and
      // `effortBase` occupy for their blocks. It is there so the file is not the
      // ONLY thing that can set this block, which is what let
      // `new NexusOrchestrator({ budget: … })` be silently discarded at the
      // first `initialize()`.
      budget: {
        maxTotalCost: this.storageConfig?.budget?.maxTotalCost ?? this.projectConfig?.budget?.maxTotalCost
          ?? this.globalConfig?.budget?.maxTotalCost ?? this.budgetBase.maxTotalCost ?? DEFAULT_CONFIG.budget.maxTotalCost,
        maxCostPerTask: this.storageConfig?.budget?.maxCostPerTask ?? this.projectConfig?.budget?.maxCostPerTask
          ?? this.globalConfig?.budget?.maxCostPerTask ?? this.budgetBase.maxCostPerTask ?? DEFAULT_CONFIG.budget.maxCostPerTask,
        alertThreshold: this.storageConfig?.budget?.alertThreshold ?? this.projectConfig?.budget?.alertThreshold
          ?? this.globalConfig?.budget?.alertThreshold ?? this.budgetBase.alertThreshold ?? DEFAULT_CONFIG.budget.alertThreshold
      },
      // Field by field, for the same reason `dashboard` and `gitFlow` above are:
      // a level that sets only `retryDelay` must not blank out its siblings back
      // to the level beneath it. (A spread does not do that — `getConfig()`'s
      // other blocks were spreads until the partial-level case was found — but
      // the rule is the rule, and `selfHealing` is the block where the bug was.)
      selfHealing: {
        enabled: this.storageConfig?.selfHealing?.enabled ?? this.projectConfig?.selfHealing?.enabled
          ?? this.globalConfig?.selfHealing?.enabled ?? this.selfHealingBase.enabled,
        maxRetries: this.storageConfig?.selfHealing?.maxRetries ?? this.projectConfig?.selfHealing?.maxRetries
          ?? this.globalConfig?.selfHealing?.maxRetries ?? this.selfHealingBase.maxRetries,
        retryDelay: this.storageConfig?.selfHealing?.retryDelay ?? this.projectConfig?.selfHealing?.retryDelay
          ?? this.globalConfig?.selfHealing?.retryDelay ?? this.selfHealingBase.retryDelay,
        contextTransfer: this.storageConfig?.selfHealing?.contextTransfer ?? this.projectConfig?.selfHealing?.contextTransfer
          ?? this.globalConfig?.selfHealing?.contextTransfer ?? this.selfHealingBase.contextTransfer
      },
      // Same precedence as every other block — storage (session override) >
      // project > global > the constructor seed — and spelled field by field
      // rather than spread, because a level that sets only `enabled` must not
      // blank out the port and host resolved beneath it.
      dashboard: {
        enabled: this.storageConfig?.dashboard?.enabled ?? this.projectConfig?.dashboard?.enabled
          ?? this.globalConfig?.dashboard?.enabled ?? this.dashboardBase.enabled,
        port: this.storageConfig?.dashboard?.port ?? this.projectConfig?.dashboard?.port
          ?? this.globalConfig?.dashboard?.port ?? this.dashboardBase.port,
        host: this.storageConfig?.dashboard?.host ?? this.projectConfig?.dashboard?.host
          ?? this.globalConfig?.dashboard?.host ?? this.dashboardBase.host
      },
      // Field by field, for the same reason as `dashboard` above: a level
      // that sets only `enabled` must not blank out its siblings.
      notifications: {
        enabled: this.storageConfig?.notifications?.enabled ?? this.projectConfig?.notifications?.enabled
          ?? this.globalConfig?.notifications?.enabled ?? this.notificationsBase.enabled
      },
      // Field by field, for the same reason as `dashboard` above: a level that
      // sets only `enabled` must not blank out its siblings. All four keys are
      // merged independently so `{ "gitFlow": { "enabled": false } }` in a
      // project file turns the convention off WITHOUT also resetting
      // `conventionalCommits` to true on top of a global file that set it false.
      gitFlow: {
        enabled: this.storageConfig?.gitFlow?.enabled ?? this.projectConfig?.gitFlow?.enabled
          ?? this.globalConfig?.gitFlow?.enabled ?? this.gitFlowBase.enabled,
        conventionalCommits: this.storageConfig?.gitFlow?.conventionalCommits ?? this.projectConfig?.gitFlow?.conventionalCommits
          ?? this.globalConfig?.gitFlow?.conventionalCommits ?? this.gitFlowBase.conventionalCommits,
        requireBranch: this.storageConfig?.gitFlow?.requireBranch ?? this.projectConfig?.gitFlow?.requireBranch
          ?? this.globalConfig?.gitFlow?.requireBranch ?? this.gitFlowBase.requireBranch,
        prBeforeMerge: this.storageConfig?.gitFlow?.prBeforeMerge ?? this.projectConfig?.gitFlow?.prBeforeMerge
          ?? this.globalConfig?.gitFlow?.prBeforeMerge ?? this.gitFlowBase.prBeforeMerge
      },
      // Field by field, for the same reason as `gitFlow` above.
      //
      // `maxEffort` is the one key that is not a plain `??` chain, and the
      // difference is the point: a `??` chain cannot tell "absent" from "present
      // and not a real rung", so a hand-typed `"highh"` would resolve to
      // `"highh"` and then be handed to the ladder as a ceiling nothing can be
      // at or below — every task would silently get no variant, and the
      // feature would look broken rather than misconfigured. `resolveMaxEffort`
      // walks the SAME precedence and skips an unusable level instead, warning
      // about it, so the level beneath it — the user's actual preference — is
      // what takes effect.
      effort: {
        enabled: this.storageConfig?.effort?.enabled ?? this.projectConfig?.effort?.enabled
          ?? this.globalConfig?.effort?.enabled ?? this.effortBase.enabled,
        maxEffort: resolveMaxEffort(
          this.storageConfig?.effort?.maxEffort,
          this.projectConfig?.effort?.maxEffort,
          this.globalConfig?.effort?.maxEffort,
          this.effortBase.maxEffort
        ),
        // Clamped, not validated, and the asymmetry with `maxEffort` is
        // deliberate: a ceiling outside the ladder has no meaning (so it is
        // rejected), while a difficulty threshold outside `0-100` still has one
        // honest reading — "always" below 0, "never" above 100 — and the
        // mapping's own input is already clamped to that range. Non-finite
        // becomes 0, i.e. "no minimum", rather than `NaN` propagating into a
        // comparison that is then always false.
        minDifficulty: clampDifficulty(
          this.storageConfig?.effort?.minDifficulty
          ?? this.projectConfig?.effort?.minDifficulty
          ?? this.globalConfig?.effort?.minDifficulty
          ?? this.effortBase.minDifficulty
        )
      },
      // NOT field by field, because an array has no fields to merge. The
      // highest-precedence level that DEFINES the block wins wholesale, which
      // is the same rule the object blocks follow once you name the fields: a
      // level that sets only `notifications` says nothing about `customRoles`
      // and cannot blank it, and a project list is not silently appended to a
      // global one. Wholesale replacement rather than concatenation because
      // concatenation would leave two entries able to claim one name, with the
      // winner decided by list order rather than by the documented precedence.
      //
      // Copied, because the result is handed to `CustomRoleManager`, which
      // keeps the entries it registers.
      customRoles: (this.storageConfig?.customRoles
        ?? this.projectConfig?.customRoles
        ?? this.globalConfig?.customRoles
        ?? this.customRolesBase).map(role => ({ ...role })),
      // Field by field, for the same reason as every other object block above:
      // a level that sets only `enabled` — which is the single field a user is
      // most likely to write, and the one `/nexus config` toggles — must not
      // blank `storage` back to the level beneath. A spread would resolve the
      // same way here, but the rule is uniform across the blocks and one
      // exception is how the `retryDelay` class of bug got in.
      memory: {
        enabled: this.storageConfig?.memory?.enabled ?? this.projectConfig?.memory?.enabled
          ?? this.globalConfig?.memory?.enabled ?? this.memoryBase.enabled,
        storage: this.storageConfig?.memory?.storage ?? this.projectConfig?.memory?.storage
          ?? this.globalConfig?.memory?.storage ?? this.memoryBase.storage,
        maxEntries: this.storageConfig?.memory?.maxEntries ?? this.projectConfig?.memory?.maxEntries
          ?? this.globalConfig?.memory?.maxEntries ?? this.memoryBase.maxEntries
      }
    }
  }

  // Get model for a specific role
  // Returns "providerID/modelID" format. Falls back to the role's own default,
  // then the coder role, then the coder's default.
  //
  // A custom role's own `model` sits between the `models` block and the role's
  // default, so the two spellings of the same intent agree: `models: { "qa":
  // "x" }` and a `customRoles` entry named `qa` with `model: "x"` both resolve
  // to `x`, and when both are present the `models` block wins — it is the block
  // that exists to be overridden per role, while `model` on an entry is one
  // field of one role. `customRoles.find` is linear, but this is called once per
  // spawn for a handful of roles, not per token or per candidate.
  //
  // ── WHY AN EMPTY VALUE IS THE ROLE'S OWN DEFAULT ──
  //
  // `""` is what the TUI writes for "Use default": the picker's reset row is
  // `USE_DEFAULT_VALUE = ""` (`src/tui.tsx`), and `getSaveableConfig()` writes
  // the `models` block verbatim as the whole file body, so choosing that row
  // persists `"reviewer": ""` into the user's `nexus.jsonc` on purpose, every
  // time. `""` is falsy, so under a plain `||` chain a row labelled "Use
  // default" selected the CODER's model — `reviewer`'s default is
  // `openai/gpt-5-mini` and clearing it produced `anthropic/claude-sonnet-4-6`.
  // The product manufactured the state and then named the wrong model, so the
  // empty value resolves to what the row says it is.
  //
  // GATED ON `=== ''` rather than added as a bare `DEFAULT_CONFIG.models[role]`
  // level, and the gate is the substance rather than a precaution: an EMPTY
  // entry and an ABSENT one are different user intents, and `||` conflates
  // them. Empty is the user saying "use this role's default". Absent is the user
  // saying nothing at all about this role, which is the case the coder's
  // fallback exists for: a config that sets `coder` and omits the rest means
  // "run everything on the model I configured", not "run everything on the
  // built-in defaults". Substituting the default for an absent entry would
  // silently ignore the coder key in exactly the configs that bother to set it.
  //
  // For the seven built-in roles the two coincide anyway, because `getConfig()`
  // merges `DEFAULT_CONFIG.models` UNDERNEATH, so an absent entry never reaches
  // this level at all. A role outside that block does: a custom role, or an
  // embedder passing an explicit `undefined`. There the gate is the whole
  // difference, and this is why the level is a conditional expression and not a
  // plain term in the chain.
  //
  // A role with no entry in `DEFAULT_CONFIG.models` yields `undefined` here, and
  // that is not a value: the chain falls through to the coder's model, which is
  // its last resort and is what such a role resolved to before. A level that can
  // come up empty has to be allowed to fall through, because
  // `getModelForRole` returns `string` and a chain that ended here would hand a
  // spawn `undefined`.
  getModelForRole(role: string): string {
    const config = this.getConfig()
    const customRoleModel = config.customRoles.find(entry => entry.name === role)?.model
    // `string | undefined` by the index signature, not by assertion: a role
    // outside `DEFAULT_CONFIG.models` really does produce nothing here.
    const roleDefault = config.models[role] === '' ? DEFAULT_CONFIG.models[role] : undefined
    const model = config.models[role] || customRoleModel || roleDefault || config.models.coder || DEFAULT_CONFIG.models.coder!

    // NO WARNING for an empty value, and the absence is the fix rather than an
    // oversight. An empty entry used to resolve to the coder's model silently,
    // which is a wrong model under a role name that says otherwise — worth
    // saying out loud. The level above now makes it the role's own default, so
    // the outcome is the one the picker's row promises, the one a hand-written
    // `designer: ""` already gets, and the one removing the key gets. There is
    // no longer a fault for a warning to have a subject, and the message could
    // not have survived the fix in any case: it named the coder's model and
    // advised removing the key "to use this role's default", which is advice
    // this resolver now applies to the value as written.
    //
    // The narrowing that was available instead — warn only on values the picker
    // did not produce — is not implementable, which is the reason this is removal
    // rather than a condition. `""` reaches disk by three product paths (the
    // picker's reset row, `setModel` from the model dialog, and clearing a `text`
    // field in the config dialog, where `commitConfigText` takes the empty string
    // as written), and a persisted config cannot say which one wrote it. A memo
    // recording "the picker wrote this" would know for one process and then be
    // wrong on the next start, at which point the user is warned for their own
    // earlier click. Silence-by-memo is the behaviour being complained about.
    //
    // What is lost, stated plainly: a channel that noticed a config file
    // CONTAINING an empty entry. That is a note about a spelling rather than a
    // fault, and the channel that already exists for it is better — the load log
    // prints the resolved `role=model` map on every load, and
    // `getResolvedModels()` drops empty entries precisely so that map shows the
    // model that will actually run. The value is still reported; only the
    // complaint about how it was written is gone.
    //
    // Safety: ensure model has provider/model format
    if (!model.includes('/')) {
      console.warn(`[nexus] Model "${model}" for role "${role}" is missing provider prefix. Expected "providerID/modelID" format.`)
    }
    return model
  }

  // Update storage config (from TUI dialog)
  updateStorageConfig(update: Partial<NexusFullConfig>): void {
    this.storageConfig = {
      ...this.storageConfig,
      ...update,
      models: {
        ...this.storageConfig?.models,
        ...update.models
      },
      // `budget` walks the SAME precedence `selfHealing` below does, and for
      // the SAME reason. This method REPLACES the block with a fresh literal and
      // `getConfig()` merges the levels with `...storageConfig?.budget` LAST, so
      // a key written here is an explicit value that SHADOWS the project and
      // global files — including when the value written is only a default. A
      // call that set nothing but `models` therefore used to pin all three
      // budget keys to `DEFAULT_CONFIG` and make the user's `nexus.jsonc` budget
      // invisible, which is the same "the file is ignored" failure the
      // `selfHealing` list below was written to prevent. `budgetBase` — not
      // `DEFAULT_CONFIG` — is the last term, so a programmatic ceiling is not
      // lost either. `test/config-knobs.test.ts` drives this through a real file.
      budget: {
        maxTotalCost: update.budget?.maxTotalCost
          ?? this.storageConfig?.budget?.maxTotalCost
          ?? this.projectConfig?.budget?.maxTotalCost
          ?? this.globalConfig?.budget?.maxTotalCost
          ?? this.budgetBase.maxTotalCost,
        maxCostPerTask: update.budget?.maxCostPerTask
          ?? this.storageConfig?.budget?.maxCostPerTask
          ?? this.projectConfig?.budget?.maxCostPerTask
          ?? this.globalConfig?.budget?.maxCostPerTask
          ?? this.budgetBase.maxCostPerTask,
        alertThreshold: update.budget?.alertThreshold
          ?? this.storageConfig?.budget?.alertThreshold
          ?? this.projectConfig?.budget?.alertThreshold
          ?? this.globalConfig?.budget?.alertThreshold
          ?? this.budgetBase.alertThreshold
      },
      // `retryDelay` is walked field by field rather than spread from
      // `DEFAULT_CONFIG`, and that is load-bearing rather than an oversight.
      //
      // This method REPLACES `storageConfig.selfHealing` with a fresh literal,
      // and `getConfig()` merges the levels with `...storageConfig?.selfHealing`
      // LAST. So a key this list writes is an explicit value that SHADOWS the
      // project and global files — including when the value written is only the
      // default. Falling straight through to `DEFAULT_CONFIG` here therefore
      // made a call that set nothing but `models` pin the backoff base at 1000
      // and overwrite whatever the user's `nexus.jsonc` said, which is the exact
      // "the file is ignored" failure the spread in `getConfig()` exists to
      // prevent.
      //
      // The key cannot simply be left OUT of the literal either: `NexusFullConfig`
      // makes `retryDelay` a required member, so a three-key literal is a type
      // error — and that is the type doing its job, because a silently-dropped
      // key is how this shape went wrong in the first place. So the resolution
      // walks the SAME precedence `getConfig()` does, and writes the value the
      // level below would have supplied rather than the default.
      //
      // ALL FOUR fields, and that is the part this comment used to get wrong:
      // `retryDelay` was walked while `enabled`, `maxRetries` and
      // `contextTransfer` still fell through to `DEFAULT_CONFIG`, so a
      // models-only save pinned those three to their defaults and turned off a
      // project file's `selfHealing` block just as thoroughly. A test that
      // asserted only `retryDelay` passed throughout that. A partial fix is
      // indistinguishable from no fix at the next key, so the whole block is
      // written the same way. `test/config-knobs.test.ts` drives this through a
      // real file and asserts the block with `toEqual`, which fails on a
      // pinned sibling.
      selfHealing: {
        enabled: update.selfHealing?.enabled
          ?? this.storageConfig?.selfHealing?.enabled
          ?? this.projectConfig?.selfHealing?.enabled
          ?? this.globalConfig?.selfHealing?.enabled
          ?? this.selfHealingBase.enabled,
        maxRetries: update.selfHealing?.maxRetries
          ?? this.storageConfig?.selfHealing?.maxRetries
          ?? this.projectConfig?.selfHealing?.maxRetries
          ?? this.globalConfig?.selfHealing?.maxRetries
          ?? this.selfHealingBase.maxRetries,
        retryDelay: update.selfHealing?.retryDelay
          ?? this.storageConfig?.selfHealing?.retryDelay
          ?? this.projectConfig?.selfHealing?.retryDelay
          ?? this.globalConfig?.selfHealing?.retryDelay
          ?? this.selfHealingBase.retryDelay,
        contextTransfer: update.selfHealing?.contextTransfer
          ?? this.storageConfig?.selfHealing?.contextTransfer
          ?? this.projectConfig?.selfHealing?.contextTransfer
          ?? this.globalConfig?.selfHealing?.contextTransfer
          ?? this.selfHealingBase.contextTransfer
      }
    }
  }

  // Update single model in storage
  setModel(role: string, model: string): void {
    // Seeded with `models` alone, NOT with a `DEFAULT_CONFIG` spread. A full
    // spread would put a default value in every other block at the
    // highest-precedence level, and `customRoles` would then win over the
    // user's file with an empty list — the dashboard block's lost-config bug,
    // reached by a different route.
    this.storageConfig = this.storageConfig || { models: {} }
    this.storageConfig.models = this.storageConfig.models || {}
    this.storageConfig.models[role] = model
  }

  // Get all available roles
  //
  // The picker, the summary, and the "which model does this role use" lookup all
  // read this list, so a role missing from HERE is a role the user cannot pick a
  // model for — which is why it is one literal rather than six.
  getRoles(): string[] {
    return ['architect', 'coder', 'reviewer', 'tester', 'explorer', 'documenter', 'designer']
  }

  // Get role display name
  getRoleDisplayName(role: string): string {
    const names: Record<string, string> = {
      architect: 'Architect',
      coder: 'Coder',
      reviewer: 'Reviewer',
      tester: 'Tester',
      explorer: 'Explorer',
      documenter: 'Documenter',
      designer: 'Designer'
    }
    return names[role] || role
  }

  // Get role emoji for TUI display
  getRoleEmoji(role: string): string {
    const emojis: Record<string, string> = {
      architect: '🏗️',
      coder: '💻',
      reviewer: '🔍',
      tester: '🧪',
      explorer: '🔬',
      documenter: '📝',
      // 🎨 is the palette, and it is distinct from all six above: 🏗️ is a
      // building, so "designer" could not borrow it without two roles wearing
      // the same badge in the sidebar and the same leading glyph in a session
      // title.
      designer: '🎨'
    }
    return emojis[role] || '🤖'
  }

  // Export config for saving
  exportConfig(): NexusFullConfig {
    return this.getConfig()
  }

  // Import config from storage
  importConfig(config: NexusFullConfig): void {
    this.storageConfig = { ...config }
  }

  /**
   * Write a partial config to a JSONC file on disk.
   * Creates parent directories recursively if needed.
   */
  writeJsoncFile(filePath: string, config: Partial<NexusFullConfig>): void {
    const dir = dirname(filePath)
    mkdirSync(dir, { recursive: true })

    const jsonc = [
      '// Nexus Configuration — https://github.com/serkanalgur/opencode-nexus',
      '// Precedence: this file > global config > TUI settings > defaults',
      '',
      JSON.stringify(config, null, 2)
    ].join('\n')

    writeFileSync(filePath, jsonc + '\n', 'utf-8')
  }

  /**
   * Save project-level config to disk.
   * Writes to `{basePath}/.opencode/nexus.jsonc` with only non-default values.
   */
  saveProjectConfig(basePath: string): void {
    const projectPath = nexusProjectConfigPath(basePath)
    const config = this.getSaveableConfig()
    this.writeJsoncFile(projectPath, config)
  }

  /**
   * Save global-level config to disk.
   * Writes to `~/.config/opencode/nexus.jsonc` with only non-default values.
   */
  saveGlobalConfig(): void {
    const globalPath = nexusGlobalConfigPath()
    const config = this.getSaveableConfig()
    this.writeJsoncFile(globalPath, config)
  }

  /**
   * Initialize project-level config with full defaults.
   * Writes to `{basePath}/.opencode/nexus.jsonc` with all default values.
   */
  initProjectConfig(basePath: string): void {
    const projectPath = nexusProjectConfigPath(basePath)
    // Don't overwrite existing user config
    try {
      readFileSync(projectPath, 'utf-8')
      return // File exists, skip to preserve user settings
    } catch {
      // File doesn't exist, initialize with defaults
    }
    this.writeJsoncFile(projectPath, { ...DEFAULT_CONFIG })
  }

  /**
   * Initialize global-level config with full defaults.
   * Writes to `~/.config/opencode/nexus.jsonc` with all default values.
   */
  initGlobalConfig(): void {
    const globalPath = nexusGlobalConfigPath()
    // Don't overwrite existing user config
    try {
      readFileSync(globalPath, 'utf-8')
      return // File exists, skip to preserve user settings
    } catch {
      // File doesn't exist, initialize with defaults
    }
    this.writeJsoncFile(globalPath, { ...DEFAULT_CONFIG })
  }

  /**
   * Save config at the specified level.
   * @param level - 'project' or 'global'
   * @param basePath - Project root directory (required for project level)
   */
  saveConfig(level: 'project' | 'global', basePath?: string): void {
    if (level === 'project') {
      this.saveProjectConfig(basePath || process.cwd())
    } else {
      this.saveGlobalConfig()
    }
  }

  /**
   * Extract current config for saving.
   * Always writes all model selections (not just non-defaults)
   * so user choices are preserved across restarts.
   */
  private getSaveableConfig(): Partial<NexusFullConfig> {
    const current = this.getConfig()
    const result: Partial<NexusFullConfig> = {}

    // Models — always include all roles so user selections are preserved
    result.models = { ...current.models }

    // Budget — include all fields
    result.budget = { ...current.budget }

    // Self-healing — include all fields.
    //
    // The whole block, by the same reasoning as the four below: `saveProjectConfig`
    // writes this return value as the ENTIRE file body, so a field left out is a
    // field reset to its default the first time the user changes a model in the
    // TUI. That is exactly what would have happened to `retryDelay` — the spread
    // picks up whatever the merge resolved, so a user's file-set backoff base
    // round-trips through a model save unchanged.
    result.selfHealing = { ...current.selfHealing }

    // Dashboard — include all fields.
    //
    // This block is written out unconditionally, like models and budget above,
    // and for the same reason it must be listed at all: `saveProjectConfig()`
    // writes the RETURNED object as the whole file, so a block left out here is
    // a block deleted from the user's `nexus.jsonc` the first time they change
    // a model in the TUI. `enabled: false` would silently turn back on.
    result.dashboard = { ...current.dashboard }

    // Notifications — same reason, and with `enabled: false` this is the
    // setting a user is most likely to have deliberately turned off.
    result.notifications = { ...current.notifications }

    // Git flow — same reason, and all four fields rather than one: a block
    // written out partially would let the next `saveProjectConfig` silently
    // restore a convention the user had turned off. Omitting the block
    // ENTIRELY is the worse case, and it is what an omission here produces:
    // `saveProjectConfig()` writes the RETURNED object as the whole file.
    result.gitFlow = { ...current.gitFlow }

    // Effort — same reason, all three fields. `enabled: false` is the value a
    // user is most likely to have chosen deliberately, and `maxEffort` is a
    // ceiling they may have lowered; a block written out partially would let
    // the next `saveProjectConfig` restore an effort policy they had turned
    // down. Omitting the block ENTIRELY is the worse case, and is what an
    // omission here produces: `saveProjectConfig()` writes the RETURNED object
    // as the whole file.
    result.effort = { ...current.effort }

    // Custom roles — same reason. This one is the whole block: a
    // `customRoles` array omitted here is every role the user wrote deleted
    // from their `nexus.jsonc` the first time they change a model in the TUI,
    // with nothing to restore them from.
    result.customRoles = current.customRoles.map(role => ({ ...role }))

    // Memory — same reason, all three fields. This block is the one where an
    // omission is least visible: the file keeps working, the store keeps
    // working, and a user's chosen DB path and entry cap silently reset to the
    // defaults at the first model change, leaving notes in a file nothing names
    // any more. `saveProjectConfig` writes this return value as the whole file.
    result.memory = { ...current.memory }

    return result
  }

  /**
   * Hand control back to the disk config by dropping the session-scoped
   * override. This is the one implementation of that, and the only place
   * `storageConfig` is cleared: the TUI reaches it from two call sites, and
   * the `preset` tool's `clear` mode reaches it from the agent side, so
   * neither can drift from the other or bypass it.
   *
   * The disk files are not touched — this drops the in-memory override, it
   * does not rewrite any config.
   *
   * @returns whether an override was actually present, so a caller can report
   * "nothing to clear" instead of claiming a change it did not make.
   */
  resetToDefaults(): boolean {
    const hadOverride = this.storageConfig !== null
    this.storageConfig = null
    return hadOverride
  }

  /**
   * Apply a named preset configuration.
   *
   * A preset is a complete model selection and its `models` object replaces
   * the whole level, so while it is in effect a disk edit to `models` cannot
   * win. It survives a config reload (see `loadFromPath`); `resetToDefaults()`
   * is how the user hands control back to disk.
   */
  applyPreset(name: string): void {
    const preset = PRESETS[name]
    if (!preset) throw new Error(`Unknown preset: ${name}. Available: ${Object.keys(PRESETS).join(', ')}`)
    this.storageConfig = { ...this.storageConfig, ...preset.config }
  }

  // List available preset names
  listPresets(): string[] {
    return Object.keys(PRESETS)
  }

  // Get config summary for display
  getSummary(): string {
    const config = this.getConfig()
    const lines = [
      '📊 Nexus Configuration',
      '═══════════════════════',
      '',
      '🤖 Agent Models:',
    ]

    for (const role of this.getRoles()) {
      const model = config.models[role] || '(not set)'
      const displayName = this.getRoleDisplayName(role)
      lines.push(`  ${displayName}: ${model}`)
    }

    lines.push('')
    lines.push('💰 Budget:')
    lines.push(`  Max Total: $${config.budget.maxTotalCost}`)
    // Labelled "advisory" rather than "max", because that is what it is: a turn
    // that is already running cannot be interrupted, so this raises a
    // notification when one task's running total crosses it and stops nothing.
    // The same relationship `Max Total` has to `hardLimit`.
    lines.push(`  Per Task (advisory): $${config.budget.maxCostPerTask}`)
    lines.push(`  Alert Threshold: ${config.budget.alertThreshold * 100}%`)
    lines.push('')
    lines.push('🛡️ Self-Healing:')
    lines.push(`  Enabled: ${config.selfHealing.enabled ? '✅' : '❌'}`)
    lines.push(`  Max Retries: ${config.selfHealing.maxRetries}`)
    // The BASE of the 1s/2s/4s backoff. Listed because it is settable in
    // `nexus.jsonc` now, and a setting nobody can see is the half of this
    // defect the file shape used to be.
    lines.push(`  Retry Delay: ${config.selfHealing.retryDelay}ms`)
    lines.push(`  Context Transfer: ${config.selfHealing.contextTransfer ? '✅' : '❌'}`)

    return lines.join('\n')
  }
}

// Preset configurations
export interface NexusPreset {
  name: string
  description: string
  config: Partial<NexusFullConfig>
}

export const PRESETS: Record<string, NexusPreset> = {
  minimal: {
    name: 'Minimal',
    description: 'Low-cost setup with free/cheap models, minimal budget',
    config: {
      models: {
        architect: 'google/gemini-2.5-flash',
        coder: 'google/gemini-2.5-flash',
        reviewer: 'google/gemini-2.5-flash',
        tester: 'google/gemini-2.5-flash',
        explorer: 'google/gemini-2.5-flash',
        documenter: 'google/gemini-2.5-flash',
        // The whole point of this preset is that every role runs on the cheapest
        // model that can be asked. A frontier model here would be a bug in
        // spirit: the designer would quietly cost more than the six roles it
        // plans for, against a $1 total ceiling chosen to be a real ceiling.
        designer: 'google/gemini-2.5-flash',
      },
      budget: {
        maxTotalCost: 1.00,
        maxCostPerTask: 0.10,
        alertThreshold: 0.5,
      },
      selfHealing: {
        enabled: false,
        maxRetries: 1,
        retryDelay: 1000,
        contextTransfer: false,
      },
    }
  },
  balanced: {
    name: 'Balanced',
    description: 'Good quality models with moderate budget',
    config: {
      models: {
        architect: 'anthropic/claude-sonnet-4-6',
        coder: 'anthropic/claude-sonnet-4-6',
        reviewer: 'openai/gpt-5-mini',
        tester: 'anthropic/claude-haiku-4-5',
        explorer: 'google/gemini-2.5-flash',
        documenter: 'anthropic/claude-haiku-4-5',
        // The design director is the architect's peer here, not the coder's: it
        // decides, and the coder implements. This preset already pays sonnet for
        // the architect and gpt-5-mini for the reviewer, so a design decision
        // gets sonnet rather than the cheap end — a bad layout decision costs a
        // rewrite of the feature, which is the same argument the architect
        // placement makes.
        designer: 'anthropic/claude-sonnet-4-6',
      },
      budget: {
        maxTotalCost: 10.00,
        maxCostPerTask: 1.00,
        alertThreshold: 0.2,
      },
      selfHealing: {
        enabled: true,
        maxRetries: 3,
        retryDelay: 1000,
        contextTransfer: true,
      },
    }
  },
  enterprise: {
    name: 'Enterprise',
    description: 'High-quality models with generous budget and full self-healing',
    config: {
      models: {
        architect: 'anthropic/claude-sonnet-4-6',
        coder: 'anthropic/claude-sonnet-4-6',
        reviewer: 'openai/gpt-5',
        tester: 'anthropic/claude-sonnet-4-6',
        explorer: 'anthropic/claude-sonnet-4-6',
        documenter: 'anthropic/claude-haiku-4-5',
        // Sonnet, deliberately NOT gpt-5 the way the reviewer gets it. The
        // reviewer's job is to catch defects in a diff that already exists, so
        // the strongest available model is close to free money there. The
        // design director's output is a judgement about something that does not
        // exist yet, where a confident wrong answer is not caught by any later
        // reviewer — a test passes, a reviewer finds no bug, and the interface is
        // still wrong. Frontier reasoning is worth less on a job whose failure
        // mode is invisible to every other agent in the graph.
        designer: 'anthropic/claude-sonnet-4-6',
      },
      budget: {
        maxTotalCost: 50.00,
        maxCostPerTask: 5.00,
        alertThreshold: 0.1,
      },
      selfHealing: {
        enabled: true,
        maxRetries: 5,
        retryDelay: 1000,
        contextTransfer: true,
      },
    }
  },
  'cost-optimized': {
    name: 'Cost-Optimized',
    description: 'Minimize costs while maintaining reasonable quality',
    config: {
      models: {
        architect: 'anthropic/claude-haiku-4-5',
        coder: 'google/gemini-2.5-flash',
        reviewer: 'openai/gpt-5-mini',
        tester: 'google/gemini-2.5-flash',
        explorer: 'google/gemini-2.5-flash',
        documenter: 'google/gemini-2.5-flash',
        // Haiku, not flash, even though four of the six roles here are flash.
        // This preset demotes the architect to haiku for the same reason it
        // demotes the reviewer to gpt-5-mini: keep the judgement roles off the
        // cheapest tier. Flash writes the code; a design decision made on flash
        // is the input to all of that code, so the cost of getting it wrong is
        // paid several times over while the saving is paid once.
        designer: 'anthropic/claude-haiku-4-5',
      },
      budget: {
        maxTotalCost: 3.00,
        maxCostPerTask: 0.30,
        alertThreshold: 0.3,
      },
      selfHealing: {
        enabled: true,
        maxRetries: 2,
        retryDelay: 1000,
        contextTransfer: false,
      },
    }
  }
}

export { DEFAULT_CONFIG }
