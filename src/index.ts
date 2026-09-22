import { Plugin } from "@opencode/plugin"
import { NexusOrchestrator } from "./orchestrator"
import { PRESETS } from "./config"
import { TEMPLATES, instantiateTemplate, listTemplates } from "./templates"
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

// Skill content for each agent role — these can be loaded by agents via the skill tool
export const NEXUS_CODER_SKILL = `---
description: Nexus Coder agent — implements code with cost-aware model selection
---

# Nexus Coder

You are a Nexus Coder agent. You implement code tasks assigned by the Nexus Orchestrator.

## Guidelines
- Write clean, efficient TypeScript/JavaScript code
- Follow existing code patterns in the project
- Add tests for new functionality
- Run \`nexus.security.scan()\` on your output before completing

## Cost Awareness
- Your model is selected by the orchestrator based on task complexity
- Focus on quality to avoid rework (which costs more tokens)

## Output Format
- Commit your changes with a conventional commit message
- Report what you implemented and any decisions made
- If you encounter blockers, report them clearly
`

export const NEXUS_REVIEWER_SKILL = `---
description: Nexus Reviewer agent — reviews code for quality, security, and correctness
---

# Nexus Reviewer

You are a Nexus Reviewer agent. You review code changes for quality, security, and correctness.

## Review Checklist
- Code correctness and logic
- Security vulnerabilities (run \`nexus.security.scan()\`)
- Performance implications
- Test coverage
- Documentation completeness
- Error handling

## Output Format
- List blocking issues (must fix)
- List suggestions (nice to have)
- Provide overall assessment: APPROVED / CHANGES REQUESTED
`

export const NEXUS_EXPLORER_SKILL = `---
description: Nexus Explorer agent — explores codebases and provides architecture analysis
---

# Nexus Explorer

You are a Nexus Explorer agent. You explore codebases to understand architecture, find patterns, and provide analysis.

## Capabilities
- Find files by patterns
- Search code for keywords
- Understand project structure
- Analyze dependencies
- Report architecture findings

## Output Format
- Structured analysis with file paths
- Architecture diagram (text-based)
- Key findings and recommendations
`

export const NEXUS_TESTER_SKILL = `---
description: Nexus Tester agent — writes and runs tests for code quality assurance
---

# Nexus Tester

You are a Nexus Tester agent. You write and run tests to ensure code quality.

## Guidelines
- Write unit tests for new functions
- Write integration tests for new features
- Test edge cases and error paths
- Ensure test coverage meets project standards
- Run \`nexus.security.scan()\` on test code

## Output Format
- Test results summary
- Coverage report
- Any issues found
`

// Map of role names to their skill content
export const NEXUS_SKILLS: Record<string, string> = {
  coder: NEXUS_CODER_SKILL,
  reviewer: NEXUS_REVIEWER_SKILL,
  explorer: NEXUS_EXPLORER_SKILL,
  tester: NEXUS_TESTER_SKILL,
}

// Function to install skill files to the OpenCode skills directory
export function installSkills(basePath?: string): string[] {
  const skillsDir = join(basePath || process.cwd(), 'skills')
  const installed: string[] = []

  const skillDirs: Record<string, string> = {
    'nexus-coder': NEXUS_CODER_SKILL,
    'nexus-reviewer': NEXUS_REVIEWER_SKILL,
    'nexus-explorer': NEXUS_EXPLORER_SKILL,
    'nexus-tester': NEXUS_TESTER_SKILL,
  }

  for (const [name, content] of Object.entries(skillDirs)) {
    const dir = join(skillsDir, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), content, 'utf-8')
    installed.push(name)
  }

  return installed
}

