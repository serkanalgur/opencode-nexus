# Claude Code Compatibility

This document describes how Nexus works with Claude Code features including hooks, commands, skills, and MCP servers.

## Overview

Nexus is designed as an OpenCode plugin and does not directly run inside Claude Code. However, many Claude Code workflows and patterns are compatible or have workarounds.

## Compatibility Matrix

| Feature | Status | Notes |
|---------|--------|-------|
| Hooks | ✅ Supported | OpenCode plugin hooks work the same way |
| Commands (slash) | ✅ Supported | Nexus registers `/nexus` commands in OpenCode TUI |
| Skills | ✅ Supported | Nexus installs three design skills (`nexus-design-taste`, `nexus-interface-a11y`, `nexus-design-review`) to `~/.config/opencode/skills/` on plugin load — see Skills below |
| MCP Servers | ✅ Supported | OpenCode supports MCP; Nexus tools register via plugin API |
| Sub-agents | ⚠️ Partial | `nexus.spawn()` creates real OpenCode sessions, but only the `subagent`-tool path links them to a parent via `parentID` — see Sub-agents below |
| Agent names | ⚠️ Partial | Nexus uses OpenCode agent types, not Claude Code agent names |
| CLAUDE.md | ❌ Not applicable | Nexus uses `.opencode/nexus.jsonc` for config |
| Headless mode | ⚠️ Partial | Nexus tools work headless; TUI features require OpenCode TUI |

## What Works

### Hooks
Nexus registers session hooks via `ctx.session.hook()` which is equivalent to Claude Code's hook system. The hook intercepts `/nexus` commands and routes them to the orchestrator.

### Commands
The TUI plugin registers these slash commands in OpenCode's command palette:

| Slash command | What it does |
|---------------|--------------|
| `/nexus` | Main entry point; with an argument, one of the subcommands below |
| `/nexus config`, `/nexus-config` | Configure models and budget |
| `/nexus status`, `/nexus-status` | Show the config summary |
| `/nexus dashboard [port] [host]`, `/nexus-dashboard` | Start the web dashboard and open it in a browser (see below) |
| `/nexus web [port] [host]`, `/nexus-web` | Alias of `/nexus dashboard` |
| `/nexus overview`, `/nexus-overview` | Show a config/budget/dashboard-status overview. **It does not start or open anything** — it prints text |
| `/nexus model <role>`, `/nexus-model` | Select the model for a role |
| `/nexus reset`, `/nexus-reset` | Reset configuration to defaults |

**Any other subcommand is submitted to the server verbatim and answered there.**
`/nexus agents [filter]`, `/nexus costs`, `/nexus pause` and `/nexus resume` are
implemented by `handleCommand` in the server process (see the second `/nexus`
below) and are reachable from the TUI: the TUI forwards whatever it does not
handle itself, so a subcommand added to the server works from the TUI with no
TUI change, and the server's own `Unknown command. Available: …` reply is the
one list of what it accepts. `agents` takes an optional filter, read as
`parts[2]`, and it is forwarded with the rest of the line. `status` and
`dashboard` are answered by the TUI on purpose — the first as a config summary,
the second as a browser-opening flow the server cannot perform — so they are not
forwarded even though the server also implements them.

**The TUI process cannot start the dashboard, but it can reach the process that
can.** The dashboard server runs in the OpenCode *server* process, beside the
orchestrator whose state it serves; the TUI plugin runs in the *TUI* process and
has no orchestrator, no module registry and no way to invoke a tool. It does have
the OpenCode client, which is an HTTP client to that same server process — so
`/nexus dashboard` submits `/nexus dashboard [port] [host]` as a prompt, and the
server's `session.prompt` hook routes it to `orchestrator.handleCommand()`, which
starts the server there.

The command then asks `http://host:port/api/health` and acts on the answer:

| What it found | What it does |
|---|---|
| A nexus dashboard | Opens your browser there. Nothing is started a second time |
| Another process on that port | Says so, opens nothing, suggests another port |
| Nothing there | Submits the start, then polls `/api/health` for a confirmed listen and opens the browser |
| Still nothing after ~3s | Reports that the start did not confirm; opens nothing and offers no URL |

It never opens a browser at an address it has not confirmed is serving a nexus
dashboard. A failure (port in use, `dashboard.enabled: false`) is reported as
what it is, with no URL in the message.

**There is a second, unrelated `/nexus` in the prompt.** A prompt beginning
`/nexus …` is intercepted by a `session.prompt` hook and routed to
`orchestrator.handleCommand()`, which supports a different and much smaller set:
`status`, `agents`, `costs`, `pause`, `resume`, `dashboard [port] [host]`,
`dashboard stop` and `dashboard state`. `dashboard` starts the server and reports
the address it bound; `dashboard state` returns the orchestrator state as JSON, a
state dump rather than a dashboard. Anything else, including `/nexus web` typed
into the composer, answers `Unknown command. Available: status, agents, costs,
pause, resume, dashboard [port] [host], dashboard stop, dashboard state`.

That hook cannot cancel the prompt: in `@opencode/plugin` the `prompt` hook
callback returns `void` and `SessionPrompt` has no `result`/`cancel` field, unlike
the `compaction` and `title` hooks, which do. So the hook sets
`event.metadata.nexusResult` and replaces the prompt text with the command's
result — the model reports what happened instead of being handed a bare
`/nexus dashboard` and an answer it has no reason to read.

