/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { NexusConfigManager } from "./config"
import {
  formatModelPrice,
  modelRef,
  providerLabels,
  type GroupedModel,
  type ProviderLabelSource
} from "./model-groups"

// Types for agent status in the sidebar
interface AgentStatus {
  id: string
  name: string
  role: string
  status: 'idle' | 'working' | 'completed' | 'failed' | 'terminated'
  model: string
  sessionID?: string
  spawnedAt: string
  tasksCompleted: number
  tasksFailed: number
}

interface SidebarState {
  agents: AgentStatus[]
  totalCost: number
  budgetRemaining: number
}

// ── Sidebar session scanning ───────────────────────────────────────
// Kept as free functions so the TUI entrypoint stays a thin adapter over the
// live context and the scanning logic can be driven directly in tests.

/** Agent-id prefix this plugin registers its roles under (`nexus-coder`, …). */
const NEXUS_AGENT_PREFIX = "nexus-"

/**
 * The subset of `SessionInfo` the sidebar reads.
 *
 * Structural rather than an import from `@opencode/client`, which is not a
 * direct dependency of this package: every real `SessionInfo` is assignable to
 * this shape, and the narrow shape is what the scanner below is written
 * against.
 */
export interface SidebarSession {
  readonly id: string
  readonly title?: string
  readonly agent?: string
  readonly model?: { readonly id: string; readonly providerID: string }
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** The read-only slice of `context.data.session` the scanner needs. */
export interface SidebarSessionSource {
  family(sessionID: string): readonly string[]
  get(sessionID: string): SidebarSession | undefined
}

/**
 * Reads a string field from `session.metadata`.
 *
 * `spawnAgent` no longer writes session-level metadata — it is not a field of
 * `SessionUpdateInput`, so the write was a silent no-op — and the nexus role
 * and model live on the orchestrator's own `Agent` record, which the TUI cannot
 * reach (its `nexus-sidebar-state` is TUI-local storage, a different scope from
 * the server-side `ctx.storage` the orchestrator writes). What the TUI *can*
 * read is `session.agent` and `session.model`, which the host populates for
 * every session; those are the authoritative sources and are used everywhere
 * below. Metadata is still consulted first purely as a forward-compatible
 * preferred source: if a future release does manage to write it, the exact
 * role/model spelling wins without this code changing.
 */
function metadataString(
  metadata: SidebarSession["metadata"],
  key: string
): string | undefined {
  const value = metadata?.[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/**
 * Role behind a session's agent id: `nexus-coder` → `coder`.
 *
 * A non-nexus agent id is taken as-is, since the sidebar is already scoped to
 * this session's family and the real agent name is more informative than the
 * `'agent'` placeholder the old dead metadata read produced.
 */
function roleFromAgent(agent: string | undefined): string | undefined {
  if (!agent) return undefined
  const role = agent.startsWith(NEXUS_AGENT_PREFIX)
    ? agent.slice(NEXUS_AGENT_PREFIX.length)
    : agent
  return role.length > 0 ? role : undefined
}

/** `ModelRef` → the `provider/id` string the sidebar renders. */
function modelLabel(model: SidebarSession["model"]): string | undefined {
  if (!model?.providerID || !model.id) return undefined
  return `${model.providerID}/${model.id}`
}

/** `coder` → `Coder`, matching how the sidebar has always displayed roles. */
function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

/**
 * Sidebar record for one child session.
 *
 * `name` keeps its previous meaning — the capitalised role when one is known,
 * otherwise the session title, otherwise a short id — so the sidebar reads the
 * same as it did when the (now absent) metadata path worked.
 */
export function sidebarAgentFor(
  session: SidebarSession,
  status: AgentStatus["status"],
  now: string
): AgentStatus {
  const role =
    metadataString(session.metadata, "nexusRole") ??
    roleFromAgent(session.agent)
  return {
    id: session.id,
    name: role ? titleCase(role) : session.title || session.id.slice(0, 12),
    role: role ?? "agent",
    status,
    model:
      metadataString(session.metadata, "nexusModel") ??
      modelLabel(session.model) ??
      "",
    sessionID: session.id,
    spawnedAt: now,
    tasksCompleted: 0,
    tasksFailed: 0
  }
}

/**
 * The nexus subagent sessions to show for the current session, from
 * `session.family()` alone.
 *
 * `family()` resolves to the *root* of the given session and returns that
 * root's entire tree, so a subagent spawned by this plugin is always in it.
 *
 * There is deliberately no "scan every session for a nexus role" fallback. One
 * used to exist to recover nexus sessions that `family()` missed, back when
 * spawned sessions came out unparented. That parentage bug is fixed at the
 * source, and the scan has been dead ever since: it keyed off
 * `metadata.nexusRole`, which no session carries any more. Re-arming it against
 * `session.agent` would be worse than dead. Anything `family()` excludes
 * belongs to a *different* root's tree, so a scan could only ever pull in
 * another session's agents — and it has no way to tell them apart, because
 * `nexus-orchestrator` carries a `nexus-`-prefixed agent id while being a
 * primary agent rather than a subagent. A `startsWith("nexus-")` filter would
 * therefore sweep every previous orchestrator session into the sidebar, and the
 * entries would then flicker in and out as the family result oscillated.
 */
export function sidebarChildSessionIDs(
  family: readonly string[] | undefined,
  currentSessionID: string
): string[] {
  if (!Array.isArray(family)) return []
  return family.filter(id => id !== currentSessionID)
}

/**
 * One polling pass: resolve each child session of `currentSessionID` into an
 * `AgentStatus`. Per-session lookups are individually guarded because a session
 * can be evicted between listing and reading it, and a missing or unreadable
 * child must drop out of the sidebar rather than crash the poll.
 */
export function collectSidebarAgents(
  source: SidebarSessionSource,
  currentSessionID: string,
  statusOf: (sessionID: string) => AgentStatus["status"],
  now: string
): AgentStatus[] {
  const childIDs = sidebarChildSessionIDs(source.family(currentSessionID), currentSessionID)
  if (childIDs.length === 0) return []

  const agents: AgentStatus[] = []
  for (const id of childIDs) {
    try {
      const session = source.get(id)
      if (!session) continue
      let status: AgentStatus["status"] = "completed"
      try {
        status = statusOf(id)
      } catch {
        // session.status() is best-effort; fall back to "completed"
      }
      agents.push(sidebarAgentFor(session, status, now))
    } catch {
      // a single unreadable child must not abort the whole poll
    }
  }
  return agents
}

/**
 * Folds one poll's findings into the sidebar's agent list: update agents we
 * already track, append the new ones, and drop working agents whose session has
 * left the family. Completed and failed agents are kept as history.
 */
export function mergeSidebarAgents(
  agents: readonly AgentStatus[],
  polled: readonly AgentStatus[],
  childIDs: readonly string[]
): AgentStatus[] {
  const next = agents.map(agent => ({ ...agent }))

  for (const agent of polled) {
    const existing = next.find(a => a.sessionID === agent.sessionID)
    if (existing) {
      existing.status = agent.status
      existing.name = agent.name
      existing.role = agent.role
      existing.model = agent.model
    } else {
      next.push(agent)
    }
  }

  return next.filter(
    a =>
      (a.sessionID && childIDs.includes(a.sessionID)) ||
      a.status === "completed" ||
      a.status === "failed"
  )
}

// ── `/nexus web` ───────────────────────────────────────────────────
// Free functions, for the same reason the sidebar scanners are: the TUI
// entrypoint is a thin adapter over the live context, and the logic worth
// having a test on has to be reachable without one.
//
// WHAT THIS CANNOT DO, and why that matters enough to be a design constraint
// rather than a limitation to apologise for: it cannot start the server itself.
//
// The TUI plugin (`@opencode/plugin/tui`, shipped as `dist/tui.js`) runs in the
// TUI process. The orchestrator, and therefore the only `DashboardModule` that
// has any state to serve, lives in the *server* plugin process (`dist/index.js`,
// the one that registers `nexus.dashboard.start`). The TUI's `PluginContext`
// exposes no orchestrator, no module registry and no way to invoke a tool — only
// the OpenCode client, host data, and the UI. So a "start" from here could only
// mean spawning a second, empty server in the TUI process, which would answer
// `/api/state` with an orchestrator that does not exist and render an empty
// dashboard on the very port the real one wants.
//
// What it CAN do is reach the server: the OpenCode client on the context is an
// HTTP client to the same server process the orchestrator lives in, and
// `session.prompt` on it lands in that process's prompt hook — which is
// `orchestrator.handleCommand`. So `deps.submitCommand()` below submits
// `/nexus dashboard [port] [host]` as one action, and the server starts the
// server. The TUI's remaining job is the half only it can do: confirm the
// listen happened before a browser is pointed at it.
//
// The previous behaviour was worse than doing nothing: it shelled out to
// `open`/`start`/`xdg-open` unconditionally, so the browser was ALWAYS pointed
// at a dead address, and the toast told the user to go ask the agent. This
// probes first and opens the browser only against a confirmed nexus dashboard.

/** What a probe of `http://host:port/api/health` found. */
export interface DashboardProbe {
  /** Something answered on that address. */
  listening: boolean
  /** That something is a nexus dashboard, by its own health contract. */
  isNexusDashboard: boolean
  /** Human-readable outcome, used verbatim in the toast. */
  detail: string
}

/**
 * Ask an address whether it is a nexus dashboard.
 *
 * `/api/health` is the discriminator, not a bare TCP connect: a port in use by
 * something else — a stale dashboard from a previous session, a dev server, a
 * Jupyter kernel — also answers, and opening a browser at it would be the same
 * mistake as opening one at a closed port. The response is also checked for
 * shape, because a 200 from an unrelated app is still a 200.
 */
export async function probeDashboard(
  host: string,
  port: number,
  fetchImpl: typeof fetch = fetch
): Promise<DashboardProbe> {
  const url = `http://${host}:${port}/api/health`
  let response: Response
  try {
    response = await fetchImpl(url)
  } catch (error: unknown) {
    // A refused connection is the ordinary "not started" case and is reported
    // as such rather than as an error. Anything else (a DNS failure, an
    // abort) is named so it is not mistaken for "nothing is listening".
    const detail = error instanceof Error ? error.message : String(error)
    const refused = /ECONNREFUSED|fetch failed|Failed to fetch|NetworkError|ECONNRESET/i.test(detail)
    return {
      listening: false,
      isNexusDashboard: false,
      detail: refused
        ? `nothing is listening on ${host}:${port}`
        : `could not reach ${host}:${port} (${detail})`,
    }
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return {
      listening: true,
      isNexusDashboard: false,
      detail: `${host}:${port} answered ${response.status} but not with dashboard JSON`,
    }
  }

  // `DashboardModule`'s `/api/health` handler is `{ ok: true, uptime }`. Both
  // fields are checked: `ok: true` alone is a single word any app can return.
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    const record = body as Record<string, unknown>
    if (record.ok === true && typeof record.uptime === "number") {
      return {
        listening: true,
        isNexusDashboard: true,
        detail: `a nexus dashboard is serving ${host}:${port}`,
      }
    }
  }

  return {
    listening: true,
    isNexusDashboard: false,
    detail: `something else is listening on ${host}:${port} and it is not a nexus dashboard`,
  }
}

/** The address a `/nexus dashboard [port] [host]` argument resolves to. */
export interface WebDashboardTarget {
  port: number
  host: string
}

/**
 * Parse a `[port] [host]` argument against the configured defaults.
 *
 * Accepts a bare port, `port host`, or nothing. Returns an error string rather
 * than a coerced number for an unparseable port: `parseInt("abc")` is `NaN`,
 * and `NaN` used to reach a URL as the literal text `NaN`, which is a
 * connection failure whose cause is invisible in the address that failed.
 *
 * DELIBERATELY NOT THE SAME FUNCTION as `parseDashboardTarget()` in
 * `src/dashboard.ts`, which parses the identical argument for
 * `handleCommand("/nexus dashboard …")` on the server. Importing that module
 * here would inline `dashboard/index.html` — 150 KB of page markup — into
 * `dist/tui.js`, which serves no dashboard and would never read a byte of it.
 * Fifteen lines of parser is a cheaper price than that, and the two are pinned
 * by the same test so a change to one that is not made to the other is a
 * failing test rather than a silent disagreement about what a port is.
 */
export function parseWebDashboardTarget(
  input: string | undefined,
  fallback: WebDashboardTarget
): { target: WebDashboardTarget } | { error: string } {
  const parts = (input ?? "").trim().split(/\s+/).filter(Boolean)
  let port = fallback.port
  let host = fallback.host

  if (parts.length > 0) {
    // `Number` rather than `parseInt`, so "4747abc" is rejected instead of
    // silently becoming 4747.
    const parsed = Number(parts[0])
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      return { error: `"${parts[0]}" is not a port number. Give a port between 1 and 65535.` }
    }
    port = parsed
  }
  if (parts.length > 1) {
    host = parts[1]
  }

  return { target: { port, host } }
}

/**
 * How long to wait for the server to confirm a listen before telling the user
 * it did not, and how often to ask.
 *
 * Bounds matter here in both directions. Too short and a start that succeeded is
 * reported as a failure the user then has to disbelieve; too long and a bind
 * failure leaves the TUI looking hung for the whole window. A bind is
 * sub-millisecond and the prompt that triggers it is a local HTTP call, so
 * three seconds is generous for the success case and short enough that the
 * failure case does not feel like a hang.
 *
 * WHAT THAT THREE SECONDS ASSUMES, because the number is only as good as it is.
 * It assumes `submitCommand` resolves when the server has ACCEPTED the prompt,
 * not when the model has finished answering it. That is the reading the API
 * supports: `session.prompt` resolves with a `SessionInboxUser` — an inbox item
 * carrying a `delivery` — which is an acknowledgement that the message is
 * queued, and `SessionPromptInput` exposes no `await`/`async` flag for asking
 * the model to block on the turn. If that reading is wrong and the promise in
 * fact settles after the model turn, this window is not the whole cost: the
 * `await` on the submit above then carries model latency, and the failure toast
 * can appear minutes after the keystroke, with the ~3s in `README.md` and
 * `docs/COMPATIBILITY.md` understating it. The window is a bound on the POLL,
 * and only the poll.
 */
export const LISTEN_CONFIRM_ATTEMPTS = 15
export const LISTEN_CONFIRM_INTERVAL_MS = 200

/** What the TUI needs from its host to run the dashboard commands. */
export interface WebDashboardDeps {
  /** The configured dashboard block — the same one the start gate reads. */
  dashboard: { enabled: boolean; port: number; host: string }
  showToast(options: { title: string; message: string; variant: "info" | "success" | "warning" | "error"; duration?: number }): void
  openBrowser(url: string): Promise<void> | void
  /**
   * Hand text to the OpenCode server process, where the plugin's prompt hook
   * routes a `/nexus …` command to `orchestrator.handleCommand`. This is the
   * only channel from the TUI to the orchestrator, and submitting the command
   * is what makes one keystroke start the server instead of describing how to.
   */
  submitCommand(text: string): Promise<void> | void
  fetchImpl?: typeof fetch
  /** Injected so a test does not have to wait three real seconds. */
  waitImpl?: (ms: number) => Promise<void>
  confirmAttempts?: number
  confirmIntervalMs?: number
}

function defaultWait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * The one implementation behind `/nexus dashboard` and `/nexus web`.
 *
 * Never opens a browser at an address it has not confirmed is serving a nexus
 * dashboard. The four outcomes are all deliberate, and each says which of them
 * happened:
 *
 * 1. disabled by config — nothing will ever listen, so say which key says so
 *    and stop, rather than probing a port the user has switched off.
 * 2. already serving a dashboard — the address is live, so open it, and say
 *    that nothing was started a second time.
 * 3. something else on the port — a bind would fail and the other process's
 *    page is not the dashboard, so open nothing and say which of those it is.
 * 4. nothing on the port — the ordinary case. Submit `/nexus dashboard [port]
 *    [host]` to the server, then WAIT for a confirmed listen before opening a
 *    browser. A start that fails comes back as "no dashboard within the
 *    window", with no URL offered and no claim that anything opened.
 */
export async function handleWebDashboard(
  input: string | undefined,
  deps: WebDashboardDeps
): Promise<void> {
  const parsed = parseWebDashboardTarget(input, {
    port: deps.dashboard.port,
    host: deps.dashboard.host,
  })
  if ("error" in parsed) {
    deps.showToast({ title: "Nexus Web Dashboard", message: parsed.error, variant: "error" })
    return
  }

  const { port, host } = parsed.target
  const url = `http://${host}:${port}`

  if (!deps.dashboard.enabled) {
    deps.showToast({
      title: "Nexus Web Dashboard — disabled",
      message: [
        `The dashboard is switched off: \`dashboard.enabled\` is false in your nexus.jsonc,`,
        "so nothing will listen on any port and no browser was opened.",
        "",
        "Set it to true (or delete the `dashboard` block, which defaults to enabled),",
        "then run /nexus web again.",
      ].join("\n"),
      variant: "error",
      duration: 12000,
    })
    return
  }

  const probe = await probeDashboard(host, port, deps.fetchImpl)
  if (probe.isNexusDashboard) {
    await deps.openBrowser(url)
    deps.showToast({
      title: "⚡ Nexus Web Dashboard",
      message: `Opened ${url} — a dashboard is already running there, so nothing was started.`,
      variant: "success",
      duration: 6000,
    })
    return
  }

  if (probe.listening) {
    deps.showToast({
      title: "Nexus Web Dashboard — port in use",
      message: [
        `${probe.detail}.`,
        "",
        "No browser was opened: that address is not the dashboard.",
        "Run /nexus web with a different port, e.g. /nexus web 4748.",
      ].join("\n"),
      variant: "error",
      duration: 12000,
    })
    return
  }

  // Nothing is listening and nothing is squatting, so this is the one case where
  // a start is the right answer. The start itself happens in the server
  // process, one command away; everything after this line is the TUI refusing
  // to believe it until the port answers.
  let submitted: string
  try {
    await deps.submitCommand(`/nexus dashboard ${port} ${host}`)
    submitted = `/nexus dashboard ${port} ${host}`
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    deps.showToast({
      title: "Nexus Web Dashboard — could not start",
      message: [
        `The dashboard start command never reached the OpenCode server: ${detail}`,
        "",
        "No server is listening on that port and no browser was opened.",
        "The dashboard runs in the server process, so this needs the server's",
        "HTTP endpoint to be reachable from the TUI.",
      ].join("\n"),
      variant: "error",
      duration: 15000,
    })
    return
  }

  const wait = deps.waitImpl ?? defaultWait
  const attempts = deps.confirmAttempts ?? LISTEN_CONFIRM_ATTEMPTS
  const intervalMs = deps.confirmIntervalMs ?? LISTEN_CONFIRM_INTERVAL_MS

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await wait(intervalMs)
    // A refusal here is the ordinary "not up yet" answer, so the loop asks
    // again; anything else is a real transport problem and is reported as one
    // rather than retried into a generic timeout.
    const check = await probeDashboard(host, port, deps.fetchImpl)
    if (check.isNexusDashboard) {
      await deps.openBrowser(url)
      deps.showToast({
        title: "⚡ Nexus Web Dashboard",
        message: `Started and opened ${url} — a dashboard is serving there now.`,
        variant: "success",
        duration: 8000,
      })
      return
    }
  }

