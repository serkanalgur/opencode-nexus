import type { NexusOrchestrator } from "./orchestrator"
// The SPA is inlined into the bundle as text rather than read from disk at
// request time. The published tarball ships `dist/` only, so a filesystem
// lookup here resolves against the *consumer's* working directory and fails on
// every install — that was the bug this import removes.
//
// `bun-types` types `*.html` as an HTMLBundle (its *html* loader), but the
// `type: "text"` import attribute selects the text loader at both build and
// run time, which yields a plain string. The assertion below is the single
// place that reconciles the two.
import spaHtmlImport from "../dashboard/index.html" with { type: "text" }

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  })
}

function htmlResponse(html: string): Response {
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...CORS_HEADERS,
    },
  })
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The inlined SPA, validated and memoised on first use rather than at import
 * time, so a broken build can never take down a consumer that never starts the
 * dashboard.
 */
let cachedSpaHtml: string | null = null

function getSpaHtml(): string {
  if (cachedSpaHtml !== null) return cachedSpaHtml
  // If the loader ever stops yielding a string (a mis-set loader, a build
  // flag change), the page would render blank with no error anywhere. Fail
  // loudly at the one place a human will actually read it.
  // Widened to `unknown` first: `bun-types` types `*.html` as an HTMLBundle, so
  // the compiler would narrow the import to `never` inside a string guard.
  const inlined: unknown = spaHtmlImport
  if (typeof inlined !== "string" || inlined.length === 0) {
    throw new Error(
      "Dashboard HTML was not inlined into the bundle — the text loader for dashboard/index.html did not run",
    )
  }
  cachedSpaHtml = inlined
  return cachedSpaHtml
}

type ApiHandler = (orchestrator: NexusOrchestrator) => unknown

/**
 * REST routes. A Map rather than an object literal so that `/api/constructor`
 * and friends cannot resolve to something inherited from `Object.prototype`.
 */
const API_ROUTES = new Map<string, ApiHandler>([
  ["/api/state", (o) => o.getState()],
  ["/api/config", (o) => o.configManager.exportConfig()],
  ["/api/agents", (o) => o.getState().agents],
  // `getCostReport()` returns a *string* of JSON. Serialising it again would
  // hand the client a double-encoded JSON string; parse it first so callers
  // get an object.
  [
    "/api/costs",
    (o) => {
      const parsed: unknown = JSON.parse(o.getCostReport())
      if (parsed === null || typeof parsed !== "object") {
        throw new Error("Cost report did not parse to an object")
      }
      return parsed
    },
  ],
  ["/api/health", () => ({ ok: true, uptime: process.uptime() })],
])

/** Does this path address the API (as opposed to the SPA)? */
function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/")
}

function stateMessage(orchestrator: NexusOrchestrator): string {
  return JSON.stringify({
    type: "orchestrator:state",
    data: orchestrator.getState(),
    timestamp: new Date().toISOString(),
  })
}

export class DashboardModule {
  private server: ReturnType<typeof Bun.serve> | null = null
  private address: DashboardAddress | null = null
  private orchestrator: NexusOrchestrator

  constructor(orchestrator: NexusOrchestrator) {
    this.orchestrator = orchestrator
  }

