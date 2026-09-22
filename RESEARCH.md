# OpenCode Nexus — Future Development Research

> **Prepared for:** OpenCode Nexus Development Roadmap  
> **Date:** 2026-09-22  
> **Status:** Internal Research Document  
> **Version:** 1.0

---

## Executive Summary

OpenCode Nexus is a multi-agent orchestration plugin for OpenCode V2 that provides adaptive agent spawning, DAG-based task execution, cost-aware model routing, self-healing, and a TUI-based monitoring dashboard. The plugin is currently in active development with a solid foundation: the core orchestrator, plugin registration, type system, configuration management, and TUI are implemented and functional.

However, the TECHNICAL_DESIGN.md describes a significantly more ambitious vision. This research document audits every designed-but-unimplemented feature, analyzes the feasibility of the web dashboard, proposes concrete architecture for sub-agent monitoring, surveys the competitive landscape, and recommends a phased roadmap with effort estimates. The goal is to provide a clear, actionable plan for evolving Nexus from its current MVP state into a production-grade orchestration platform.

### Key Findings

1. **~50% of designed features are unimplemented.** The type system and interfaces are comprehensive but the runtime logic is simplified. (Updated: 12/30 features now implemented, up from 10)
2. **The web dashboard is the highest-impact unimplemented feature.** The config already includes `dashboard.enabled` and `dashboard.port`, but no HTTP/WebSocket server exists.
3. **Sub-agent monitoring is feasible today** because the orchestrator already exposes `getState()` and fires events—only the WebSocket transport layer is missing.
4. **The competitive landscape favors Nexus's approach.** Most competitors (CrewAI, AutoGen, LangGraph) target Python; Nexus fills a gap in the TypeScript/Node.js agent orchestration space.
5. **Three phases of work are recommended**, with the dashboard and self-healing improvements in Phase 1 for maximum early impact.

---

## 1. OpenCode Plugin Ecosystem

### 1.1 How OpenCode Plugins Work

OpenCode V2 plugins follow a structured pattern defined by the `@opencode/plugin` package. A plugin exports a default `Plugin.define()` call with:

- **`id`**: A unique string identifier (e.g., `"nexus"`)
- **`setup(ctx)`**: An async function receiving the OpenCode context (`ctx`), which provides:
  - `ctx.tool.transform()` — Register tools accessible by agents
  - `ctx.session.hook()` — Hook into session lifecycle events
  - `ctx.storage` — Persistent key-value storage
  - `ctx.session.create()` / `ctx.session.prompt()` — Session management API
  - `ctx.ui` — UI primitives (toasts, dialogs, slots)
  - `ctx.keymap` — Keyboard shortcut registration

TUI plugins use `@opencode/plugin/tui` and register UI components via `context.ui.slot()` and `context.keymap.layer()`.

### 1.2 Existing Plugin Patterns in the Ecosystem

The OpenCode ecosystem includes several agent orchestration plugins:

| Plugin | Approach | Key Pattern |
|--------|----------|-------------|
| **opencode-swarm** | Fixed agent count (19 agents) | Sequential pipeline with evidence files |
| **opencode-ensemble** | Lead-managed task board | Basic messaging between agents |
| **opencode-mission-control** | tmux-based isolation | Sequential execution with PR creation |

**Common patterns observed:**
- All plugins use `ctx.session.create()` for sub-agent sessions
- All plugins register tools via `ctx.tool.transform()`
- State management is typically in-memory (no persistence)
- Configuration is minimal (hardcoded or env vars)

### 1.3 Opportunities for Nexus

Nexus differentiates through:

1. **Dynamic agent count** (vs. fixed agent pools in Swarm)
2. **Real pub/sub communication** (vs. none or basic messaging in others)
3. **Cost-aware routing** (unique in the ecosystem)
4. **TUI-native dashboard** (vs. tmux or external tools)
5. **Self-healing with context transfer** (vs. basic timeout/retry)

**Gap analysis:**
- No plugin offers a **web dashboard** — this would be a first
- No plugin provides **shared memory** across agents — Nexus's in-memory store is the seed
- No plugin has **learning/pattern recognition** from failures
- The ecosystem lacks a **composable module architecture** — Nexus's design for this is unique

---