  deps.showToast({
    title: "Nexus Web Dashboard — not started",
    message: [
      `Ran \`${submitted}\`, but nothing is serving on ${host}:${port} after ${Math.round((attempts * intervalMs) / 1000)}s,`,
      "so no browser was opened and there is no URL to give you.",
      "",
      "The command runs in the OpenCode server process, which is the only place",
      "the dashboard can start. If a Nexus plugin is active in that process, its",
      `result is in this session as the reply to \`${submitted}\` — that text names`,
      "the reason (a port already in use, or `dashboard.enabled: false`). If no",
      "plugin is active there, the command was never handled at all. If the port",
      "is held by another process, free it or pass a different one:",
      "/nexus web 4748.",
    ].join("\n"),
    variant: "error",
    duration: 20000,
  })
}

/** Shell out to the desktop's URL handler. Best-effort, never throws. */
export async function openInBrowser(url: string): Promise<void> {
  try {
    const { exec } = await import("node:child_process")
    const command =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "start"
          : "xdg-open"
    exec(`${command} ${url}`)
  } catch {
    // No shell, or no handler. The toast already told the user the URL, so a
    // browser that refuses to open costs them nothing.
  }
}

// ── Model picker options ────────────────────────────────────────────
// Free functions for the same reason as the sidebar section above: the TUI
// entrypoint stays a thin adapter over the live context, and the option
// building is driven directly in tests instead of through a renderer.