  start(port: number, host: string): void {
    const self = this

    try {
      this.server = Bun.serve({
        port,
        hostname: host,

        fetch(req, server) {
          const url = new URL(req.url)

          // CORS preflight
          if (req.method === "OPTIONS") {
            return new Response(null, { headers: CORS_HEADERS })
          }

          // WebSocket upgrade
          if (url.pathname === "/ws/events") {
            if (server.upgrade(req, { data: {} })) return new Response(null)
            return new Response("WebSocket upgrade failed", { status: 500 })
          }

          // REST API endpoints. An unmatched /api/* path is a 404, not the SPA:
          // returning 200 HTML for a missing endpoint means no client can ever
          // fail loudly about a missing route.
          if (isApiPath(url.pathname)) {
            const handler = API_ROUTES.get(url.pathname)
            if (!handler) {
              return jsonResponse(
                { error: "Not found", path: url.pathname },
                404,
              )
            }
            try {
              return jsonResponse(handler(self.orchestrator))
            } catch (err) {
              return jsonResponse(
                {
                  error: `Failed to build response for ${url.pathname}`,
                  detail: errorMessage(err),
                },
                500,
              )
            }
          }

          // SPA fallback. Deliberate, not the accidental fallthrough of the
          // API block: the dashboard is a single-page app that owns its own
          // routing, so any non-API path is the app shell.
          try {
            return htmlResponse(getSpaHtml())
          } catch (err) {
            return jsonResponse(
              {
                error: "Dashboard bundle is broken",
                detail: errorMessage(err),
              },
              500,
            )
          }
        },

        websocket: {
          open(ws) {
            // The broadcaster owns the client set and the throttled pushes; it
            // is the authoritative delivery mechanism. Registering there keeps
            // one client set and one message sequence instead of two
            // competing paths.
            const broadcaster = self.orchestrator.broadcaster
            broadcaster?.addClient(ws)

            // `addClient()` already sends the current state, so this snapshot
            // is only for the case where no broadcaster is wired (it is
            // optional and initialised elsewhere). The two are mutually
            // exclusive — with a broadcaster present the client still receives
            // exactly one connect-time snapshot.
            if (!broadcaster) ws.send(stateMessage(self.orchestrator))
          },
          message(ws, message) {
            // `ping` and the page's `getState` poll. The broadcaster's throttled
            // push is authoritative for *changes*; this request/reply path
            // answers an explicit ask, which no push can do on its own.
            try {
              const msg = JSON.parse(
                typeof message === "string" ? message : message.toString(),
              ) as { type?: string }
              if (msg.type === "ping") {
                ws.send(
                  JSON.stringify({
                    type: "pong",
                    timestamp: new Date().toISOString(),
                  }),
                )
              } else if (msg.type === "getState") {
                ws.send(stateMessage(self.orchestrator))
              }
            } catch {
              // Ignore malformed messages
            }
          },
          close(ws) {
            self.orchestrator.broadcaster?.removeClient(ws)
          },
        },
      })

      // Recorded only on success, from the arguments actually bound rather
      // than from a later config read, so `getAddress()` cannot name an
      // address this server is not serving.
      this.address = { host, port, url: `http://${host}:${port}` }

      console.log(
        `[nexus] Dashboard server running at http://${host}:${port}`
      )
    } catch (err: unknown) {
      this.server = null
      this.address = null
      const detail = errorMessage(err)
      console.error(`[nexus] Failed to start dashboard on ${host}:${port}: ${detail}`)
      throw new Error(`Dashboard failed to start on port ${port}: ${detail}`)
    }
  }

  stop(): void {
    if (this.server) {
      this.server.stop()
      this.server = null
    }
    this.address = null
  }

  /**
   * Where this server is actually serving, or `null` when it is not serving.
   *
   * The distinction matters because a `DashboardModule` used to outlive a
   * failed bind: `startDashboard()` left a null-server module reachable through
   * `orchestrator.dashboard`, so anything asking "is the dashboard up?" was
   * asking the wrong object. Reading the address rather than the module's
   * existence keeps both questions — "up?" and "where?" — on one answer.
   */
  getAddress(): DashboardAddress | null {
    return this.server ? this.address : null
  }

  getClientCount(): number {
    return this.orchestrator.broadcaster?.getClientCount() ?? 0
  }

  isRunning(): boolean {
    return this.server !== null
  }
}

// ── Starting, and saying what happened ─────────────────────────────
// One implementation behind all three entry points — the `dashboard.start`
// tool, `handleCommand("/nexus dashboard …")`, and therefore the TUI command
// that submits that text to the server. Three of them used to be three
// behaviours, and a caller that got the wording from one and the start from
// another would report a bind failure as a success.
//
// The `DashboardAddress` in an outcome is the address the server BOUND, not the
// one it was asked for, and it is absent from `refused` on purpose: a URL in a
// failure message is the one thing this path must never print, because it is
// indistinguishable from a working one to whoever reads it next.

