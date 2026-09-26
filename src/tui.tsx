/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { NexusConfigManager } from "./config"

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
// rather than a limitation to apologise for: it cannot start the server.
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

/** The address a `/nexus web [port] [host]` argument resolves to. */
export interface WebDashboardTarget {
  port: number
  host: string
}

/**
 * Parse a `/nexus web` argument against the configured defaults.
 *
 * Accepts a bare port, `port host`, or nothing. Returns an error string rather
 * than a coerced number for an unparseable port: `parseInt("abc")` is `NaN`,
 * and `NaN` used to reach a URL as the literal text `NaN`, which is a
 * connection failure whose cause is invisible in the address that failed.
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

/** What the TUI needs from its host to run the `web` command. */
export interface WebDashboardDeps {
  /** The configured dashboard block — the same one the start gate reads. */
  dashboard: { enabled: boolean; port: number; host: string }
  showToast(options: { title: string; message: string; variant: "info" | "success" | "warning" | "error"; duration?: number }): void
  openBrowser(url: string): Promise<void> | void
  fetchImpl?: typeof fetch
}

/**
 * The one implementation behind both `/nexus web` entry points.
 *
 * Never opens a browser at an address it has not confirmed is serving a nexus
 * dashboard. The three refusals are all deliberate, and each says which of them
 * happened:
 *
 * 1. disabled by config — nothing will ever listen, so say which key says so
 *    and stop, rather than probing a port the user has switched off.
 * 2. something else on the port — a bind would fail, and opening a browser at
 *    the other process's page would be a worse answer than a clear error.
 * 3. nothing on the port — the ordinary case, and the one this command exists
 *    for: point the user at the single tool call that does work.
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
      message: `Opened ${url} — a dashboard is already running there.`,
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

  deps.showToast({
    title: "⚡ Nexus Web Dashboard",
    message: [
      `No dashboard is running on ${url} (${probe.detail}), and no browser was opened.`,
      "",
      "The dashboard server cannot be started from the TUI: it runs in the OpenCode",
      "server process, next to the orchestrator that feeds it, and the TUI has no",
      "handle on either. So start it from the agent — this is the one call:",
      "",
      `  nexus.dashboard.start(port=${port}, host="${host}")`,
      "",
      `Then re-run /nexus web and it will open ${url} for you.`,
    ].join("\n"),
    variant: "info",
    duration: 15000,
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

      const options = availableModels.map((m: any) => ({
        title: m.name || m.id,
        value: `${m.providerID}/${m.id}`,
        description: m.providerID
      }))

      options.push({
        title: "Use default",
        value: "",
        description: "Reset to default model"
      })

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

    // Web dashboard handler - probes, and opens a browser only against a
    // confirmed dashboard. See the note above `handleWebDashboard` for why the
    // TUI cannot start the server itself. The address it probes comes from the
    // SAME config the start gate reads, so the TUI and the tool agree on the
    // port, the host, and whether the dashboard is switched off at all.
    const runWebDashboard = async (input?: string) => {
      await handleWebDashboard(input, {
        dashboard: configManager.getConfig().dashboard,
        showToast: options => context.ui.toast.show(options),
        openBrowser: openInBrowser,
      })
    }

    // Config summary handler.
    //
    // Renamed from `handleDashboard`, and the toast title with it: it prints
    // the resolved config, and nothing about it starts, serves or connects to a
    // dashboard. Calling that a "Dashboard" is the same false promise as the
    // old `web` behaviour, one layer over — a user who runs it expecting a
    // window has been told the feature exists when it has not been invoked.
    const handleDashboard = async () => {
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
      lines.push("  /nexus web      - Open the web dashboard, if one is running")
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
      lines.push("  Not running? Ask the agent for nexus.dashboard.start, then /nexus web.")

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
                      await handleDashboard()
                      break
                    case 'web':
                    case 'w':
                      // A delegate, not a second implementation. `/nexus web
                      // [port] [host]` and the `/nexus-web` palette command used
                      // to be two code paths that disagreed — this one shelled
                      // out to `open` and the other only showed a toast, and
                      // neither started anything. One behaviour, one place.
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
                        message: "Commands: config, status, dashboard, web [port], model <role>, reset",
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
              id: "nexus.dashboard",
              title: "Nexus Overview (config, budget, dashboard status)",
              group: "Nexus",
              palette: true,
              slash: { name: "nexus-dashboard", aliases: ["nd"], arguments: true },
              enabled: () => true,
              suggested: true,
              run: async () => {
                await handleDashboard()
              }
            },
            {
              id: "nexus.web",
              title: "Open the Nexus Web Dashboard",
              description: "Open the dashboard in your browser if one is already serving; otherwise say how to start it",
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