## 2. Unimplemented Features Audit

### 2.1 Feature Status Matrix

| # | Feature | Status | Priority | Effort | Design Reference |
|---|---------|--------|----------|--------|------------------|
| 1 | **DAG Executor with Parallelism** | ✅ Implemented | — | — | TECH §6.1 |
| 2 | **Agent Lifecycle Management** | ✅ Implemented | — | — | TECH §6.1 |
| 3 | **Basic Cost Tracking** | ✅ Implemented | — | — | TECH §6.2 |
| 4 | **Role-Based Agent Prompts** | ✅ Implemented | — | — | TECH §6.1 |
| 5 | **Self-Healing (Retry + Backoff)** | ✅ Implemented | — | — | TECH §6.4 |
| 6 | **Config Management (In-Memory)** | ✅ Implemented | — | — | TECH §9 |
| 7 | **TUI Dashboard (Toast-Based)** | ✅ Implemented | — | — | TECH §6.6 |
| 8 | **Plugin Registration + Tools** | ✅ Implemented | — | — | TECH §5 |
| 9 | **Pub/Sub Message Broker** | ⚠️ Basic (in-memory only) | High | Medium | TECH §6.3 |
| 10 | **Memory Store** | ⚠️ Basic (in-memory only) | Medium | Medium | TECH §6.5 |
| 11 | **Adaptive Agent Spawning** | ✅ Implemented (complexity analysis) | High | Medium | TECH §4.2 |
| 12 | **Cost-Aware Model Routing** | ⚠️ Partial (budget fallback only) | High | Medium | TECH §6.2 |
| 13 | **Self-Healing Context Transfer** | ❌ Not Implemented | High | Medium | TECH §6.4 |
| 14 | **Web Dashboard** | ❌ Not Implemented | High | Large | TECH §6.6 |
| 15 | **WebSocket State Broadcasting** | ❌ Not Implemented | High | Medium | TECH §6.6 |
| 16 | **Shared Memory (Persistent/SQLite)** | ❌ Not Implemented | Medium | Medium | TECH §6.5 |
| 17 | **Security Scanning Integration** | ❌ Not Implemented | Low | Medium | TECH §5.3 |
| 18 | **Learning/Pattern Recognition** | ❌ Not Implemented | Low | Large | TECH §5.3 |
| 19 | **Git Worktree Isolation** | ❌ Not Implemented | Medium | Medium | TECH §5.3 |
| 20 | **Composable Module Architecture** | ❌ Not Implemented | Medium | Large | TECH §5.1 |
| 21 | **Preset Configurations** | ❌ Not Implemented | Low | Small | TECH §5.1 |
| 22 | **Task Templates** | ❌ Not Implemented | Low | Medium | TECH §9.2 |
| 23 | **Config File Loading (JSONC)** | ✅ Implemented | Medium | Small | TECH §9.1 |
| 24 | **Health Monitoring (Active)** | ❌ Not Implemented | Medium | Medium | TECH §6.4 |
| 25 | **Escalation Policies** | ❌ Not Implemented | Medium | Small | TECH §6.4 |
| 26 | **Message Persistence** | ❌ Not Implemented | Low | Medium | TECH §6.3 |
| 27 | **Budget Enforcement (Hard Stop)** | ✅ Implemented (hard limit + spawn block) | Medium | Small | TECH §6.2 |
| 28 | **Deadlock Detection** | ❌ Not Implemented | Low | Small | TECH §6.1 |
| 29 | **Priority Queuing** | ❌ Not Implemented | Low | Small | TECH §6.1 |
| 30 | **Fan-Out / Broadcast Patterns** | ⚠️ Basic (simple broadcast) | Low | Small | TECH §6.3 |

### 2.2 Effort Legend

- **Small**: 1-2 days, self-contained change
- **Medium**: 3-5 days, new module or significant refactor
- **Large**: 1-2 weeks, major new subsystem

### 2.3 Critical Gaps Analysis

The most impactful missing features cluster around three themes:

**Theme A: Intelligence (Features 11, 12, 13)**
Adaptive spawning, cost routing, and context transfer are the core differentiators of Nexus. Without them, Nexus is a well-structured but conventional orchestrator. These should be prioritized together.