// Category for the "Use default" row, which belongs to no provider.
//
// It is given a LABEL rather than left uncategorised because the host groups on
// `category ?? ""` and renders a header only for a non-empty key: an
// uncategorised row lands in its own visually-separate block with a blank gap
// where a header would be. A category is a label on a group, not a row, so
// unlike a header pseudo-row it cannot be selected and submitted as a model —
// which matters, because a bare provider id would pass the dialog and then
// fail `getModelForRole`'s prefix check and throw at spawn time.
const DEFAULT_MODEL_CATEGORY = "Defaults"

/** The `value` `setModel` reads back; falsy so a role can be reset to its default. */
const USE_DEFAULT_VALUE = ""

/**
 * One row of the model picker.
 *
 * Structurally the host's `DialogSelectOption<string>`, declared locally for
 * the same reason as `SidebarSession` above: `@opencode/client` is not a
 * dependency of this package, and the two are assignable with no conversion.
 */
export interface ModelSelectOption {
  readonly title: string
  readonly value: string
  readonly description?: string
  readonly category?: string
}

/**
 * The picker's options: one per model, grouped by provider, plus the reset row.
 *
 * GROUPING IS DONE BY `category`, NEVER BY A HEADER ROW. The host computes
 * `groupBy(x => x.category ?? "")` over the FILTERED option list, so a category
 * tracks whatever survives the user's search and can never leave an orphaned
 * header; and because `category` is one of the fuzzy-finder's search keys
 * (`["title", "category", "searchText"]`, with only the title weighted double),
 * grouping makes the picker MORE searchable — typing "OpenCode Go" now matches
 * every model under it. This is the same pattern OpenCode's own model picker
 * uses, which sets `category: provider.name` on every row.
 *
 * ── WHERE THAT SEARCH-KEY CLAIM COMES FROM ──
 *
 * Not from the host's types: `@opencode/plugin` publishes nothing about search
 * keys, scoring or grouping, and its `context.js` is a 0-byte type shim, so there
 * is no declaration to read and the claim would otherwise be a comment asserting
 * a behavioural promise. It was verified against the INSTALLED CLI's own code —
 * the minified `dialog-select` implementation extracted from the bundle at
 * `~/.opencode/bin/opencode`, whose option build reads verbatim:
 *
 *   SA.go(G, j, {keys:["title","category","searchText"],
 *                scoreFn: r => r[0].score*2 + r[1].score + r[2].score})
 *
 * Three keys, three terms, title at weight 2 — which is the correction: an
 * earlier draft of this comment said two keys and two terms and was wrong, and a
 * comment that is wrong about a host internal is worse than no comment. That
 * bundle is a local build artifact and is NOT guaranteed to exist on CI or on
 * another machine, which is why the snippet is quoted here rather than merely
 * referenced: a reader who has the bundle can grep `SA.go` and check it, and a
 * reader who does not can at least see exactly what was claimed and against what.
 * Treat it as a snapshot of one installed version, not a stable contract — if
 * `category` ever stops being a key, the README's "searching matches the
 * heading" sentence becomes false and this is where to look first.
 *
 * ORDERING. Providers sort by display name, then models by title within their
 * provider. The contiguity is not cosmetic: the host groups by FIRST
 * APPEARANCE, so two providers' models interleaved in the array would render as
 * two separate "OpenCode" headers rather than one group. Sorting the provider
 * first is what makes one provider one block. `model.list()` order is
 * otherwise not meaningful to a user — it is the host's catalogue order — so
 * without this the grouped list would be grouped arbitrarily.
 *
 * `Use default` is appended last, in its own category: it is a real selectable
 * row whose value stays `""` because `setModel` relies on that empty string to
 * reset a role, and a trailing row is where a user looks for "reset".
 */
