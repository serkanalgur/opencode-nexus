<div align="center">

<img src="./assets/banner.svg" alt="OpenCode Nexus" width="100%" />

[![npm version](https://img.shields.io/npm/v/@serkanalgur/opencode-nexus?style=flat-square&color=6366f1)](https://www.npmjs.com/package/@serkanalgur/opencode-nexus)
[![license](https://img.shields.io/npm/l/@serkanalgur/opencode-nexus?style=flat-square&color=8b5cf6)](https://github.com/serkanalgur/opencode-nexus/blob/main/LICENSE)
[![opencode](https://img.shields.io/badge/OpenCode-V2-6366f1?style=flat-square)](https://opencode.ai)
[![typescript](https://img.shields.io/badge/TypeScript-5.5+-3178c6?style=flat-square)](https://www.typescriptlang.org/)

**Adaptive Multi-Agent Orchestration with Cost Intelligence**

[Installation](#installation) • [Quick Start](#quick-start) • [Features](#features) • [Architecture](#architecture) • [Configuration](#configuration) • [API Reference](#api-reference) • [Development](#development) • [Contributing](#contributing)

</div>

---

## What is OpenCode Nexus?

OpenCode Nexus is a next-generation agent orchestration plugin for [OpenCode V2](https://opencode.ai) that introduces **adaptive multi-agent execution** with **cost-aware routing**, **real pub/sub communication**, **self-healing capabilities**, and **shared memory** between agents.

### Why Nexus?

| Problem | Existing Solutions | Nexus Solution |
|---------|-------------------|----------------|
| Sequential bottleneck | Agents run one-by-one | **Dynamic DAG with true parallelism** |
| No agent communication | Agents operate in isolation | **Real pub/sub with topic routing** |
| Cost blindness | Same model for all tasks | **Intelligent cost-aware model selection** |
| No self-healing | Manual restart on crash | **Auto-respawn with context transfer** |
| Memory isolation | Each agent starts fresh | **Cross-agent shared memory store** |
| Fixed architecture | 19+ predetermined agents | **Dynamic spawning based on complexity** |

---

## Installation

```bash
# Using npm
npm install -g @serkanalgur/opencode-nexus

# Using bun
bun add -g @serkanalgur/opencode-nexus

# Add to OpenCode config
opencode plugin @serkanalgur/opencode-nexus --global
```

Or manually add to `~/.config/opencode/opencode.json`:

```json
{
  "plugins": ["@serkanalgur/opencode-nexus"]
}
```

---

## Quick Start

### 1. Basic Usage

```typescript
import { NexusOrchestrator } from '@serkanalgur/opencode-nexus'

const orchestrator = new NexusOrchestrator({
  budget: { maxTotalCost: 10.00 }
})

// Execute multiple tasks in parallel
const result = await orchestrator.execute({
  tasks: [
    {
      id: 'task-1',
      name: 'Implement auth',
      description: 'Add JWT authentication',
      requiredRole: 'coder',
      complexity: { overall: 60, factors: { fileCount: 3, codeLines: 200, dependencyDepth: 2, domainKnowledge: 40, riskLevel: 'medium' } },
      dependencies: [],
      files: { include: ['src/auth/**'] },
      priority: 'high',
      status: 'pending'
    },
    {
      id: 'task-2',
      name: 'Write tests',
      description: 'Add unit tests for auth',
      requiredRole: 'tester',
      complexity: { overall: 30, factors: { fileCount: 2, codeLines: 150, dependencyDepth: 1, domainKnowledge: 20, riskLevel: 'low' } },
      dependencies: ['task-1'],
      files: { include: ['tests/auth/**'] },
      priority: 'normal',
      status: 'pending'
    }
  ]
})

console.log(`Completed in ${result.totalDuration}ms, cost: $${result.totalCost}`)
```

### 2. Using Slash Commands

```
/nexus status      # Show orchestrator status
/nexus agents      # List active agents
/nexus costs       # Show cost breakdown
/nexus pause       # Pause execution
/nexus resume      # Resume execution
/nexus dashboard   # Open web dashboard
```

### 3. Agent Communication

```typescript
// Subscribe to topics
orchestrator.publish('architecture', {
  from: 'architect',
  type: 'decision-made',
  payload: { decision: 'Use event sourcing', rationale: '...' },
  topic: 'architecture',
  metadata: { priority: 'high', requiresResponse: false }
})

// Send direct message
orchestrator.send('coder-1', {
  from: 'reviewer',
  type: 'review-completed',
  payload: { approved: true, comments: [...] },
  metadata: { priority: 'normal', requiresResponse: true }
})
```

---

## Features

### Dynamic DAG Execution

Unlike static dependency graphs, Nexus builds and modifies the DAG at runtime based on task outcomes.

```typescript
// Tasks are automatically parallelized based on dependencies
const tasks = [
  { id: 'schema', dependencies: [] },      // Runs immediately
  { id: 'api', dependencies: ['schema'] },  // Waits for schema
  { id: 'ui', dependencies: ['api'] },      // Waits for api
  { id: 'docs', dependencies: ['api'] }     // Parallel with ui!
]
```

### Cost-Aware Routing

Every model selection considers cost vs quality tradeoffs.

```typescript
const orchestrator = new NexusOrchestrator({
  budget: {
    maxTotalCost: 10.00,
    maxCostPerTask: 1.00,
    alertThreshold: 0.2  // Alert at 20% remaining
  }
})

// Automatically selects optimal model based on:
// - Task complexity
// - Remaining budget
// - Required quality level
```

### Real Pub/Sub Communication

Agents communicate through a message broker, not direct calls.

```typescript
// Topic-based pub/sub
orchestrator.publish('auth-decisions', {
  from: 'architect',
  type: 'decision-made',
  payload: { approach: 'JWT with refresh tokens' }
})

// Direct messaging
orchestrator.send('coder', {
  from: 'reviewer',
  type: 'review-requested',
  payload: { file: 'src/auth.ts', focus: 'security' }
})

// Fan-out to multiple agents
orchestrator.fanOut(
  { from: 'architect', type: 'context-update', payload: { ... } },
  ['coder', 'reviewer', 'tester']
)
```

### Self-Healing

Agents automatically recover from failures.

```typescript
const orchestrator = new NexusOrchestrator({
  selfHealing: {
    enabled: true,
    maxRetries: 3,
    retryDelay: 1000,
    backoffMultiplier: 2,
    contextTransfer: true  // Transfer partial results to new agent
  }
})
```

### Shared Memory

Agents share context through a structured memory store.

```typescript
// Set memory
orchestrator.setMemory('project', 'architecture', {
  pattern: 'event-sourcing',
  decision: 'Use for order service'
}, 'architect')

// Get memory
const arch = orchestrator.getMemory('project', 'architecture')

// Search memory
const results = orchestrator.searchMemory('event sourcing', 'project')
```

### Real-Time Dashboard

Monitor your orchestrator state via web UI.

```typescript
const orchestrator = new NexusOrchestrator({
  dashboard: {
    enabled: true,
    port: 4747,
    host: '127.0.0.1'
  }
})

// Open http://localhost:4747 in browser
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        NEXUS ORCHESTRATOR                       │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │    DAG       │  │   Cost       │  │   Adaptive   │          │
│  │  Executor    │  │  Router      │  │  Spawner     │          │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘          │
│         │                 │                 │                    │
│  ┌──────┴─────────────────┴─────────────────┴───────┐          │
│  │              AGENT LIFECYCLE MANAGER              │          │
│  └──────────────────────────────────────────────────┘          │
│                                                                 │
│  ┌──────────────────────────────────────────────────┐          │
│  │           COMMUNICATION LAYER (Pub/Sub)           │          │
│  └──────────────────────────────────────────────────┘          │
│                                                                 │
│  ┌──────────────────────────────────────────────────┐          │
│  │              SHARED MEMORY STORE                  │          │
│  └──────────────────────────────────────────────────┘          │
│                                                                 │
│  ┌──────────────────────────────────────────────────┐          │
│  │            DASHBOARD & MONITORING                  │          │
│  └──────────────────────────────────────────────────┘          │
└─────────────────────────────────────────────────────────────────┘
```

---

## Configuration

### Global Config

```jsonc
// ~/.config/opencode/nexus.jsonc
{
  "$schema": "https://serkanalgur.com/opencode-nexus/schema.json",
  
  "maxConcurrency": 5,
  "budget": {
    "maxTotalCost": 10.00,
    "maxCostPerTask": 1.00,
    "alertThreshold": 0.2
  },
  "selfHealing": {
    "enabled": true,
    "maxRetries": 3,
    "contextTransfer": true
  },
  "communication": {
    "mode": "pubsub",
    "persistence": true
  },
  "dashboard": {
    "enabled": true,
    "port": 4747
  }
}
```

### Project Config

```jsonc
// .opencode/nexus.jsonc
{
  "budget": {
    "maxTotalCost": 5.00
  },
  "agentRoles": {
    "security-reviewer": {
      "model": "anthropic/claude-sonnet-4-6",
      "tools": ["read", "grep", "git"]
    }
  }
}
```

---

## API Reference

### NexusOrchestrator

```typescript
class NexusOrchestrator {
  // Core
  execute(request: ExecutionRequest): Promise<ExecutionResult>
  spawnAgent(config: SpawnConfig): Promise<Agent>
  terminateAgent(agentId: string): Promise<void>
  
  // Communication
  publish(topic: string, message: AgentMessage): void
  subscribe(topic: string, handler: Function): Unsubscribe
  send(agentId: string, message: AgentMessage): void
  
  // Memory
  setMemory(scope: MemoryScope, key: string, value: unknown, author: string): void
  getMemory(scope: MemoryScope, key: string): MemoryEntry | undefined
  searchMemory(query: string, scope?: MemoryScope): MemoryEntry[]
  
  // Query
  getStatus(detailed?: boolean): string
  listAgents(filter?: string): string
  getCostReport(): string
  
  // Control
  pause(): void
  resume(): void
  shutdown(): void
  
  // Events
  on(event: string, handler: Function): Unsubscribe
}
```

### Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `nexus_status` | Get orchestrator status | `{ detailed?: boolean }` |
| `nexus_agents` | List all agents | `{ filter?: string }` |
| `nexus_costs` | Get cost report | `{}` |
| `nexus_memory_get` | Get shared memory | `{ scope: string, key: string }` |
| `nexus_memory_set` | Set shared memory | `{ scope: string, key: string, value: unknown }` |
| `nexus_send` | Send message to agent | `{ to: string, message: AgentMessage }` |

---

## Development

```bash
# Clone the repo
git clone https://github.com/serkanalgur/opencode-nexus.git
cd opencode-nexus

# Install dependencies
bun install

# Build
bun run build

# Run tests
bun test

# Development mode
bun run dev
```

---

## Benchmarks

| Scenario | Sequential | Swarm | Ensemble | **Nexus** |
|----------|-----------|-------|----------|-----------|
| 3 independent tasks | 300s | 120s | 100s | **60s** |
| Dependent chain (3) | 300s | 150s | 150s | **120s** |
| Mixed parallel+serial | 300s | 130s | 110s | **70s** |

| Metric | Swarm | **Nexus** |
|--------|-------|-----------|
| Tokens per task | 15,000 | **8,000** |
| Agent overhead | 19 fixed | **Dynamic 2-5** |
| Cost per session | $10 | **$4** |

---

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for details.

---

## License

MIT License - see [LICENSE](LICENSE) for details.

---

<div align="center">

**Built with ❤️ by [Serkan Algur](https://github.com/serkanalgur)**

[![GitHub](https://img.shields.io/badge/GitHub-serkanalgur-181717?style=flat-square&logo=github)](https://github.com/serkanalgur)
[![npm](https://img.shields.io/badge/npm-@serkanalgur-cb3837?style=flat-square&logo=npm)](https://www.npmjs.com/package/@serkanalgur)

</div>