**Theme B: Observability (Features 14, 15, 24)**
The web dashboard, WebSocket broadcasting, and health monitoring form the observability stack. Users cannot effectively use Nexus without real-time visibility into agent activity.

**Theme C: Robustness (Features 16, 19, 20)**
Persistent memory, git worktree isolation, and composable modules make Nexus production-ready. Without these, it remains a development tool rather than a deployment tool.

---

## 3. Web Dashboard Feasibility

### 3.1 Current State

The configuration system already defines a dashboard section:

```typescript
// From types.ts — NexusConfig.dashboard
dashboard: {
  enabled: boolean
  port: number     // default: 4747
  host: string     // default: '127.0.0.1'
}
```

The TUI plugin's `handleDashboard()` function currently renders a text-based summary via `context.ui.toast.show()`. This provides config information but zero real-time agent data.

The orchestrator exposes `getState()` which returns a complete `OrchestratorState` snapshot including agents, tasks, costs, and budget status. This is the data source for the dashboard.

### 3.2 Architecture Proposal

#### HTTP + WebSocket Server

The dashboard should run as an embedded HTTP server within the OpenCode plugin process, serving a single-page application (SPA) over WebSocket for real-time updates.

```
┌─────────────────────────────────────────────┐
│              OpenCode Process                │
│                                              │
│  ┌──────────────┐    ┌───────────────────┐  │
│  │ Orchestrator  │───▶│ State Broadcaster │  │
│  │ (events)      │    │ (WebSocket)       │  │
│  └──────────────┘    └────────┬──────────┘  │
│                               │              │
│  ┌──────────────┐    ┌───────▼───────────┐  │
│  │ Config       │───▶│ HTTP Server       │  │
│  │ Manager      │    │ (port 4747)       │  │
│  └──────────────┘    │ • GET /api/state  │  │
│                      │ • GET /api/config │  │
│                      │ • WS  /ws/events  │  │
│                      │ • GET /           │  │
│                      └───────────────────┘  │
│                               │              │
└───────────────────────────────┼──────────────┘
                                │
                         ┌──────▼──────┐
                         │  Browser    │
                         │  Dashboard  │
                         └─────────────┘
```

#### Server Technology: Bun Native

Since the project already uses Bun as its runtime and package manager, the server should use **Bun's native `Bun.serve()`** API rather than pulling in Express, Hono, or other frameworks.

**Rationale:**
- Zero additional dependencies
- Bun's built-in WebSocket support (`websocket: { message(ws, msg) {...} }`)
- Native TypeScript support
- Performance characteristics suitable for local dashboard use

Alternative considered: **Hono** — lightweight, portable, excellent TypeScript support. Could be added if Bun native proves limiting, but adds a dependency.

### 3.3 Data to Expose

#### REST Endpoints

| Endpoint | Method | Response | Purpose |
|----------|--------|----------|---------|
| `/api/state` | GET | `OrchestratorState` | Full current state snapshot |
| `/api/config` | GET | `NexusFullConfig` | Current configuration |
| `/api/config` | PUT | `NexusFullConfig` | Update configuration |
| `/api/agents` | GET | `Agent[]` | List all agents |
| `/api/agents/:id` | GET | `Agent` | Single agent detail |
| `/api/tasks` | GET | `Task[]` | List all tasks |
| `/api/costs` | GET | `CostReport` | Cost breakdown |
| `/api/health` | GET | `{ ok: boolean }` | Health check |

#### WebSocket Events

| Event | Payload | Trigger |
|-------|---------|---------|
| `agent:spawned` | `Agent` | New agent created |
| `agent:terminated` | `Agent` | Agent removed |
| `agent:status-changed` | `{ id, status }` | Agent status update |
| `task:started` | `{ taskId, agentId }` | Task execution begins |
| `task:completed` | `{ taskId, result }` | Task finishes |
| `task:failed` | `{ taskId, error }` | Task errors |
| `cost:update` | `CostReport` | Cost tracking update |
| `budget:alert` | `{ remaining, percent }` | Budget threshold hit |
| `orchestrator:state` | `OrchestratorState` | Full state broadcast (periodic) |

### 3.4 Implementation Sketch