export function buildModelOptions(
  models: readonly GroupedModel[] | undefined,
  providers: readonly ProviderLabelSource[] | undefined
): readonly ModelSelectOption[] {
  const label = providerLabels(providers)

  const options = (models ?? []).map(model => {
    const category = label(model.providerID)
    return {
      title: model.name || model.id,
      // The submitted value. Unchanged by grouping, and the one string in this
      // function that must never drift: it is what `getModelForRole` and
      // `spawnAgent` prefix-check, and a regression here is invisible until a
      // spawn throws.
      value: modelRef(model.providerID, model.id),
      description: formatModelPrice(model.cost),
      // No provider to name leaves the row uncategorised rather than inventing
      // a group for it.
      ...(category === undefined ? {} : { category })
    }
  })

  // Provider first, then title. Sorting a COPY, so the caller's array is not
  // reordered in place.
  const grouped = [...options].sort((a, b) =>
    (a.category ?? "").localeCompare(b.category ?? "") || a.title.localeCompare(b.title)
  )

  return [
    ...grouped,
    {
      title: "Use default",
      value: USE_DEFAULT_VALUE,
      description: "Reset to default model",
      category: DEFAULT_MODEL_CATEGORY
    }
  ]
}

/**
 * Provider display names, memoised per project directory for the life of the
 * process.
 *
 * `context.data.location.provider` is a `LocationCollection<ProviderInfo>`, the
 * same shape as `model`: `list()` is `undefined` until something syncs it, and
 * `sync()` is a round trip. So the picker has to sync providers too — but
 * `handleFullConfig` opens it once per role, and that is six syncs in a row for
 * a set of names that cannot have changed between them.
 *
 * WHAT STALENESS THIS SERVES, precisely: a provider added, removed or RENAMED
 * while the TUI is running keeps its old header until the process restarts. That
 * needs a config edit or an `auth login` in the same live session. The
 * consequence is a header reading `opencode-go` instead of `OpenCode Go`, or a
 * group of models under a raw id — a degraded LABEL on rows that are otherwise
 * correct, because a model the memo has never heard of still resolves through
 * `providerLabels`' raw-id fallback. No model is ever missing and no value is
 * ever wrong, which is why this is worth a memo and a stale label is not worth
 * a round trip per role.
 *
 * Keyed by directory because the provider set is per-project: a TUI that moves
 * between worktrees must not reuse another directory's names.
 */
