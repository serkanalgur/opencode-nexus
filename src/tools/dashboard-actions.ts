import { NexusOrchestrator } from "../orchestrator"
import { describeDashboardStart, startDashboardServer } from "../dashboard"

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