```typescript
// src/dashboard.ts — server-side dashboard module
import type { OrchestratorState } from "./orchestrator"

interface DashboardServer {
  port: number
  host: string
  stateBroadcaster: StateBroadcaster
}

class DashboardModule {
  private server: ReturnType<typeof Bun.serve>
  private clients: Set<any> = new Set()

  constructor(private orchestrator: NexusOrchestrator) {}

  start(port: number, host: string) {
    this.server = Bun.serve({
      port,
      hostname: host,
      
      // Static files (SPA)
      fetch(req, server) {
        const url = new URL(req.url)
        
        if (url.pathname === "/ws/events") {
          if (server.upgrade(req)) return new Response(null)
          return new Response("WebSocket upgrade failed", { status: 500 })
        }
        
        if (url.pathname === "/api/state") {
          return Response.json(orchestrator.getState())
        }
        
        if (url.pathname === "/api/config") {
          return Response.json(orchestrator.configManager.exportConfig())
        }
        
        // Serve SPA
        return new Response(Bun.file("./dashboard/index.html"))
      },
      
      websocket: {
        open(ws) {
          this.clients.add(ws)
          ws.send(JSON.stringify({
            type: "orchestrator:state",
            data: orchestrator.getState()
          }))
        },
        message(ws, message) {
          // Handle client messages (subscribe to topics, etc.)
        },
        close(ws) {
          this.clients.delete(ws)
        }
      }
    })
  }

  broadcast(event: string, data: unknown) {
    const message = JSON.stringify({ type: event, data })
    for (const client of this.clients) {
      client.send(message)
    }
  }
}
```

### 3.5 Dashboard UI Components

The SPA dashboard should include:

1. **Agent Grid** — Cards showing each agent's role, status, model, and metrics
2. **Task Pipeline** — DAG visualization with status indicators (pending/running/complete/failed)
3. **Cost Tracker** — Real-time cost chart with budget gauge
4. **Budget Bar** — Visual progress bar showing spend vs. limit
5. **Config Panel** — Edit models, budget, self-healing settings
6. **Log Stream** — Agent activity log (messages, completions, errors)
7. **Message Feed** — Pub/sub message viewer

**UI Technology:** React with Tailwind CSS, bundled with Vite, embedded as a static asset served by the Bun server.

---

## 4. Sub-Agent Monitoring on Dashboard

### 4.1 Current Agent Tracking

The orchestrator maintains agents in an in-memory `Map<string, Agent>`:

```typescript
// From orchestrator.ts
private agents: Map<string, Agent> = new Map()

// Each Agent contains:
interface Agent {
  id: string
  name: string
  role: AgentRole          // 'architect' | 'coder' | 'reviewer' | etc.
  status: AgentStatus      // 'spawning' | 'idle' | 'working' | 'completed' | 'failed' | 'terminated'
  model: ModelSelection    // { provider, model, estimatedCost, estimatedQuality, reasoning }
  spawnedAt: Date
  lastActivity: Date
  metrics: AgentMetrics    // { tasksCompleted, tasksFailed, totalTokens, totalCost, averageResponseTime, errorRate }
  sessionID?: string       // OpenCode session ID
}
```

State changes are already communicated via `notifyStateChange()` which calls the registered `onStateChange` callback. The plugin currently uses this to persist state to `ctx.storage`.

### 4.2 Exposing via WebSocket

The `onStateChange` callback in `index.ts` is the integration point:

```typescript
// Current behavior (index.ts):
orchestrator.initialize(ctx, () => {
  const state = orchestrator.getState()
  ctx.storage.set("orchestrator-state", JSON.parse(JSON.stringify(state)))
})

// Proposed: Add WebSocket broadcast alongside storage persistence
orchestrator.initialize(ctx, () => {
  const state = orchestrator.getState()
  ctx.storage.set("orchestrator-state", JSON.parse(JSON.stringify(state)))
  dashboardModule.broadcast("orchestrator:state", state)  // NEW
})
```

For finer-grained updates, the orchestrator's `emit()` method already fires events:

```typescript
// Orchestrator emits:
this.emit('agent:spawned', agent)
this.emit('agent:terminated', agent)
this.emit('budget:alert', { remaining, remainingPercent })
this.emit('budget:exceeded', { totalSpent })
this.emit('memory:set', entry)
```

