import type { NexusOrchestrator } from "./orchestrator"

export interface DashboardServer {
  port: number
  host: string
  clients: Set<any>
}

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

export class DashboardModule {
  private server: ReturnType<typeof Bun.serve> | null = null
  private clients: Set<any> = new Set()
  private orchestrator: NexusOrchestrator

  constructor(orchestrator: NexusOrchestrator) {
    this.orchestrator = orchestrator
  }

  start(port: number, host: string): void {
    const self = this

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
          if (server.upgrade(req)) return new Response(null)
          return new Response("WebSocket upgrade failed", { status: 500 })
        }

        // REST API endpoints
        if (url.pathname === "/api/state") {
          return jsonResponse(self.orchestrator.getState())
        }

        if (url.pathname === "/api/config") {
          return jsonResponse(self.orchestrator.configManager.exportConfig())
        }

        if (url.pathname === "/api/agents") {
          const state = self.orchestrator.getState()
          return jsonResponse(state.agents)
        }

        if (url.pathname === "/api/costs") {
          return jsonResponse(self.orchestrator.getCostReport())
        }

        if (url.pathname === "/api/health") {
          return jsonResponse({ ok: true, uptime: process.uptime() })
        }

        // Default response
        return new Response("Nexus Dashboard API", {
          headers: {
            "Content-Type": "text/plain",
            ...CORS_HEADERS,
          },
        })
      },

      websocket: {
        open(ws: any) {
          self.clients.add(ws)
          // Send current state on connect
          ws.send(
            JSON.stringify({
              type: "orchestrator:state",
              data: self.orchestrator.getState(),
              timestamp: new Date().toISOString(),
            })
          )
        },
        message(ws: any, message: any) {
          // Handle client messages (ping/pong, subscribe)
          try {
            const msg = JSON.parse(
              typeof message === "string" ? message : message.toString()
            )
            if (msg.type === "ping") {
              ws.send(
                JSON.stringify({
                  type: "pong",
                  timestamp: new Date().toISOString(),
                })
              )
            }
          } catch {
            // Ignore malformed messages
          }
        },
        close(ws: any) {
          self.clients.delete(ws)
        },
      },
    })

    console.log(
      `[nexus] Dashboard server running at http://${host}:${port}`
    )
  }

  broadcast(event: string, data: unknown): void {
    const message = JSON.stringify({
      type: event,
      data,
      timestamp: new Date().toISOString(),
    })
    for (const client of this.clients) {
      try {
        client.send(message)
      } catch {
        this.clients.delete(client)
      }
    }
  }

  stop(): void {
    if (this.server) {
      this.server.stop()
      this.server = null
    }
    this.clients.clear()
  }

  getClientCount(): number {
    return this.clients.size
  }

  isRunning(): boolean {
    return this.server !== null
  }
}