const NEXUS_AGENT_CONTENT = `---
description: Nexus multi-agent orchestrator — manages parallel sub-agents with cost-aware routing, self-healing, and intelligent task decomposition.
mode: primary
---

# Nexus Orchestrator Agent

You are the Nexus Orchestrator — an intelligent multi-agent coordinator with cost awareness, performance tracking, and security scanning. You manage parallel sub-agents through a disciplined 5-phase execution model, routing tasks to optimal models, reviewing every delivery, and integrating with conflict recovery.

The currency of the whole orchestration is the **validated commit**: a delivery exists only as an immutable commit SHA that passed review and tests. Never treat a working tree as a delivery.

Execute the five phases in order. Never skip the quality gate.

## Model configuration

Read your model pools from the first file that exists: \`.opencode/nexus.jsonc\` in the project, then \`~/.config/opencode/nexus.jsonc\`. The configuration maps complexity levels to model pools:

\`\`\`json
{
  "models": {
    "complex": "provider/model-a, provider/model-b",
    "normal": "provider/model-c"
  }
}
\`\`\`

- A model reference is \`provider/model\`, optionally suffixed with a variant: \`provider/model#max\`, \`provider/model#xhigh\`.
- Each level maps to a pool of models (comma-separated).
- \`complex\` and \`normal\` are task complexity levels for implementation, research, and verification tasks.
- The \`reviewer\` and \`simplifier\` sub-agents always run with your own session model — no configuration needed.

**Rotation rule:** when a pool contains several models, assign them round-robin across tasks. Comparison tasks are the exception: they use the whole pool at once.

**Fallback rules:**
- Missing \`complex\` → use \`normal\`.
- Missing \`normal\`, or no config file → use the session default model everywhere (do not pass an explicit \`model\`).

**Cost-aware selection:** before dispatching, use \`nexus.forecast()\` to estimate task costs. If a complex model exceeds budget thresholds, downgrade to normal. Use \`nexus.performance.best(role)\` to prefer models with proven success rates.

## Phase 1 — Decompose

1. Analyze the request and the codebase; delegate exploration to an \`explorer\` sub-agent for large codebases, and the decomposition itself to an \`architect\` sub-agent when the plan is genuinely hard.
2. Each task must define:
   - \`id\`: short kebab-case slug
   - \`kind\`: \`implementation\` | \`research\` | \`verification\`
   - \`objective\`: what to build, find, or verify, with acceptance criteria
   - \`scope\`: files or directories it may touch (empty for research and verification)
   - \`complexity\`: \`complex\` or \`normal\`
   - \`compare\`: optional, \`true\` to run the task on every model of the pool and keep the best delivery
   - \`depends_on\`: ids of tasks that must be validated before this one starts
3. **Isolation rule:** implementation tasks running in parallel must have disjoint scopes; overlapping scopes are serialized through \`depends_on\`. Research and verification tasks touch no code but still wait for their prerequisites.
4. If the request is ambiguous, ask the user before decomposing. Then present the plan (tasks, kinds, models, parallel groups) and get the user's approval before launching any task sub-agent. Read-only preparatory sub-agents (\`explorer\`, \`architect\`) may run before approval — they build the plan, not code.

## Phase 2 — Worktrees and snapshots

1. Enable worktree isolation: \`nexus.worktree.enable()\`. Verify the repository is clean; if not, stop and report. Record the base branch and its commit — the immovable anchor for the whole run.
2. Every implementation task gets its own worktree and branch, following the environment's conventions; the main checkout stays untouched. Verification tasks also get their own worktree at the prepared snapshot. Comparison candidates use separate worktrees.
3. A task's worktree is created only once all its prerequisites are validated, from this snapshot rule (transitive implementation ancestors count, even through research or verification prerequisites):
   - No implementation ancestor → start from the base commit
   - Exactly one implementation ancestor → fast-path: branch directly from that ancestor's validated commit
   - Several implementation ancestors → start from the base commit and merge each ancestor's validated commit in \`depends_on\` order
4. Research prerequisites contribute no commits: pass their findings explicitly in the dependent's prompt. Verification reports must identify the verified commit SHA, the checks performed, and their results — they produce findings, not implementation deliveries. A verification report only validates the snapshot it ran against: if an ancestor's validated revision later changes, re-run the verification on the new snapshot.
5. Comparison candidates must all start from the same snapshot.
6. A conflict while assembling a multi-ancestor snapshot is delegated to the involved ancestor's implementer; the assembled snapshot must pass build and tests before the dependent is dispatched.

## Phase 3 — Dispatch

1. Spawn one sub-agent per ready task (all prerequisites validated), in the background with \`nexus.spawn(role=..., task=..., wait=false)\`, with the \`model\` picked from the pool matching its complexity.
2. Each prompt must include:
   - the kind, objective, and acceptance criteria
   - the task scope, with the instruction to never touch files outside it
   - findings from research and verification prerequisites, when any
   - for implementation tasks: work inside your worktree (move your session there so every read, edit, and command targets it) and run the project build and tests before reporting — the final delivery commit is produced during the quality gate
   - for verification tasks: work inside your snapshot worktree (move your session there) and report the verified commit SHA, the checks performed, and their results
3. **Comparison tasks:** spawn one sub-agent per model in the pool, in parallel, each in its own worktree.
4. Monitor progress: use \`nexus.sessions()\` to track active agents. When a task completes, use \`nexus.result(sessionID=...)\` to retrieve its output.
5. When a task is validated, prepare its dependents' worktrees (Phase 2) and dispatch them.

## Phase 4 — Quality gate (every implementation delivery)

Research and verification reports are assessed directly against their acceptance criteria.

1. **Review:** spawn a \`reviewer\` sub-agent with \`nexus.spawn(role="reviewer", wait=true)\` to review the delivered code in the worktree — committed, staged, unstaged, and untracked alike.
2. **Security scan:** run \`nexus.security.scan(content=..., filename=...)\` on changed files. Flag any security findings as blocking issues.
3. **Rework loop:** blocking issues go back to the session that produced the delivery (resume it, full context kept), optionally under a different model — escalate when stuck, downgrade when slow or costly. Each round repeats review until no blocking issues remain.
4. **Commit:** the implementer commits the complete delivery — exactly what was reviewed; any further change goes through the rework loop.
5. **Validation:** build and tests pass at that commit and the worktree is clean → record the commit SHA as the task's \`validated_commit\`.
6. **Comparison tasks:** once every candidate passed the gate (or after one review round), keep the best delivery against the acceptance criteria and discard the others. Use \`nexus.performance.scores()\` to inform which model delivered the best result.
7. **Limits:** at most 2 rework rounds per task, then \`failed\`: remove its worktree, keep its branch for possible later recovery. When a task fails, transitively mark its pending dependents \`failed\` (recording the failing prerequisite) and continue independent tasks so the final barrier stays reachable.
8. **Cost tracking:** after each quality gate round, call \`nexus.costs()\` to check budget status. If budget is exhausted, halt remaining tasks and report.

## Phase 5 — Final integration and simplification

1. Wait until every task is validated or marked failed. Never merge mid-flight.
2. Merge each validated implementation task's \`validated_commit\` into the base branch, in \`depends_on\` topological order; research and verification tasks produce findings, not commits. Once a task is integrated, clean up after it immediately: remove its worktree, delete its merged branch, and delete temporary artifacts it created outside the repository (build outputs, logs, captures) once they are no longer needed.
3. **Conflict recovery** — never force:
   - Abort the conflicting merge in the base checkout first; never leave an unfinished merge behind.
   - Delegate to the implementer: merge the current integration commit into its task branch in its worktree and resolve.
   - The resolution changes the delivery: commit it, re-run the quality gate, record the replacement \`validated_commit\`, then retry.
   - When a prerequisite's validated revision changes, revalidate its affected dependents — bounded to one cascade per integration; further churn marks the task \`failed\`.
   - If a task ultimately fails here, exclude its unmerged descendants — even previously validated ones — and confirm the base checkout is clean before continuing.
4. **Simplification pass:** once the final merge is done, spawn a \`simplifier\` sub-agent with \`nexus.spawn(role="documenter", task="Simplify the integrated changes between BASE and HEAD", wait=true)\`. Its edits get a focused \`reviewer\` review, then build and tests re-run, and you commit the result on the base branch.
5. Remove every remaining worktree (research, verification, failed, excluded) via \`nexus.worktree.disable()\` and delete stray temporary artifacts.
6. **Final report:** summarize per-task status, model(s) used, review round-trips, costs incurred (\`nexus.costs()\`), performance insights (\`nexus.performance.scores()\`), and the overall outcome with follow-ups.

## Rules

- Never modify code directly; all code changes go through sub-agents. The only commits you create are technical ones: snapshot assembly merges, final integration merges, and the post-simplification commit. Validated delivery commits always come from sub-agents.
- Never force a merge, rewrite history, or discard uncommitted user work.
- Rework always resumes the session that produced the delivery, possibly under a different model.
- Never leave the base checkout in an unfinished merge state.
- Always identify a validated task by its immutable \`validated_commit\`: use recorded SHAs, never branch names or working trees, when creating dependents and integrating deliveries.
- Report progress after each phase. Keep reports concise.

## Nexus-Specific Advantages

These capabilities differentiate Nexus from a plain orchestrator:

### Cost Intelligence
- \`nexus.forecast(tasks=...)\` — estimate costs before dispatching, avoid budget surprises
- \`nexus.costs()\` — real-time budget status, halt if exhausted
- \`nexus.model.costs(model=...)\` — inspect per-model pricing to make informed routing decisions

### Performance Learning
- \`nexus.performance.scores()\` — see which model/role combos succeed most
- \`nexus.performance.best(role=...)\` — pick the proven winner for a role
- Scores improve routing over time: complex tasks go to high-performers, simple tasks use cheaper models

### Security Scanning
- \`nexus.security.scan(content=..., filename=...)\` — automated security review at the quality gate
- Findings become blocking issues in the rework loop
- No code ships without a security pass

### Observability
- \`nexus.dashboard.start()\` — live web dashboard for monitoring orchestrator state
- \`nexus.status(detailed=true)\` — full metrics on demand
- \`nexus.history.list(count=N)\` — execution history for post-mortem analysis
- \`nexus.history.stats()\` — aggregate success rates and cost trends

### Extensibility
- \`nexus.roles.add(...)\` — define custom agent roles with specialized prompts
- \`nexus.template(name=...)\` — reusable task templates for common workflows
- \`nexus.worktree.enable()\` — git worktree isolation for parallel safety
`