The dashboard module can subscribe to these events directly:

```typescript
// In dashboard setup:
orchestrator.on('agent:spawned', (agent) => {
  this.broadcast('agent:spawned', agent)
})

orchestrator.on('agent:terminated', (agent) => {
  this.broadcast('agent:terminated', agent)
})
```

### 4.3 Real-Time Data Flow

```
Agent spawns/finishes/fails
         │
         ▼
Orchestrator emits event
         │
         ├──────────────────┐
         ▼                  ▼
notifyStateChange()    event handlers
         │                  │
         ▼                  ▼
ctx.storage.set()      dashboardModule.broadcast()
         │                  │
         ▼                  ▼
Persistent state       WebSocket → all connected clients
                              │
                              ▼
                     Browser UI updates
```

### 4.4 UI Components for Agent Monitoring

| Component | Data Source | Update Frequency | Description |
|-----------|-------------|-----------------|-------------|
| **AgentCard** | `state.agents[]` | On event | Role icon, name, status badge, model, session ID |
| **AgentMetrics** | `agent.metrics` | Periodic (1s) | Tasks completed/failed, cost, response time |
| **StatusIndicator** | `agent.status` | On event | Colored dot: green=working, yellow=idle, red=failed, gray=terminated |
| **CostGauge** | `state.totalSpent`, `state.budgetRemaining` | On event | Circular gauge showing spend percentage |
| **TaskList** | `state.tasks[]` | On event | Scrollable list with status icons and assigned agent |
| **DAGView** | `orchestrator.getDAG()` | Periodic (2s) | Visual dependency graph with node status coloring |
| **LogStream** | Event bus | On event | Filterable log of agent activities |
| **MessageFeed** | PubSub messages | On message | Real-time message viewer with sender/receiver |

### 4.5 WebSocket Protocol

```typescript
// Client → Server messages
interface ClientMessage {
  type: 'subscribe' | 'unsubscribe' | 'ping'
  topics?: string[]  // For subscribe/unsubscribe
}

// Server → Client messages
interface ServerMessage {
  type: 'orchestrator:state' | 'agent:spawned' | 'agent:terminated' | 
        'task:started' | 'task:completed' | 'cost:update' | 'pong'
  data: unknown
  timestamp: string
}
```

---

## 5. Competitive Analysis

### 5.1 Agent Framework Landscape

| Framework | Language | Agent Spawning | Parallelism | Communication | Cost Mgmt | Self-Healing | Dashboard |
|-----------|----------|---------------|-------------|---------------|-----------|-------------|-----------|
| **CrewAI** | Python | Role-based | Sequential | Task delegation | ❌ | Retry only | ❌ |
| **AutoGen** | Python | Configurable | Group chat | Direct messaging | ❌ | Timeout | ❌ |
| **LangGraph** | Python | Graph-based | True parallel | Graph edges | ❌ | Checkpointing | LangSmith |
| **Swarm** (OpenAI) | Python | Handoff-based | Sequential | Handoff functions | ❌ | ❌ | ❌ |
| **Semantic Kernel** | C#/Python | Plugin-based | Sequential | ❌ | ❌ | ❌ | ❌ |
| **Nexus** | TypeScript | Adaptive | DAG parallel | Pub/Sub | ✅ | Context transfer | ✅ (planned) |

### 5.2 Features Worth Adopting

#### From CrewAI

1. **Delegation Mode** — Allow agents to delegate subtasks to other agents dynamically. Nexus currently spawns agents from the orchestrator level only; delegating from within an agent session would enable emergent collaboration patterns.

2. **Human-in-the-Loop** — CrewAI supports `human_input=True` on tasks, pausing for human approval. Nexus could add a "gate" concept where certain tasks require user confirmation before proceeding.

3. **Agent Memory (RAG)** — CrewAI integrates with vector stores for long-term memory. Nexus's shared memory store could be enhanced with embedding-based search.

#### From AutoGen

1. **Group Chat Manager** — AutoGen's group chat allows multiple agents to participate in a conversation with a manager coordinating turn-taking. Nexus's pub/sub is lower-level; adding a "coordination mode" on top would be valuable.