/** An address the dashboard is or would be served on. */
export interface DashboardAddress {
  host: string
  port: number
  url: string
}

/** The address a `/nexus dashboard [port] [host]` argument resolves to. */
export interface DashboardTarget {
  port: number
  host: string
}

/**
 * Parse a `[port] [host]` argument against the configured defaults.
 *
 * Returns an error string rather than a coerced number for an unparseable
 * port: `parseInt("abc")` is `NaN`, and `NaN` used to reach a URL as the
 * literal text `NaN` — a connection failure whose cause is invisible in the
 * address that failed.
 */
export function parseDashboardTarget(
  input: string | undefined,
  fallback: DashboardTarget,
): { target: DashboardTarget } | { error: string } {
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
 * What a start attempt actually did.
 *
 * `already-running` is a first-class outcome rather than an error because a
 * second start is a normal thing for a user to ask for and an error-shaped
 * answer ("port in use") describes a situation that does not exist: the port is
 * in use *by us*.
 */
export type DashboardStartOutcome =
  | ({ kind: "started" } | { kind: "already-running" }) & DashboardAddress
  | { kind: "refused"; detail: string }

/**
 * Start the dashboard, or report why it did not start. Never throws.
 *
 * A throw is the wrong channel for a refused bind: this runs behind a command
 * handler and a prompt hook, and an unhandled throw out of either is a crash
 * of the thing the user was doing instead of a message about the dashboard.
 */
export function startDashboardServer(
  orchestrator: NexusOrchestrator,
  port?: number,
  host?: string,
): DashboardStartOutcome {
  const running = orchestrator.dashboard?.getAddress() ?? null
  if (running) {
    return { kind: "already-running", ...running }
  }

  try {
    orchestrator.startDashboard(port, host)
  } catch (error: unknown) {
    return { kind: "refused", detail: error instanceof Error ? error.message : String(error) }
  }

  // Read the bound address back off the module rather than echoing the
  // arguments: the arguments are optional, and the answer that matters is the
  // one the server actually bound to. A start that reported success with no
  // address would leave the caller nothing to open.
  const address = orchestrator.dashboard?.getAddress() ?? null
  if (!address) {
    return { kind: "refused", detail: "the dashboard reported a start but is not serving any address" }
  }
  return { kind: "started", ...address }
}

/**
 * The text every caller gets for a start attempt, so the tool, the command and
 * the TUI cannot disagree about what happened.
 *
 * The two failure rules are load-bearing and are the reason this is a single
 * function rather than a format string at each call site: a failure must not
 * contain a URL, and must say no browser was opened. This code path never opens
 * one — the TUI does, and only after it has confirmed the listen itself.
 */
export function describeDashboardStart(outcome: DashboardStartOutcome): string {
  if (outcome.kind === "refused") {
    return `Dashboard NOT started: ${outcome.detail}\n`
      + `No server is listening and no browser was opened. `
      + `If the port is in use, either stop whatever holds it or pass a different \`port\`. `
      + `Call again once the port is free — the dashboard does not retry on its own.`
  }

  if (outcome.kind === "already-running") {
    return `A dashboard is already running at ${outcome.url} — nothing was started a second time.\n`
      + `That server keeps serving until it is stopped, so open that exact URL to use it. `
      + `Call \`nexus.dashboard.stop\` first if you want it on a different port.`
  }

  return `Dashboard started at ${outcome.url}\n`
    + `Open that exact URL in a browser. The page connects to the same host and port for its live `
    + `state over WebSocket (ws://${outcome.host}:${outcome.port}/ws/events), so it works only while this `
    + `server runs. The TUI's \`/nexus-dashboard\` command opens the browser once this tool has succeeded.\n`
    + `Call \`nexus.dashboard.stop\` to shut it down.`
}