let providerNames: { readonly directory: string; readonly names: readonly ProviderLabelSource[] } | undefined

/**
 * Providers for `location`, synced at most once per directory.
 *
 * EXPORTED so the wiring feeding `buildModelOptions` is testable, not just the
 * pure function it feeds. `buildModelOptions` had thorough coverage while the
 * memo, the `sync` round trip and the per-directory key underneath it had none,
 * which meant the whole picker-opening path was unverified: a regression here
 * would have shown up as a picker that opens with raw-id headings and no failing
 * test. Tests get isolation by passing a distinct directory per case, which is
 * the memo's own key — no reset hook, and therefore no export that exists only
 * for a test to reach.
 *
 * FAILURE COSTS A HEADING, NOT THE DIALOG. This is the second reason it is
 * guarded: `handleModelSelect` awaits this before building a single option, and
 * an older host with no `data.location.provider`, or a `sync` that rejects, used
 * to throw straight out of `handleModelSelect` and the picker would not open at
 * all. Before provider grouping existed, that function touched only
 * `data.location.model`, so this is a new failure mode bolted onto a path that
 * previously worked — and provider NAMES are a nicety. Every failure returns
 * `undefined`, which `providerLabels` turns into raw-id headings: a cosmetically
 * worse picker about the same models, never a missing one. Same pattern the
 * server path uses (`getCostReport` degrades, it does not throw).
 *
 * A failure is NOT memoised. The cache is only written on a successful sync, so
 * a transient rejection costs one extra round trip on the next open rather than
 * pinning the picker to raw ids for the life of the process.
 *
 * `providers` is the host's `LocationCollection<ProviderInfo>`, narrowed
 * structurally: `@opencode/client` is not a dependency of this package.
 */
export async function providerNamesFor(
  location: { readonly directory?: string } | undefined,
  providers:
    | {
        list(location?: unknown): readonly ProviderLabelSource[] | undefined
        sync(location?: unknown): Promise<void>
      }
    | undefined,
): Promise<readonly ProviderLabelSource[] | undefined> {
  const directory = location?.directory ?? ""
  if (providerNames?.directory === directory) return providerNames.names
  if (!providers) return undefined
  try {
    await providers.sync(location)
    const names = providers.list(location) ?? []
    providerNames = { directory, names }
    return names
  } catch {
    // Names are a nicety; the models are the picker.
    return undefined
  }
}