2. **Code Execution Environment** — AutoGen provides a sandboxed Python code executor. Nexus uses OpenCode sessions which inherently have code execution, but adding explicit sandboxing per agent would improve security.

3. **Teachability** — AutoGen agents can be "taught" through conversation corrections. Nexus's learning module could adopt a similar pattern of storing corrections as memory entries.

#### From LangGraph

1. **Checkpointing** — LangGraph persists graph state at each node, allowing resumption from any point. Nexus should implement checkpoint/restart for long-running DAGs.

2. **Human-Feedback Nodes** — Special nodes in the graph that pause for human input. This maps to Nexus's "gates" concept.

3. **Streaming** — LangGraph provides streaming of intermediate results. Nexus's WebSocket dashboard could stream partial agent outputs in real-time.

#### From OpenCode Ecosystem

1. **Git Worktrees (from mission-control)** — Agent isolation via git worktrees. TECHNICAL_DESIGN.md includes this but it's not implemented.

2. **PR Creation (from mission-control)** — Automated pull request creation from agent results. Nexus could add this as a post-execution step.

3. **Evidence Files (from swarm)** — Structured output files that agents produce. Nexus's memory store could serve this purpose more elegantly.

### 5.3 Unique Nexus Advantages

1. **TypeScript-native** — All competitors are Python-first. Nexus fills the TypeScript/Node.js gap.
2. **OpenCode-native** — Deep integration with OpenCode's session API, not a standalone framework.
3. **Cost-aware routing** — No other framework considers token costs in model selection.
4. **TUI dashboard** — Terminal-native monitoring without external tools.
5. **Composable modules** — Designed for hot-reloadable, optional feature modules.

---

## 6. Recommended Roadmap

### Phase 1: Intelligence & Observability (Weeks 1-4)

**Goal:** Make Nexus useful and visible. Users should see what agents are doing and benefit from smart model selection.

| # | Task | Effort | Dependencies |
|---|------|--------|--------------|
| 1.1 | **Web Dashboard Server** — Bun.serve() HTTP + WebSocket server on port 4747 | 3 days | None |
| 1.2 | **Dashboard SPA** — React app with agent grid, cost tracker, task list | 4 days | 1.1 |
| 1.3 | **WebSocket State Broadcasting** — Subscribe to orchestrator events, broadcast to clients | 2 days | 1.1 |
| 1.4 | ✅ **Adaptive Agent Spawning** — Complexity analysis drives agent count and role assignment | Done | None |
| 1.5 | **Cost-Aware Model Routing** — Score models by quality/cost/speed, select optimally | 3 days | None |
| 1.6 | ✅ **Budget Hard-Limit** — Stop execution when budget exceeded (not just pause) | Done | None |
| 1.7 | ✅ **Config File Loading** — Read `.opencode/nexus.jsonc` and `~/.config/opencode/nexus.jsonc` | Done | None |

**Deliverable:** Users can open a web dashboard showing real-time agent activity, cost tracking, and task progress. Agents are spawned intelligently based on task complexity, and models are selected to optimize cost/quality.

**Estimated effort:** ~18 days (3.5 weeks)

### Phase 2: Reliability & Communication (Weeks 5-8)

**Goal:** Make Nexus production-grade. Agents communicate, self-heal, and operate in isolation.

| # | Task | Effort | Dependencies |
|---|------|--------|--------------|
| 2.1 | **Self-Healing Context Transfer** — Transfer partial results, decisions, and memory to respawned agents | 3 days | None |
| 2.2 | **Health Monitoring** — Active health checks per agent (response time, error rate, tokens/second) | 2 days | None |
| 2.3 | **Escalation Policies** — Configurable escalation chain (retry → respawn → fallback model → user alert) | 2 days | 2.1 |
| 2.4 | **Pub/Sub Message Persistence** — Persist messages to SQLite for post-mortem analysis | 3 days | None |
| 2.5 | **Fan-Out Patterns** — Enhanced broadcast with topic-based filtering and message routing | 2 days | None |
| 2.6 | **Shared Memory (Persistent)** — SQLite-backed memory store with TTL and search | 3 days | None |
| 2.7 | **Git Worktree Isolation** — Create isolated git worktrees per agent for file safety | 3 days | None |
| 2.8 | **Deadlock Detection** — Detect circular dependencies in DAG and report errors | 1 day | None |
| 2.9 | **Priority Queuing** — Priority-based task scheduling within the DAG | 2 days | None |