### Skills
Claude Code's skill format is a directory under `~/.claude/skills/<name>/` holding a `SKILL.md` with YAML frontmatter. OpenCode uses the same layout under `~/.config/opencode/skills/<name>/`, and the `name` and `description` frontmatter fields mean the same thing in both: `description` is the only part a model sees before deciding to load the skill.

Nexus installs three skills of its own on every plugin load:

| Skill | Purpose |
|-------|---------|
| `nexus-design-taste` | Reference for the specific ways generated UI converges on a template, each with a concrete alternative |
| `nexus-interface-a11y` | WCAG 2.2 AA thresholds, cited by success criterion and level |
| `nexus-design-review` | Auditing an existing interface; reports, does not edit |

They are written by `installNexusSkills()` in `src/skills-install.ts`, called from the plugin's `setup()`. A file is written only when missing or when the shipped content differs from the on-disk content, so an unchanged load leaves mtimes alone; a skill whose `SKILL.md` is absent from the installed package is reported on stderr rather than failing silently. See the README for the `nexus-` prefix, the overwrite policy, and how to override.

**These are Nexus-authored skills, not Claude Code ones.** The wording this row previously carried — "Nexus agent prompts work as OpenCode skills" — was inaccurate on both sides. The generated `nexus-*.md` files under `~/.config/opencode/agents/` are *agents*, which carry a role, a model and a permission block, and OpenCode does not read them as skills; and the three skills above are new prose written for this package, containing no Claude Code material. What the row now claims is narrower and true: Nexus ships real `SKILL.md` files in the directory layout OpenCode reads.

### MCP Servers
Nexus registers its tools via `ctx.tool.transform()` which is OpenCode's equivalent of MCP tool registration. The tools (`nexus.status`, `nexus.spawn`, `nexus.costs`, etc.) are available to any agent session.

### Sub-agents
`nexus.spawn()` creates a real OpenCode session, by one of two paths, and they
are not equivalent:

- **Via the `subagent` tool**, when a parent tool context is available: OpenCode
  creates the child and links it to the parent via `parentID`.
- **Via `ctx.session.create()`**, when no parent tool context is supplied (the
  internal scheduler and respawn paths) or the `subagent` tool is unavailable:
  the session is created **unlinked**. Nexus records this in
  `orchestrator.lastDegradedSpawn` and warns at the call site, because an
  unlinked child does not appear under its parent's tree.

This is why the dashboard's Sessions view is built from nexus's own bookkeeping
rather than by walking `parentID` — a `parentID` walk would miss every
unlinked child — and why the TUI sidebar documents the same limitation.
`nexus.delegate()` goes through the same two paths.

## What Doesn't Work (and Workarounds)

### CLAUDE.md Configuration
**Why:** CLAUDE.md is a Claude Code–specific configuration file. Nexus uses `.opencode/nexus.jsonc` for project config and `~/.config/opencode/nexus.jsonc` for global config.

**Workaround:** Use Nexus's own config files. The configuration format is documented in `docs/API.md`.

### Claude Code Agent Names
**Why:** Nexus maps roles to OpenCode agent types (e.g., `coder` → `build-orchestrator`), not Claude Code agent names.

**Workaround:** Nexus defines its own agent files (`nexus-coder.md`, `nexus-reviewer.md`, etc.) in `~/.config/opencode/agents/`. These work within OpenCode's agent system.

### Claude Code's `/compact` and Context Management
**Why:** Claude Code has built-in context compression commands. Nexus does not directly control OpenCode's context management.

**Workaround:** Use OpenCode's native context management. Nexus tools return concise results to minimize context usage.

### Claude Code's `/bug` Command
**Why:** `/bug` is a Claude Code–specific command for reporting issues.

**Workaround:** Nexus issues can be reported via GitHub. Use the `report` skill if available.

## Integration Patterns

### Using Nexus with Claude Code Workflows
If you use Claude Code for some tasks and OpenCode+Nexus for others:

1. **Shared config:** Place `.opencode/nexus.jsonc` in your project root. Both environments can read it.
2. **Shared agents:** Nexus agent files in `~/.config/opencode/agents/` are available to OpenCode sessions.
3. **Shared MCP:** If you run MCP servers for Claude Code, the same servers work in OpenCode.

### Running Nexus Tools from Claude Code
Nexus tools are registered as OpenCode plugin tools. They cannot be called directly from Claude Code sessions. To use Nexus orchestration from Claude Code, invoke the orchestrator through the OpenCode API or use the Nexus CLI.

## Quick Reference

| Claude Code Feature | Nexus Equivalent |
|--------------------|-----------------|
| `/compact` | OpenCode native context management |
| `/cost` | `nexus.costs()` tool |
| `/doctor` | `nexus.status(detailed=true)` tool |
| `/init` | `nexus.config.init()` tool |
| `/review` | Ask the agent to review the current change |
| `CLAUDE.md` | `.opencode/nexus.jsonc` |
| Sub-agents | `nexus.spawn()` / `nexus.delegate()` |
| Skills | OpenCode agent files in `~/.config/opencode/agents/` |
| MCP | `nexus.*` tools registered via plugin API |