export default Plugin.define({
  id: "nexus.cli",
  setup(context) {
    const configManager = new NexusConfigManager()
    // Load config from disk so TUI shows actual project/global config values
    try {
      const loc = context.location ?? context.data.location.default()
      if (loc?.directory) {
        configManager.loadFromPath(loc.directory)
      }
    } catch {
      // If we can't determine project dir, continue with defaults
    }

    // Model selection handler
    // Persistent save scope for the config session
    let configSaveScope: 'project' | 'global' = 'global'

    const handleModelSelect = async (role: string) => {
      if (!configManager.getRoles().includes(role)) {
        context.ui.toast.show({
          title: "Nexus",
          message: `Unknown role: ${role}. Valid: ${configManager.getRoles().join(', ')}`,
          variant: "error"
        })
        return
      }

      const location = context.location ?? context.data.location.default()
      await context.data.location.model.sync(location)
      const availableModels = context.data.location.model.list(location) ?? []

      const options = buildModelOptions(
        availableModels,
        await providerNamesFor(location, context.data.location?.provider)
      )

      const current = configManager.getModelForRole(role)
      const selected = await context.ui.dialog.select({
        title: `${configManager.getRoleDisplayName(role)} Model`,
        current: current || "",
        options
      })

      if (selected !== null && selected !== undefined) {
        configManager.setModel(role, selected)
        persistConfig()
      }
    }

    // Persist config to the selected scope
    const persistConfig = () => {
      if (configSaveScope === 'project') {
        configManager.saveProjectConfig(process.cwd())
      } else {
        configManager.saveGlobalConfig()
      }
    }

    // Config dialog handler
    const handleConfigDialog = async () => {
      const config = configManager.getConfig()
      const budgetStr = await context.ui.dialog.prompt({
        title: "Max Total Budget ($)",
        placeholder: String(config.budget.maxTotalCost)
      })
      if (budgetStr !== null && budgetStr !== undefined) {
        const budget = parseFloat(budgetStr)
        if (!isNaN(budget) && budget > 0) {
          configManager.updateStorageConfig({
            budget: { ...config.budget, maxTotalCost: budget }
          })
          persistConfig()
          context.ui.toast.show({
            title: "Nexus",
            message: `Budget updated: $${budget}`,
            variant: "success"
          })
        }
      }
    }

    // All-in-one config handler
    const handleFullConfig = async () => {
      // Ask scope once at the beginning
      const scope = await context.ui.dialog.select({
        title: "Where to save config?",
        options: [
          { title: "📁 Project (.opencode/)", value: "project", description: "This project only" },
          { title: "🌍 Global (~/.config/opencode/)", value: "global", description: "All projects" }
        ]
      })
      configSaveScope = (scope === 'project' ? 'project' : 'global') as 'project' | 'global'

      for (const role of configManager.getRoles()) {
        await handleModelSelect(role)
      }
      await handleConfigDialog()
      context.ui.toast.show({
        title: "Nexus",
        message: `Configuration complete! (saved to ${configSaveScope === 'project' ? '.opencode/' : '~/.config/opencode/'})`,
        variant: "success"
      })
    }

    // The session a command submitted from the TUI has to land in: the one the
    // user is looking at. The route is the authority — it is what the TUI is
    // showing — with the active tab as the fallback for the home screen, where
    // there is no session route but there is still a session to submit to.
    const activeSessionID = (): string | undefined => {
      const route = context.ui.router.current()
      if (route.type === "session") return route.sessionID
      return context.ui.tabs.list().find(tab => tab.active)?.sessionID
    }

    /**
     * Hand a `/nexus …` command to the OpenCode server, which is the process
     * that owns the orchestrator. This is the whole reason `/nexus dashboard`
     * can start the server: the TUI cannot, and the server's prompt hook routes
     * the text to `orchestrator.handleCommand`.
     *
     * Throws on a missing session so the caller can say "the command never
     * reached the server" rather than reporting a start that never happened.
     */
    const submitServerCommand = async (text: string) => {
      const sessionID = activeSessionID()
      if (!sessionID) {
        throw new Error("no session is open to run the command in")
      }
      await context.client.session.prompt({ sessionID, text })
    }

    // Web dashboard handler - starts the server through the server process, and
    // opens a browser only against a confirmed listen. See the note above
    // `handleWebDashboard` for why the TUI cannot start the server itself and
    // what it uses instead. The address it probes comes from the SAME config
    // the start gate reads, so the TUI and the tool agree on the port, the
    // host, and whether the dashboard is switched off at all.
    const runWebDashboard = async (input?: string) => {
      await handleWebDashboard(input, {
        dashboard: configManager.getConfig().dashboard,
        showToast: options => context.ui.toast.show(options),
        openBrowser: openInBrowser,
        submitCommand: submitServerCommand,
      })
    }

    // Config summary handler.
    //
    // Renamed twice over, and both renames are the same fix. It used to be
    // `handleDashboard` printing a config summary, and calling that a
    // "Dashboard" was the old `web` behaviour one layer over — a user who runs
    // it expecting a window has been told the feature exists when it has not
    // been invoked. It is `handleOverview` now, and `/nexus dashboard` is spent
    // on the command that starts one, because a name that means two things
    // resolves to whichever the user happened to try first.
    const handleOverview = async () => {
      const config = configManager.getConfig()
      const lines = [
        "⚡ Nexus Overview",
        "═══════════════════════════════════",
        "",
        "🤖 Agent Models:",
      ]

      for (const role of configManager.getRoles()) {
        const model = config.models[role] || '(not set)'
        const displayName = configManager.getRoleDisplayName(role)
        lines.push(`  ${displayName}: ${model}`)
      }

      lines.push("")
      lines.push("💰 Budget:")
      lines.push(`  Max Total: $${config.budget.maxTotalCost}`)
      lines.push(`  Max Per Task: $${config.budget.maxCostPerTask}`)
      lines.push(`  Alert Threshold: ${config.budget.alertThreshold * 100}%`)
      lines.push("")
      lines.push("🛡️ Self-Healing:")
      lines.push(`  Enabled: ${config.selfHealing.enabled ? '✅' : '❌'}`)
      lines.push(`  Max Retries: ${config.selfHealing.maxRetries}`)
      lines.push("")
      lines.push("💡 Commands:")
      lines.push("  /nexus status   - Show config summary")
      lines.push("  /nexus config   - Configure models & budget")
      lines.push("  /nexus model    - Select model for role")
      lines.push("  /nexus dashboard - Start the web dashboard and open it")
      lines.push("  /nexus web      - Same: start it if needed, then open it")
      lines.push("  /nexus overview - Show this overview")
      lines.push("  /nexus reset    - Reset to defaults")
      lines.push("")
      lines.push("🔧 Tools (use in agent prompt):")
      lines.push("  nexus.status    - Orchestrator status")
      lines.push("  nexus.agents    - List spawned agents")
      lines.push("  nexus.costs     - Cost report")
      lines.push("  nexus.spawn     - Spawn a sub-agent")
      lines.push("  nexus.dashboard.start - Start the web dashboard server")
      lines.push("")
      lines.push("📊 Web Dashboard:")
      lines.push(`  Enabled: ${config.dashboard.enabled ? '✅' : '❌'}`)
      lines.push(`  Address: http://${config.dashboard.host}:${config.dashboard.port} (when running)`)
      lines.push("  Not running? /nexus dashboard starts it and opens it.")

      context.ui.toast.show({
        title: "Nexus Overview",
        message: lines.join('\n'),
        variant: "info",
        duration: 15000
      })
    }

    // Keymap layer - registered in slot render via closure
    context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          priority: 10,
          commands: [
            {
              id: "nexus",
              title: "Nexus Configuration",
              group: "Nexus",
              bind: "ctrl+n",
              palette: true,
              slash: { name: "nexus", aliases: [], arguments: true },
              enabled: () => true,
              suggested: true,
              run: async (input?: string) => {
                if (input) {
                  const parts = input.split(' ')
                  const cmd = parts[0]
                  switch (cmd) {
                    case 'config':
                    case 'c':
                      await handleFullConfig()
                      break
                    case 'status':
                    case 's':
                      context.ui.toast.show({
                        title: "Nexus Status",
                        message: configManager.getSummary(),
                        variant: "info",
                        duration: 8000
                      })
                      break
                    case 'dashboard':
                    case 'd':
                      // Start it and open it. The start is the server's; see
                      // `handleWebDashboard`.
                      await runWebDashboard(parts.slice(1).join(' '))
                      break
                    case 'overview':
                      await handleOverview()
                      break
                    case 'web':
                    case 'w':
                      // A delegate, not a second implementation. `/nexus web
                      // [port] [host]`, `/nexus dashboard [port] [host]` and the
                      // palette commands used to be code paths that disagreed
                      // — one shelled out to `open`, another only showed a
                      // toast, and none started anything. One behaviour, one
                      // place.
                      await runWebDashboard(parts.slice(1).join(' '))
                      break
                    case 'model':
                    case 'm':
                      if (parts[1]) {
                        await handleModelSelect(parts[1])
                      } else {
                        const role = await context.ui.dialog.select({
                          title: "Select Agent Role",
                          options: configManager.getRoles().map(r => ({
                            title: configManager.getRoleDisplayName(r),
                            value: r,
                            description: `Current: ${configManager.getModelForRole(r)}`
                          }))
                        })
                        if (role) {
                          await handleModelSelect(role)
                        }
                      }
                      break
                    case 'reset':
                      const confirmed = await context.ui.dialog.confirm({
                        title: "Reset Configuration",
                        message: "Reset all Nexus settings to defaults?",
                        label: { confirm: "Reset", cancel: "Cancel" }
                      })
                      if (confirmed) {
                        configManager.resetToDefaults()
                        context.ui.toast.show({
                          title: "Nexus",
                          message: "Configuration reset to defaults",
                          variant: "success"
                        })
                      }
                      break
                    default:
                      context.ui.toast.show({
                        title: "Nexus",
                        message: "Commands: config, status, dashboard [port], web [port], overview, model <role>, reset",
                        variant: "info"
                      })
                  }
                } else {
                  await handleFullConfig()
                }
              }
            },
            {
              id: "nexus.config",
              title: "Nexus Configuration",
              group: "Nexus",
              palette: true,
              slash: { name: "nexus-config", aliases: ["nc"], arguments: true },
              enabled: () => true,
              suggested: true,
              run: async () => {
                await handleFullConfig()
              }
            },
            {
              id: "nexus.overview",
              title: "Nexus Overview (config, budget, dashboard status)",
              group: "Nexus",
              palette: true,
              slash: { name: "nexus-overview", aliases: ["no"], arguments: true },
              enabled: () => true,
              suggested: true,
              run: async () => {
                await handleOverview()
              }
            },
            {
              id: "nexus.dashboard",
              title: "Start the Nexus Web Dashboard",
              description: "Starts the dashboard server if it is not already running, then opens it in your browser",
              group: "Nexus",
              palette: true,
              slash: { name: "nexus-dashboard", aliases: ["nd"], arguments: true },
              enabled: () => true,
              suggested: true,
              run: async (input?: string) => {
                await runWebDashboard(input)
              }
            },
            {
              id: "nexus.web",
              title: "Open the Nexus Web Dashboard",
              description: "Alias of Nexus Dashboard: starts it if needed, then opens it in your browser",
              group: "Nexus",
              palette: true,
              slash: { name: "nexus-web", aliases: ["nw"], arguments: true },
              enabled: () => true,
              suggested: true,
              run: async (input?: string) => {
                await runWebDashboard(input)
              }
            },
            {
              id: "nexus.model",
              title: "Select Agent Model",
              group: "Nexus",
              palette: true,
              slash: { name: "nexus-model", aliases: ["nm"], arguments: true },
              enabled: () => true,
              suggested: true,
              run: async (input?: string) => {
                if (input) {
                  await handleModelSelect(input)
                } else {
                  const role = await context.ui.dialog.select({
                    title: "Select Agent Role",
                    options: configManager.getRoles().map(r => ({
                      title: configManager.getRoleDisplayName(r),
                      value: r,
                      description: `Current: ${configManager.getModelForRole(r)}`
                    }))
                  })
                  if (role) {
                    await handleModelSelect(role)
                  }
                }
              }
            },
            {
              id: "nexus.status",
              title: "Nexus Status",
              group: "Nexus",
              palette: true,
              slash: { name: "nexus-status", aliases: ["ns"], arguments: true },
              enabled: () => true,
              suggested: true,
              run: async () => {
                context.ui.toast.show({
                  title: "Nexus Status",
                  message: configManager.getSummary(),
                  variant: "info",
                  duration: 8000
                })
              }
            },
            {
              id: "nexus.reset",
              title: "Reset Nexus Config",
              group: "Nexus",
              palette: true,
              slash: { name: "nexus-reset", aliases: [], arguments: true },
              enabled: () => true,
              run: async () => {
                const confirmed = await context.ui.dialog.confirm({
                  title: "Reset Configuration",
                  message: "Reset all Nexus settings to defaults?",
                  label: { confirm: "Reset", cancel: "Cancel" }
                })
                if (confirmed) {
                  configManager.resetToDefaults()
                  context.ui.toast.show({
                    title: "Nexus",
                    message: "Configuration reset to defaults",
                    variant: "success"
                  })
                }
              }
            }
          ],
          bindings: ["nexus"]
        }))
        return <></>
      }
    })

    // Welcome message
    context.ui.toast.show({
      title: "⚡ Nexus Loaded",
      message: "Type /nexus or Ctrl+N to configure",
      variant: "info",
      duration: 3000
    })

    // === Sidebar Agent Status ===
    // Durable storage for sidebar state (TUI's own state, not shared with server)
    const [sidebarState, setSidebarState] = context.storage.store<SidebarState>("nexus-sidebar-state", {
      initial: {
        agents: [],
        totalCost: 0,
        budgetRemaining: 10.00
      }
    })

    // Poll for child sessions — wrapped in try/catch to prevent sidebar crash
    let lastPollTime = 0
    const pollChildSessions = () => {
      try {
        const now = Date.now()
        if (now - lastPollTime < 2000) return
        lastPollTime = now

        const currentRoute = context.ui.router.current()
        if (!currentRoute || currentRoute.type !== "session") return

        const currentSessionID = currentRoute.sessionID
        if (!currentSessionID) return

        const source: SidebarSessionSource = context.data.session
        const childIDs = sidebarChildSessionIDs(
          source.family(currentSessionID),
          currentSessionID
        )

        // No children at all: keep only the finished ones as history.
        if (childIDs.length === 0) {
          setSidebarState((draft) => {
            draft.agents = mergeSidebarAgents(draft.agents, [], [])
          })
          return
        }

        const newAgents = collectSidebarAgents(
          source,
          currentSessionID,
          id => (context.data.session.status(id) === 'running' ? 'working' : 'completed'),
          new Date().toISOString()
        )

        // Every child was unreadable — leave the sidebar as it is.
        if (newAgents.length === 0) return

        setSidebarState((draft) => {
          draft.agents = mergeSidebarAgents(draft.agents, newAgents, childIDs)
        })
      } catch {
        // poll must never crash the sidebar
      }
    }

    // Subscribe to session execution events — wrapped in try/catch
    const unsubSessionSucceeded = context.data.on("session.execution.succeeded", (event) => {
      try {
        const sessionId = event.data.sessionID
        setSidebarState((draft) => {
          const agent = draft.agents.find(a => a.sessionID === sessionId)
          if (agent) {
            agent.status = 'completed'
            agent.tasksCompleted++
          }
        })
      } catch {}
    })

    const unsubSessionFailed = context.data.on("session.execution.failed", (event) => {
      try {
        const sessionId = event.data.sessionID
        setSidebarState((draft) => {
          const agent = draft.agents.find(a => a.sessionID === sessionId)
          if (agent) {
            agent.status = 'failed'
            agent.tasksFailed++
          }
        })
      } catch {}
    })

    const unsubSessionCreated = context.data.on("session.created", (event) => {
      try {
        setTimeout(pollChildSessions, 100)
      } catch {}
    })

    // Register sidebar content slot
    const unsubSidebar = context.ui.slot({
      append: "sidebar.content",
      render: (props) => {
        try {
          pollChildSessions()
        } catch {
          // poll must never crash the sidebar
        }

        const agents = sidebarState.agents
        if (!agents || agents.length === 0) return null

        try {
          const activeAgents = agents.filter(a => a.status === 'working' || a.status === 'idle')
          const completedAgents = agents.filter(a => a.status === 'completed')
          const failedAgents = agents.filter(a => a.status === 'failed')

          return (
            <box padding={1} marginTop={1}>
              {/* Header */}
              <box>
                <text>🤖 Nexus Agents — {activeAgents.length} active</text>
              </box>

              {/* Active Agents */}
              {activeAgents.map(agent => (
                <box>
                  <text fg={agent.status === 'working' ? '#4ade80' : '#94a3b8'}>
                    {agent.status === 'working' ? '🔄' : '⏸️'} {agent.name}
                    {agent.model ? ` — ${agent.model.split('/').pop()}` : ''}
                  </text>
                </box>
              ))}

              {/* Completed Agents */}
              {completedAgents.length > 0 && (
                <box marginTop={1}>
                  <text fg="#666">✅ {completedAgents.length} completed</text>
                </box>
              )}

              {/* Failed Agents */}
              {failedAgents.length > 0 && (
                <box marginTop={1}>
                  <text fg="#ef4444">❌ {failedAgents.length} failed</text>
                </box>
              )}

              {/* Cost Summary */}
              {sidebarState.totalCost > 0 && (
                <box marginTop={1}>
                  <text fg="#666">💰 ${sidebarState.totalCost.toFixed(4)} / ${sidebarState.budgetRemaining.toFixed(2)} remaining</text>
                </box>
              )}
            </box>
          )
        } catch (err) {
          // Log the real error so we can diagnose why JSX failed
          console.error("[nexus] sidebar render error:", err)
          try {
            context.ui.toast.show({
              title: "Nexus Sidebar Error",
              message: err instanceof Error ? err.message : String(err),
              variant: "error",
              duration: 5000
            })
          } catch {}
          return null
        }
      }
    })

    return () => {
      unsubSessionSucceeded()
      unsubSessionFailed()
      unsubSessionCreated()
      unsubSidebar()
    }
  }
})