**Deliverable:** Nexus survives agent failures with context preservation. Agents communicate via persistent pub/sub and share a structured memory store. File isolation prevents cross-agent conflicts.

**Estimated effort:** ~21 days (4 weeks)

### Phase 3: Ecosystem & Polish (Weeks 9-12)

**Goal:** Make Nexus extensible, learnable, and production-ready for public release.

| # | Task | Effort | Dependencies |
|---|------|--------|--------------|
| 3.1 | **Composable Module Architecture** — `NexusModule` interface with lifecycle hooks and hot-reload | 5 days | None |
| 3.2 | **Security Scanning Integration** — SAST and secrets scanning per task output | 3 days | 3.1 |
| 3.3 | **Learning Module** — Pattern recognition from failures, confidence scoring, memory of what works | 5 days | 2.6 |
| 3.4 | **Preset Configurations** — `minimal`, `balanced`, `enterprise`, `cost-optimized` presets | 1 day | None |
| 3.5 | **Task Templates** — Reusable task pipeline definitions (e.g., "feature" = architect → coder → reviewer → tester) | 2 days | None |
| 3.6 | **OS Notifications** — Native notifications on task completion, budget alerts, errors | 1 day | None |
| 3.7 | **Dashboard Polish** — DAG visualization, log stream, message feed, config editor | 4 days | 1.2 |
| 3.8 | **Documentation & Examples** — API docs, getting started guide, example projects | 3 days | None |
| 3.9 | **Performance Optimization** — Profiling, memory leak prevention, connection pooling | 2 days | None |
| 3.10 | **Beta Testing & Bug Fixes** — Community feedback incorporation | 5 days | All |

**Deliverable:** Nexus is a production-ready, extensible orchestration platform with learning capabilities and a polished user experience.

**Estimated effort:** ~31 days (6 weeks)

### 6.1 Total Roadmap Summary

| Phase | Duration | Key Deliverable | Cumulative Feature Count |
|-------|----------|-----------------|--------------------------|
| **Phase 1** | Weeks 1-4 | Dashboard + Intelligence | 14 features (from 9) |
| **Phase 2** | Weeks 5-8 | Reliability + Communication | 23 features (from 14) |
| **Phase 3** | Weeks 9-12 | Ecosystem + Polish | 30 features (from 23) |

**Total estimated effort:** ~70 days (14 weeks) for a single developer.

---

## 7. Technical Specifications

### 7.1 Key Architecture Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Dashboard server** | Bun.serve() native | Zero dependencies, built-in WebSocket, project already uses Bun |
| **Dashboard UI** | React + Tailwind + Vite | Industry standard, excellent DX, small bundle |
| **Persistent storage** | SQLite (via bun:sqlite) | Embedded, zero-config, already available in Bun runtime |
| **Event bus** | In-process EventEmitter | Sufficient for single-process plugin, no external broker needed |
| **Config format** | JSONC (with comments) | Human-friendly, supports comments for documentation |
| **Module system** | Interface + dynamic registration | Allows optional features without bloating core |

### 7.2 Trade-Offs

| Trade-Off | Chosen Side | Alternative | Reasoning |
|-----------|-------------|-------------|-----------|
| In-memory vs. persistent memory | In-memory (Phase 1), SQLite (Phase 2) | Redis, PostgreSQL | Embedded is simpler for a plugin; external DBs require user setup |
| WebSocket vs. SSE | WebSocket | Server-Sent Events | Full-duplex needed for dashboard controls |
| Bun.serve vs. Hono | Bun.serve | Hono | Zero deps for a local dashboard; Hono if portability needed later |
| React vs. Solid | React | Solid, Preact | Ecosystem maturity, developer familiarity |
| Monolith vs. modules | Modular (Phase 3) | Monolith | Start simple, refactor later; premature modularity adds complexity |

### 7.3 Security Considerations