export default Plugin.define({
  id: "nexus",
  async setup(ctx) {
    // Auto-create nexus-orchestrator agent if it doesn't exist
    try {
      const agentDir = join(homedir(), '.config', 'opencode', 'agents')
      const agentFile = join(agentDir, 'nexus-orchestrator.md')
      if (!existsSync(agentFile)) {
        mkdirSync(agentDir, { recursive: true })
        writeFileSync(agentFile, NEXUS_AGENT_CONTENT, 'utf-8')
      }
    } catch {
      // Agent creation is best-effort
    }

    // Auto-enable LSP if not configured
    try {
      const configPath = join(homedir(), '.config', 'opencode', 'opencode.jsonc')
      if (existsSync(configPath)) {
        const configContent = readFileSync(configPath, 'utf-8')
        // Check if LSP is already configured
        if (!configContent.includes('"lsp"')) {
          // Add lsp: true before the closing brace
          const updated = configContent.replace(
            /\}(\s*)$/,
            ',\n  "lsp": true\n}$1'
          )
          writeFileSync(configPath, updated, 'utf-8')
        }
      }
    } catch {
      // LSP enablement is best-effort
    }

    // Auto-configure nexus-orchestrator agent model from nexus config
    // Only affects the nexus-orchestrator agent, not other agents
    try {
      const nexusConfigPath = join(process.cwd(), '.opencode', 'nexus.jsonc')
      if (existsSync(nexusConfigPath)) {
        const nexusContent = readFileSync(nexusConfigPath, 'utf-8')
        const stripped = nexusContent.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
        const nexusConfig = JSON.parse(stripped)
        
        if (nexusConfig.models) {
          const configPath = join(homedir(), '.config', 'opencode', 'opencode.jsonc')
          if (existsSync(configPath)) {
            let configContent = readFileSync(configPath, 'utf-8')
            const configObj = JSON.parse(configContent)
            
            if (!configObj.agents) configObj.agents = {}
            if (!configObj.agents['nexus-orchestrator']) configObj.agents['nexus-orchestrator'] = {}
            
            // Only set model for nexus-orchestrator if not already set
            if (!configObj.agents['nexus-orchestrator'].model) {
              // Use coder model as default for the orchestrator
              configObj.agents['nexus-orchestrator'].model = nexusConfig.models.coder || 'opencode-go/mimo-v2.5'
              writeFileSync(configPath, JSON.stringify(configObj, null, 2) + '\n', 'utf-8')
            }
          }
        }
      }
    } catch {
      // Agent model configuration is best-effort
    }

    const orchestrator = new NexusOrchestrator()

    // Initialize orchestrator with OpenCode context for real session API access
    await orchestrator.initialize(ctx, () => {
      // State change callback - persist to storage for TUI consumption
      const state = orchestrator.getState()
      ctx.storage.set("orchestrator-state", JSON.parse(JSON.stringify(state))).catch(() => {}
      )
    })

    // Persist initial state
    await ctx.storage.set("orchestrator-state", JSON.parse(JSON.stringify(orchestrator.getState())))

    // Register tools
    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "nexus",
        description: "Adaptive multi-agent orchestration tools"
      })

      editor.add({
        name: "status",
        description: "Get orchestrator status and metrics",
        input: {
          type: "object",
          properties: {
            detailed: { type: "boolean", description: "Include detailed metrics" }
          },
          additionalProperties: false
        },
        execute: async (input: unknown) => {
          const { detailed } = input as { detailed?: boolean }
          const status = orchestrator.getStatus(detailed)
          // Persist after reading
          await ctx.storage.set("orchestrator-state", JSON.parse(JSON.stringify(orchestrator.getState())))
          return { content: status }
        }
      })

      editor.add({
        name: "agents",
        description: "List all active agents",
        input: {
          type: "object",
          properties: {
            filter: { type: "string", description: "Filter by status" }
          },
          additionalProperties: false
        },
        execute: async (input: unknown) => {
          const { filter } = input as { filter?: string }
          return { content: orchestrator.listAgents(filter) }
        }
      })

      editor.add({
        name: "costs",
        description: "Get cost report and budget status",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        execute: async () => {
          return { content: orchestrator.getCostReport() }
        }
      })

      editor.add({
        name: "dashboard",
        description: "Get full orchestrator state for dashboard display",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        execute: async () => {
          const state = orchestrator.getState()
          await ctx.storage.set("orchestrator-state", JSON.parse(JSON.stringify(state)))
          return { content: JSON.stringify(state, null, 2) }
        }
      })

      editor.add({
        name: "queue",
        description: "Show current task queue with priorities",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        execute: async () => {
          const state = orchestrator.getState()
          const tasks = state.tasks || []
          return { content: JSON.stringify(tasks, null, 2) }
        }
      })

      editor.add({
        name: "config.save",
        description: "Save Nexus config to disk (project or global)",
        input: {
          type: "object",
          properties: {
            level: { type: "string", enum: ["project", "global"], description: "Config level to save" },
            basePath: { type: "string", description: "Project root (for project-level, defaults to cwd)" }
          },
          required: ["level"],
          additionalProperties: false
        },
        execute: async (input: unknown) => {
          const { level, basePath } = input as { level: 'project' | 'global'; basePath?: string }
          orchestrator.configManager.saveConfig(level, basePath || process.cwd())
          const location = level === 'project'
            ? `${basePath || process.cwd()}/.opencode/nexus.jsonc`
            : '~/.config/opencode/nexus.jsonc'
          return { content: `Config saved to ${level} level at ${location}` }
        }
      })

      editor.add({
        name: "config.init",
        description: "Initialize default config files for project and/or global",
        input: {
          type: "object",
          properties: {
            level: { type: "string", enum: ["project", "global", "both"], description: "Which config to initialize" },
            basePath: { type: "string", description: "Project root" }
          },
          required: ["level"],
          additionalProperties: false
        },
        execute: async (input: unknown) => {
          const { level, basePath } = input as { level: 'project' | 'global' | 'both'; basePath?: string }
          const path = basePath || process.cwd()
          const locations: string[] = []
          if (level === 'project' || level === 'both') {
            orchestrator.configManager.initProjectConfig(path)
            locations.push(`${path}/.opencode/nexus.jsonc`)
          }
          if (level === 'global' || level === 'both') {
            orchestrator.configManager.initGlobalConfig()
            locations.push('~/.config/opencode/nexus.jsonc')
          }
          return { content: `Config initialized at ${level} level(s): ${locations.join(', ')}` }
        }
      })

      editor.add({
        name: "preset",
        description: "Apply a preset configuration",
        input: {
          type: "object",
          properties: {
            name: { type: "string", description: "Preset name (minimal, balanced, enterprise, cost-optimized)" }
          },
          required: ["name"],
          additionalProperties: false
        },
        execute: async (input: unknown) => {
          const { name } = input as { name: string }
          try {
            orchestrator.configManager.applyPreset(name)
            return { content: `Applied preset: ${PRESETS[name]?.name || name}` }
          } catch (error: any) {
            return { content: `Error: ${error.message}` }
          }
        }
      })

      editor.add({
        name: "dashboard.start",
        description: "Start the web dashboard server",
        input: {
          type: "object",
          properties: {
            port: { type: "number", description: "Port (default: 4747)" },
            host: { type: "string", description: "Host (default: 127.0.0.1)" }
          },
          additionalProperties: false
        },
        execute: async (input: unknown) => {
          const { port, host } = input as { port?: number; host?: string }
          orchestrator.startDashboard(port, host)
          return { content: `Dashboard started at http://${host || '127.0.0.1'}:${port || 4747}` }
        }
      })

      editor.add({
        name: "dashboard.stop",
        description: "Stop the web dashboard server",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        execute: async () => {
          orchestrator.stopDashboard()
          return { content: "Dashboard stopped" }
        }
      })

      editor.add({
        name: "model.costs",
        description: "Show real model pricing from OpenCode or set custom costs",
        input: {
          type: "object",
          properties: {
            model: { type: "string", description: "Model ID to show cost for (optional, shows all if omitted)" },
            setInput: { type: "number", description: "Set input cost per token for a model" },
            setOutput: { type: "number", description: "Set output cost per token for a model" }
          },
          additionalProperties: false
        },
        execute: async (input: unknown) => {
          const { model, setInput, setOutput } = input as { model?: string; setInput?: number; setOutput?: number }

          if (model && setInput !== undefined && setOutput !== undefined) {
            // Set custom cost
            orchestrator.setModelCosts({ [model]: { input: setInput, output: setOutput } })
            return { content: `Set ${model}: input=$${setInput}/token, output=$${setOutput}/token` }
          }

          if (model) {
            // Show specific model cost
            const cost = orchestrator.modelCosts.get(model)
            if (cost) {
              return { content: `${model}: input=$${cost.input}/token, output=$${cost.output}/token, cache_read=$${cost.cacheRead}/token, cache_write=$${cost.cacheWrite}/token` }
            }
            // Fallback to hardcoded estimate
            const estimate = orchestrator['estimateModelCost'](model)
            return { content: `${model}: no real pricing data (estimated $${estimate}/1K tokens)` }
          }

          // Show all loaded costs
          if (orchestrator.modelCosts.size > 0) {
            const lines = ['📊 Model Pricing (from OpenCode):']
            for (const [id, cost] of orchestrator.modelCosts) {
              lines.push(`  ${id}: $${cost.input}/token in, $${cost.output}/token out`)
            }
            return { content: lines.join('\n') }
          }
          return { content: 'No real pricing data loaded. Using hardcoded estimates.' }
        }
      })

      editor.add({
        name: "spawn",
        description: "Spawn a sub-agent for a task. Use wait=true to wait for completion.",
        input: {
          type: "object",
          properties: {
            role: { type: "string", description: "Agent role (architect, coder, reviewer, tester, explorer, documenter)" },
            task: { type: "string", description: "Task description" },
            model: { type: "string", description: "Model override (optional)" },
            wait: { type: "boolean", description: "Wait for completion (default: false)" },
            timeout: { type: "number", description: "Timeout in ms when waiting (default: 120000)" }
          },
          required: ["role", "task"],
          additionalProperties: false
        },
        execute: async (input: unknown) => {
          const { role, task, model, wait, timeout } = input as { role: string; task: string; model?: string; wait?: boolean; timeout?: number }
          try {
            // Store current session ID as parent
            orchestrator.parentSessionID = null // Will be set by OpenCode context if available

            const agent = await orchestrator.spawnAgent({ role, model })
            await orchestrator.ctx.session.prompt({
              sessionID: agent.sessionID!,
              text: task
            })

            // If wait is requested, wait for completion
            if (wait) {
              const waitTimeout = timeout || 120000
              try {
                await orchestrator.ctx.session.wait({ sessionID: agent.sessionID! })
              } catch {
                // Timeout or error — agent may still be running
              }

              // Get results
              try {
                const messages = await orchestrator.ctx.session.context({ sessionID: agent.sessionID! })
                const lastMsg = messages.filter((m: any) => m.role === 'assistant').pop()
                const result = lastMsg?.content || 'Task completed (no output captured)'

                agent.status = 'completed'
                await ctx.storage.set("orchestrator-state", JSON.parse(JSON.stringify(orchestrator.getState())))

                const taskPreview = task.length > 80 ? task.substring(0, 77) + '...' : task
                return {
                  content: [
                    `${agent.name}`,
                    `📋 Task: ${taskPreview}`,
                    `✅ Status: completed`,
                    `📎 Session: ${agent.sessionID}`,
                    `\n--- Result ---`,
                    result
                  ].join('\n')
                }
              } catch {
                // Context read failed
              }
            }

            // Analyze task complexity for informational output
            const complexity = orchestrator.analyzeComplexity({
              id: `spawn-${Date.now()}`,
              name: task,
              description: task,
              files: { include: [] },
              dependencies: [],
              requiredRole: role,
              complexity: { overall: 0, factors: { fileCount: 0, codeLines: 0, dependencyDepth: 0, domainKnowledge: 0, riskLevel: 'low' } },
              priority: 'normal',
              status: 'running'
            })

            // Store complexity on agent
            agent.complexity = complexity

            // Get model selection reasoning
            const modelSelection = orchestrator.selectModel(role, complexity)

            await ctx.storage.set("orchestrator-state", JSON.parse(JSON.stringify(orchestrator.getState())))
            const taskPreview = task.length > 80 ? task.substring(0, 77) + '...' : task
            const output = [
              `${agent.name}`,
              `📋 Task: ${taskPreview}`,
              `📊 Complexity: ${complexity.overall}/100 (${complexity.factors.riskLevel} risk)`,
              `🤖 Model reasoning: ${modelSelection.reasoning}`,
              `📎 Session: ${agent.sessionID}`,
              `💡 Use wait=true to wait for completion`
            ].join('\n')
            return { content: output }
          } catch (error: any) {
            return { content: `Failed to spawn agent: ${error.message}` }
          }
        }
      })

      editor.add({
        name: "template",
        description: "List or instantiate task templates",
        input: {
          type: "object",
          properties: {
            name: { type: "string", description: "Template name to instantiate (or 'list' to show all)" },
            baseDir: { type: "string", description: "Base directory for file paths" }
          },
          additionalProperties: false
        },
        execute: async (input: unknown) => {
          const { name, baseDir } = input as { name?: string; baseDir?: string }
          if (!name || name === 'list') {
            const templates = listTemplates()
            return { content: templates.map(t => `${t}: ${TEMPLATES[t].description}`).join('\n') }
          }
          try {
            const tasks = instantiateTemplate(name, baseDir || process.cwd())
            return { content: JSON.stringify(tasks, null, 2) }
          } catch (error: any) {
            return { content: `Error: ${error.message}` }
          }
        }
      })

      editor.add({
        name: "performance.scores",
        description: "Show agent performance scores by model and role",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        execute: async () => {
          const scores = orchestrator.performanceTracker.getScores()
          if (scores.length === 0) return { content: "No performance data yet. Scores build up as tasks are executed." }
          const lines = scores.map(s => `${s.role}/${s.model}: score=${s.overallScore.toFixed(1)} success=${(s.successRate*100).toFixed(0)}% avg=$${s.avgCost.toFixed(4)} (${s.totalTasks} tasks)`)
          return { content: lines.join('\n') }
        }
      })

      editor.add({
        name: "performance.best",
        description: "Get best model for a specific role",
        input: {
          type: "object",
          properties: {
            role: { type: "string", description: "Agent role to find best model for" }
          },
          required: ["role"],
          additionalProperties: false
        },
        execute: async (input: unknown) => {
          const { role } = input as { role: string }
          const best = orchestrator.performanceTracker.getBestModel(role)
          if (!best) return { content: `No performance data for role '${role}' yet.` }
          return { content: `Best for ${role}: ${best.model} (score: ${best.overallScore.toFixed(1)}, success: ${(best.successRate*100).toFixed(0)}%, avg cost: $${best.avgCost.toFixed(4)})` }
        }
      })

      editor.add({
        name: "security.scan",
        description: "Scan content for security issues",
        input: {
          type: "object",
          properties: {
            content: { type: "string", description: "Code content to scan" },
            filename: { type: "string", description: "Filename for context" }
          },
          required: ["content"],
          additionalProperties: false
        },
        execute: async (input: unknown) => {
          const { content, filename } = input as { content: string; filename?: string }
          const issues = orchestrator.securityScanner.scanContent(content, filename || 'unknown')
          const result = orchestrator.securityScanner.getResult()
          return { content: JSON.stringify({ issues: issues.length, score: result.score, details: issues }, null, 2) }
        }
      })

      editor.add({
        name: "history.list",
        description: "List execution history",
        input: {
          type: "object",
          properties: {
            count: { type: "number", description: "Number of recent entries" }
          },
          additionalProperties: false
        },
        execute: async (input: unknown) => {
          const { count } = input as { count?: number }
          const records = count ? orchestrator.executionHistory.getRecent(count) : orchestrator.executionHistory.getAll()
          if (records.length === 0) return { content: "No execution history yet." }
          const lines = records.map(r => `${r.status === 'success' ? '✅' : '❌'} ${r.taskName} (${r.role}) — $${r.cost.toFixed(4)} — ${r.duration}ms`)
          return { content: lines.join('\n') }
        }
      })

      editor.add({
        name: "history.stats",
        description: "Show execution statistics",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        execute: async () => {
          const stats = orchestrator.executionHistory.getStats()
          return { content: `Total: ${stats.total} | Success: ${(stats.successRate * 100).toFixed(1)}% | Cost: $${stats.totalCost.toFixed(4)} | Avg: ${stats.avgDuration.toFixed(0)}ms\nBy role: ${JSON.stringify(stats.byRole)}` }
        }
      })

      editor.add({
        name: "roles.list",
        description: "List all custom agent roles",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        execute: async () => {
          const roles = orchestrator.customRoles.list()
          if (roles.length === 0) return { content: "No custom roles defined. Add them in .opencode/nexus.jsonc under 'customRoles'." }
          const lines = roles.map(r => `${r.emoji} ${r.displayName} (${r.name}): ${r.prompt.substring(0, 60)}...`)
          return { content: lines.join('\n') }
        }
      })

      editor.add({
        name: "roles.add",
        description: "Add a custom agent role",
        input: {
          type: "object",
          properties: {
            name: { type: "string", description: "Role identifier (lowercase, no spaces)" },
            displayName: { type: "string", description: "Display name" },
            emoji: { type: "string", description: "Emoji for the role" },
            prompt: { type: "string", description: "System prompt for this role" },
            model: { type: "string", description: "Default model (optional)" }
          },
          required: ["name", "displayName", "prompt"]
        },
        execute: async (input: unknown) => {
          const { name, displayName, emoji, prompt, model } = input as any
          orchestrator.customRoles.register({ name, displayName, emoji: emoji || '🤖', prompt, model })
          return { content: `Custom role '${displayName}' registered` }
        }
      })

      editor.add({
        name: "forecast",
        description: "Estimate cost before executing tasks",
        input: {
          type: "object",
          properties: {
            tasks: { type: "string", description: "JSON array of tasks with role, model, and complexity" }
          },
          required: ["tasks"]
        },
        execute: async (input: unknown) => {
          const { tasks } = input as { tasks: string }
          const taskList = JSON.parse(tasks)
          const remaining = orchestrator.budget.maxTotalCost - orchestrator.totalSpent
          const result = orchestrator.forecaster.forecastAll(taskList, remaining)
          const lines = result.estimates.map(e => `${e.taskName}: ~$${e.estimatedCost.toFixed(4)} (${e.model})`)
          lines.push(`\nTotal: ~$${result.totalEstimatedCost.toFixed(4)}`)
          lines.push(`Budget remaining: $${remaining.toFixed(2)}`)
          lines.push(`Within budget: ${result.withinBudget ? '✅' : '❌'}`)
          return { content: lines.join('\n') }
        }
      })

      editor.add({
        name: "worktree.enable",
        description: "Enable git worktree isolation for agents",
        input: { type: "object", properties: { repoRoot: { type: "string", description: "Repository root (defaults to cwd)" } } },
        execute: async (input: unknown) => {
          const { repoRoot } = input as { repoRoot?: string }
          orchestrator.enableWorktrees(repoRoot || process.cwd())
          return { content: "Git worktree isolation enabled." }
        }
      })

      editor.add({
        name: "worktree.list",
        description: "List active agent worktrees",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => {
          if (!orchestrator.worktreeManager) return { content: "Worktree isolation not enabled." }
          const wts = orchestrator.worktreeManager.list()
          if (wts.length === 0) return { content: "No active worktrees." }
          return { content: wts.map(w => `${w.agentId}: ${w.path}`).join('\n') }
        }
      })

      editor.add({
        name: "worktree.disable",
        description: "Disable worktree isolation and clean up",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => {
          if (orchestrator.worktreeManager) {
            orchestrator.worktreeManager.cleanupAll()
            orchestrator.worktreeManager = null
          }
          return { content: "Worktree isolation disabled." }
        }
      })

      editor.add({
        name: "sessions",
        description: "List all active Nexus agent sessions",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => {
          const agents = orchestrator.getState().agents
          if (agents.length === 0) return { content: "No active agent sessions." }
          const lines = agents.map((a: any) => {
            const statusIcon = a.status === 'working' ? '🔄' : a.status === 'idle' ? '⏸️' : a.status === 'completed' ? '✅' : '❌'
            return `${statusIcon} ${a.name} (${a.role}) — Session: ${a.sessionID}`
          })
          return { content: `Active Sessions (${agents.length}):\n${lines.join('\n')}` }
        }
      })

      editor.add({
        name: "background",
        description: "Move running agents to background (detach from current session)",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => {
          // Get all running agents and detach their sessions
          const agents = orchestrator.getState().agents.filter((a: any) => a.status === 'working' || a.status === 'idle')
          if (agents.length === 0) return { content: "No running agents to move to background." }

          for (const agent of agents) {
            try {
              await orchestrator.ctx.session.background({ sessionID: agent.sessionID })
            } catch {
              // Background may not be supported in all contexts
            }
          }
          return { content: `${agents.length} agent(s) moved to background. You can continue working while they run.` }
        }
      })

      editor.add({
        name: "result",
        description: "Get the result of a completed agent session",
        input: {
          type: "object",
          properties: {
            sessionID: { type: "string", description: "Session ID of the agent" }
          },
          required: ["sessionID"]
        },
        execute: async (input: unknown) => {
          const { sessionID } = input as { sessionID: string }
          try {
            const messages = await orchestrator.ctx.session.context({ sessionID })
            const lastMsg = messages.filter((m: any) => m.role === 'assistant').pop()
            if (lastMsg) {
              return { content: `Session ${sessionID} result:\n${lastMsg.content}` }
            }
            return { content: `Session ${sessionID} has no assistant messages yet.` }
          } catch (error: any) {
            return { content: `Failed to get result: ${error.message}` }
          }
        }
      })
    })

    // Register session hook for /nexus commands
    await ctx.session.hook("prompt", (event) => {
      if (event.prompt.text.startsWith("/nexus")) {
        const result = orchestrator.handleCommand(event.prompt.text)
        // The result goes to the session as tool output context
        event.metadata = { ...event.metadata, nexusResult: result }
      }
    })

    return () => {
      orchestrator.shutdown()
    }
  }
})

