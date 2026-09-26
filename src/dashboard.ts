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

      console.log(
        `[nexus] Dashboard server running at http://${host}:${port}`
      )
    } catch (err: unknown) {
      this.server = null
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
  }

  getClientCount(): number {
    return this.orchestrator.broadcaster?.getClientCount() ?? 0
  }

  isRunning(): boolean {
    return this.server !== null
  }
}