1. **Dashboard binding** — Default to `127.0.0.1` only. Never expose to `0.0.0.0` without auth.
2. **Auth (optional)** — Token-based auth for dashboard access when needed.
3. **Agent isolation** — Git worktrees prevent cross-agent file conflicts.
4. **Budget hard-limits** — Prevent runaway costs from external threats.
5. **Message TTL** — Prevent memory exhaustion from accumulated messages.
6. **Input validation** — All tool inputs validated against JSON schema.

### 7.4 Performance Targets

| Metric | Target | Notes |
|--------|--------|-------|
| Dashboard initial load | < 500ms | SPA with code splitting |
| WebSocket message latency | < 50ms | Local network only |
| Max concurrent agents | 10 | Configurable via `maxConcurrency` |
| State broadcast frequency | 1s | Configurable, event-driven for critical events |
| Memory per agent | < 50MB | Excluding OpenCode session memory |
| SQLite write throughput | > 1000 ops/s | Sufficient for message persistence |

### 7.5 Testing Strategy

| Level | Scope | Tools |
|-------|-------|-------|
| **Unit tests** | Individual functions (complexity analysis, cost scoring, DAG operations) | bun:test |
| **Integration tests** | Module interactions (orchestrator + dashboard, pub/sub + memory) | bun:test + mock OpenCode ctx |
| **E2E tests** | Full workflow (spawn → execute → complete → dashboard shows results) | Playwright against dashboard |
| **Load tests** | Stress test WebSocket connections, concurrent agent spawning | k6 or autocannon |

### 7.6 Migration Path

For existing Nexus users, the following changes require attention:

1. **Config format change** — When JSONC config loading is implemented, existing in-memory configs should be auto-exported.
2. **Dashboard port** — Default port 4747 should be checked for availability on startup.
3. **Storage directory** — SQLite files should be stored in `~/.local/share/opencode-nexus/` or similar XDG-compliant path.
4. **API compatibility** — The `nexus.*` tools should remain backward-compatible. New tools can be added but existing signatures should not change.

---

## Appendix A: OpenCode Plugin API Reference (Relevant)

The following OpenCode API surface is used by Nexus:

```typescript
// Plugin definition
Plugin.define({ id: string, setup: (ctx: PluginContext) => Cleanup })

// Context API
ctx.tool.transform((editor) => {
  editor.namespace({ name, description })
  editor.add({ name, description, input: JSONSchema, execute: async (input) => Result })
})

ctx.session.hook(event: string, handler: (event) => void)
ctx.session.create({ title?, agent?, model? }): Promise<Session>
ctx.session.prompt({ sessionID, text }): Promise<void>
ctx.session.wait({ sessionID }): Promise<void>
ctx.session.context({ sessionID }): Promise<Message[]>

ctx.storage.set(key: string, value: any): Promise<void>
ctx.storage.get(key: string): Promise<any>
```

## Appendix B: TypeScript Types Summary

Key types from `src/types.ts` that are relevant to future development:

- `Agent` — Core agent representation with metrics
- `Task` — Task definition with dependencies and file scope
- `DAG` / `DAGNode` — Graph structures for parallel execution
- `AgentMessage` / `MessageType` — Pub/sub message protocol
- `MemoryEntry` / `MemoryScope` — Shared memory entries
- `CostReport` / `BudgetConstraint` — Cost tracking and enforcement
- `HealthStatus` / `RecoveryAction` — Self-healing data structures
- `NexusConfig` — Complete configuration type

## Appendix C: Glossary

| Term | Definition |
|------|-----------|
| **DAG** | Directed Acyclic Graph — dependency model for task parallelism |
| **Pub/Sub** | Publish/Subscribe — messaging pattern for agent communication |
| **Context Transfer** | Moving agent state (partial results, decisions, memory) to a new agent instance |
| **Complexity Score** | Task difficulty rating (0-100) based on file count, code lines, domain knowledge, and risk |
| **Cost-Aware Routing** | Model selection that considers token costs, quality scores, and budget constraints |
| **Worktree** | Isolated git working directory preventing cross-agent file conflicts |
| **NexusModule** | Composable feature module interface for the plugin system |
| **Self-Healing** | Automatic recovery from agent failures via retry, respawn, fallback, or escalation |

---

**Document Version:** 1.0  
**Last Updated:** 2026-09-22  
**Classification:** Internal Research  
**Next Review:** 2026-10-01