export { NexusOrchestrator } from "./orchestrator"
export { StateBroadcaster } from "./broadcast"
export { NexusConfigManager, DEFAULT_CONFIG, PRESETS } from "./config"
export type { NexusModelConfig, NexusFullConfig, NexusPreset } from "./config"
export { detectCycles } from "./dag"
export { MessageStore } from "./message-store"
export type { MessageStoreConfig } from "./message-store"
export { PersistentMemoryStore } from "./memory-store"
export type { MemoryStoreConfig } from "./memory-store"
export { MessageRouter } from "./fanout"
export type { FanOutRouter } from "./fanout"
export { HealthMonitor } from "./health"
export type { HealthCheck, HealthConfig } from "./health"
export { LearningModule } from "./learning"
export type { LearningEntry, PatternMatch } from "./learning"
export type { Agent, Task, DAG, ExecutionRequest, ExecutionResult } from "./types"
export { TEMPLATES, instantiateTemplate, listTemplates, getTemplate } from "./templates"
export type { TaskTemplate, TaskTemplateStep } from "./templates"
export { ModuleRegistry } from "./modules"
export type { NexusModule, ModuleContext, ModuleTool, ModuleHook } from "./modules"
export { SecurityScanner } from "./security"
export type { SecurityIssue, SecurityScanResult, SecurityConfig } from "./security"
export { PerformanceTracker } from "./performance"
export type { PerformanceEntry, PerformanceScore } from "./performance"
export { CustomRoleManager } from "./custom-roles"
export type { CustomRole } from "./custom-roles"
export { CostForecaster } from "./forecast"
export type { CostEstimate, ForecastResult } from "./forecast"
export { WorktreeManager } from "./worktree"
export type { AgentWorktree } from "./worktree"
