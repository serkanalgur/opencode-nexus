<div align="center">

<img src="./assets/banner.svg" alt="OpenCode Nexus" width="100%" />

[![npm version](https://img.shields.io/npm/v/@serkanalgur/opencode-nexus?style=flat-square&color=6366f1)](https://www.npmjs.com/package/@serkanalgur/opencode-nexus)
[![license](https://img.shields.io/npm/l/@serkanalgur/opencode-nexus?style=flat-square&color=8b5cf6)](https://github.com/serkanalgur/opencode-nexus/blob/main/LICENSE)
[![opencode](https://img.shields.io/badge/OpenCode-V2-6366f1?style=flat-square)](https://opencode.ai)
[![typescript](https://img.shields.io/badge/TypeScript-5.5+-3178c6?style=flat-square)](https://www.typescriptlang.org/)

**Adaptive Multi-Agent Orchestration with Cost Intelligence**

[Installation](#installation) • [Quick Start](#quick-start) • [Features](#features) • [TUI Commands](#tui-commands) • [Tools](#tools) • [Configuration](#configuration) • [Development](#development) • [Contributing](#contributing)

</div>

---

## What is OpenCode Nexus?

OpenCode Nexus is an agent orchestration plugin for [OpenCode V2](https://opencode.ai) that spawns **real sub-agent sessions** with **cost-aware routing**, **DAG-based task execution**, **self-healing**, and a **TUI dashboard**.

### Key Capabilities

| Capability | Description |
|------------|-------------|
| **Real Sessions** | Each agent runs in its own OpenCode session via `ctx.session.create()` |
| **Role-Based Agents** | Architect, Coder, Reviewer, Tester, Explorer, Documenter — each with specialized prompts |
| **DAG Execution** | Tasks are parallelized based on dependency graphs with priority queuing |
| **Cost-Aware Routing** | Scores models by quality/cost/speed, selects optimal per task complexity |
| **Self-Healing** | Retries with exponential backoff, context transfer, escalation policies |
| **Web Dashboard** | Real-time monitoring via HTTP + WebSocket server on port 4747 |
| **TUI Dashboard** | Monitor agents, budget, and config from the terminal |
| **Persistent Memory** | SQLite-backed memory store with TTL and search |
| **Learning Module** | Pattern recognition from failures, confidence scoring |
| **JSONC Config** | Read/write project and global config files with comments |
| **Slash Commands** | `/nexus`, `/nexus-dashboard`, `/nexus-model`, and more |

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

### 1. Configure Agent Models

Press **Ctrl+N** or type `/nexus` to open the configuration dialog and select models for each agent role.

### 2. Use Slash Commands

```
/nexus              # Open full configuration
/nexus config       # Configure models & budget
/nexus status       # Show config summary
/nexus dashboard    # Show dashboard
/nexus model        # Select model for a role
/nexus reset        # Reset to defaults
```

### 3. Spawn Agents via Tools

From any agent prompt, use the nexus tools:

```
Use the nexus.spawn tool to create a coder agent for implementing JWT auth
Use the nexus.status tool to check orchestrator state
Use the nexus.agents tool to list all spawned agents
Use the nexus.costs tool to see cost breakdown
```

### 4. Programmatic Usage

```typescript
import { NexusOrchestrator } from '@serkanalgur/opencode-nexus'

const orchestrator = new NexusOrchestrator({
  budget: { maxTotalCost: 10.00 }
})

// Initialize with OpenCode context (done automatically by plugin)
orchestrator.initialize(ctx)

// Spawn a real agent session
const agent = await orchestrator.spawnAgent({ role: 'coder' })

// Execute tasks in DAG
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
    }
  ]
})

console.log(`Completed in ${result.totalDuration}ms, cost: $${result.totalCost}`)
```

---

## Features

### Real OpenCode Sessions

Each agent runs in its own OpenCode session with the correct model and role-specific system prompt:

```typescript
// Creates a real OpenCode session with descriptive title
const session = await ctx.session.create({
  title: '💻 Coder — anthropic/claude-sonnet-4-6',
  agent: 'build',
  model: { providerID: 'anthropic', id: 'claude-sonnet-4-6' }
})

// Sends the task prompt
await ctx.session.prompt({ sessionID: session.id, text: 'You are a senior software engineer...' })
```

### Role-Specific System Prompts

Each agent role gets a specialized prompt:

| Role | OpenCode Agent | Focus |
|------|----------------|-------|
| **Architect** | `architect` | System design, architecture patterns, high-level decisions |
| **Coder** | `build-orchestrator` | Clean, efficient code following best practices |
| **Reviewer** | `code-reviewer` | Code review for correctness, security, performance |
| **Tester** | `build-orchestrator` | Comprehensive tests, edge cases, quality assurance |
| **Explorer** | `explore` | Codebase navigation, architecture analysis |
| **Documenter** | `doc-writer` | Clear technical documentation |

### Cost-Aware Model Selection

Nexus scores models by quality, cost, and speed — then picks the optimal one per task complexity:

```typescript
// High-complexity tasks favor quality models
// Low-complexity tasks favor cheap/fast models
// Budget remaining filters out unaffordable models

const result = orchestrator.selectBestModel('coder', complexityScore)
// → { provider: 'anthropic', model: 'claude-sonnet-4-6', overallScore: 0.82 }
```

### Self-Healing with Escalation

Failed tasks follow a 4-step escalation chain:

1. **Retry** — Exponential backoff (1s, 2s, 4s...)
2. **Respawn** — Collect context, spawn new agent with transferred state
3. **Fallback Model** — Try cheaper alternative model
4. **Alert** — Emit escalation event, mark as failed

```typescript
const orchestrator = new NexusOrchestrator({
  selfHealing: {
    enabled: true,
    maxRetries: 3,
    contextTransfer: true
  }
})
```

### Web Dashboard

Real-time monitoring via embedded HTTP + WebSocket server:

```bash
# Start dashboard
Use nexus.dashboard.start with port=4747

# Open in browser
open http://localhost:4747
```

Features: Agent grid, cost tracker, DAG visualization, activity log, config panel.

### Persistent Memory

SQLite-backed memory store that survives restarts:

```typescript
orchestrator.memoryStore.set({
  key: 'api-pattern',
  value: { endpoint: '/users', method: 'GET' },
  scope: 'project',
  author: 'architect',
  confidence: 0.9,
  tags: ['api', 'design']
})

// Search across all memory
const results = orchestrator.memoryStore.search('api pattern')
```

### Learning Module

Records failure patterns and solutions, building confidence over time:

```typescript
// Automatically records failures during execution
// Finds similar past failures and suggests solutions
// Confidence increases with successful reuse

const solutions = orchestrator.learning.findSolutions('TypeScript TS2345 error')
// → [{ entry: { solution: 'Add type cast', confidence: 0.85 }, similarity: 0.7 }]
```

### JSONC Configuration

Read and write config files with comments:

```jsonc
// .opencode/nexus.jsonc (project-level)
{
  // Agent models for each role
  "models": {
    "architect": "anthropic/claude-sonnet-4-6",
    "coder": "opencode-go/mimo-v2.5"
  },
  "budget": { "maxTotalCost": 10.00 }
}
```

Precedence: project > global > TUI > defaults.

### Preset Configurations

Quickly apply predefined configs:

| Preset | Models | Budget | Self-Healing |
|--------|--------|--------|--------------|
| **minimal** | Gemini Flash | $1 | Off |
| **balanced** | Claude/GPT mix | $10 | On (3 retries) |
| **enterprise** | Top-tier | $50 | On (5 retries) |
| **cost-optimized** | Cheapest | $3 | On (2 retries) |

### Composable Modules

Extend Nexus with custom modules:

```typescript
import { NexusPlugin } from '@serkanalgur/opencode-nexus'

NexusPlugin.register({
  name: 'my-custom-module',
  description: 'Custom feature',
  version: '1.0.0',
  setup: async (ctx) => { /* ... */ },
  teardown: async () => { /* ... */ }
})
```

### Custom Agent Roles

Define your own agent roles with custom prompts:

```jsonc
// .opencode/nexus.jsonc
{
  "customRoles": [
    {
      "name": "security-auditor",
      "displayName": "Security Auditor",
      "emoji": "🔐",
      "prompt": "You are a security auditor. Focus on OWASP Top 10, vulnerability scanning, and security best practices.",
      "model": "anthropic/claude-sonnet-4-6"
    }
  ]
}
```

Or register dynamically via tools: `nexus.roles.add(name="security-auditor", displayName="Security Auditor", prompt="...")`

### Execution History

Track all task executions with costs, durations, and outcomes:

```
nexus.history.list(count=10)  — Recent executions
nexus.history.stats()         — Success rate, avg cost, breakdown by role
```

### Cost Forecasting

Predict costs before executing tasks:

```typescript
const forecast = orchestrator.forecaster.forecastAll([
  { task: myTask, role: 'coder', model: 'claude-sonnet-4-6', complexity: score }
], budgetRemaining)
// → { totalEstimatedCost: 0.0234, withinBudget: true }
```

### Agent Performance Scoring

Track which model/role combinations work best:

```
nexus.performance.scores()           — All model/role scores
nexus.performance.best(role="coder") — Best model for a role
```

Score = 40% success rate + 30% speed + 30% cost efficiency.

### Git Worktree Per Agent

Each agent works in its own isolated git worktree:

```
nexus.worktree.enable()   — Enable isolation
nexus.worktree.list()     — List active worktrees
nexus.worktree.disable()  — Clean up all
```

---

## TUI Commands

| Command | Alias | Description |
|---------|-------|-------------|
| `/nexus` | — | Open full configuration dialog |
| `/nexus config` | `/nc` | Configure models & budget |
| `/nexus dashboard` | `/nd` | Show dashboard with models, budget, commands |
| `/nexus model` | `/nm` | Select model for a role |
| `/nexus status` | `/ns` | Show config summary |
| `/nexus reset` | — | Reset all settings to defaults |

**Keyboard shortcut:** `Ctrl+N` opens the main configuration dialog.

---

## Tools

Register these tools in your agent prompts:

| Tool | Description | Input |
|------|-------------|-------|
| `nexus.status` | Orchestrator status | `{ detailed?: boolean }` |
| `nexus.agents` | List spawned agents | `{ filter?: string }` |
| `nexus.costs` | Cost report & budget | `{}` |
| `nexus.dashboard` | Full state for dashboard | `{}` |
| `nexus.spawn` | Spawn a sub-agent | `{ role: string, task: string, model?: string }` |
| `nexus.queue` | Show task queue with priorities | `{}` |
| `nexus.config.save` | Save config to disk | `{ level: 'project' \| 'global' }` |
| `nexus.config.init` | Initialize config files | `{ level: 'project' \| 'global' \| 'both' }` |
| `nexus.dashboard.start` | Start web dashboard | `{ port?: number, host?: string }` |
| `nexus.dashboard.stop` | Stop web dashboard | `{}` |
| `nexus.preset` | Apply preset config | `{ name: string }` |
| `nexus.template` | List/instantiate templates | `{ name?: string, baseDir?: string }` |
| `nexus.model.costs` | Show/set model pricing | `{ model?: string, setInput?: number, setOutput?: number }` |
| `nexus.security.scan` | Scan code for security issues | `{ content: string, filename?: string }` |
| `nexus.roles.list` | List custom agent roles | `{}` |
| `nexus.roles.add` | Add a custom role | `{ name, displayName, prompt, emoji?, model? }` |
| `nexus.history.list` | List execution history | `{ count?: number }` |
| `nexus.history.stats` | Execution statistics | `{}` |
| `nexus.forecast` | Predict costs before execution | `{ tasks: string }` |
| `nexus.performance.scores` | Model/role performance scores | `{}` |
| `nexus.performance.best` | Best model for a role | `{ role: string }` |
| `nexus.worktree.enable` | Enable git worktree isolation | `{ repoRoot?: string }` |
| `nexus.worktree.list` | List active worktrees | `{}` |
| `nexus.worktree.disable` | Disable and clean up | `{}` |

### Tool Examples

```
# Spawn a coder agent with complexity analysis
Use nexus.spawn with role="coder" and task="Implement JWT auth middleware"
# → 💻 Coder — anthropic/claude-sonnet-4-6
# → 📊 Complexity: 45/100 (low risk)

# Check status
Use nexus.status with detailed=true

# Apply a preset
Use nexus.preset with name="balanced"

# Initialize config
Use nexus.config.init with level="project"

# Start web dashboard
Use nexus.dashboard.start with port=4747
```

---

## Configuration

### Agent Models (TUI)

Configure via `/nexus` or `Ctrl+N`:

```
🏗️ Architect: anthropic/claude-sonnet-4-6
💻 Coder:     anthropic/claude-sonnet-4-6
🔍 Reviewer:  openai/gpt-5-mini
🧪 Tester:    anthropic/claude-haiku-4-5
🔬 Explorer:  google/gemini-2.5-flash
📝 Documenter: anthropic/claude-haiku-4-5
```

### Budget

```
💰 Max Total: $10.00
   Max Per Task: $1.00
   Alert Threshold: 20%
```

### Self-Healing

```
🛡️ Enabled: ✅
   Max Retries: 3
   Context Transfer: ✅
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        NEXUS PLUGIN                              │
│                                                                 │
│  ┌──────────────────────────────────────────────────┐          │
│  │              SERVER PLUGIN (index.ts)              │          │
│  │  • 12 tool registrations (spawn, status, costs,   │          │
│  │    dashboard, config, preset, template, queue)    │          │
│  │  • Session hook for /nexus commands               │          │
│  │  • State persistence to storage                   │          │
│  └──────────────────────────────────────────────────┘          │
│                                                                 │
│  ┌──────────────────────────────────────────────────┐          │
│  │            ORCHESTRATOR (orchestrator.ts)          │          │
│  │  • Real OpenCode session creation                  │          │
│  │  • DAG-based task execution with priority          │          │
│  │  • Cost-aware model routing (scored selection)     │          │
│  │  • Self-healing with escalation policies           │          │
│  │  • Context transfer to respawned agents            │          │
│  │  • Cycle detection for deadlock prevention         │          │
│  │  • Performance: lazy init, debounce, cleanup       │          │
│  └──────────────────────────────────────────────────┘          │
│                                                                 │
│  ┌──────────────────────────────────────────────────┐          │
│  │              MODULES                               │          │
│  │  ┌────────────┐ ┌──────────┐ ┌────────────────┐  │          │
│  │  │ Health     │ │ Learning │ │ Message Store  │  │          │
│  │  │ Monitor    │ │ Module   │ │ (JSONL+SQLite) │  │          │
│  │  └────────────┘ └──────────┘ └────────────────┘  │          │
│  │  ┌────────────┐ ┌──────────┐ ┌────────────────┐  │          │
│  │  │ Persistent │ │ Fan-Out  │ │ Notifications  │  │          │
│  │  │ Memory     │ │ Router   │ │ (OS native)    │  │          │
│  │  └────────────┘ └──────────┘ └────────────────┘  │          │
│  │  ┌────────────┐ ┌──────────┐                      │          │
│  │  │ State      │ │ Module   │                      │          │
│  │  │ Broadcaster│ │ Registry │                      │          │
│  │  └────────────┘ └──────────┘                      │          │
│  └──────────────────────────────────────────────────┘          │
│                                                                 │
│  ┌──────────────────────────────────────────────────┐          │
│  │              WEB DASHBOARD                         │          │
│  │  • Bun.serve() HTTP + WebSocket (port 4747)       │          │
│  │  • REST: /api/state, /api/config, /api/agents     │          │
│  │  • WebSocket: /ws/events (real-time updates)      │          │
│  │  • SPA: Agent grid, DAG viz, cost tracker         │          │
│  └──────────────────────────────────────────────────┘          │
│                                                                 │
│  ┌──────────────────────────────────────────────────┐          │
│  │              CONFIG                                │          │
│  │  • JSONC file loading (project + global)           │          │
│  │  • Config creation and initialization              │          │
│  │  • Preset configurations (4 presets)               │          │
│  │  • Task templates (feature, bugfix, refactor)      │          │
│  └──────────────────────────────────────────────────┘          │
│                                                                 │
│  ┌──────────────────────────────────────────────────┐          │
│  │              TUI PLUGIN (tui.tsx)                  │          │
│  │  • /nexus slash commands                           │          │
│  │  • Configuration dialogs (model selection)         │          │
│  │  • Keyboard shortcut (Ctrl+N)                      │          │
│  └──────────────────────────────────────────────────┘          │
└─────────────────────────────────────────────────────────────────┘
```

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

# Type check
npx tsc --noEmit
```

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
