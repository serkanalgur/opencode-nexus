# Claude Code Compatibility

This document describes how Nexus works with Claude Code features including hooks, commands, skills, and MCP servers.

## Overview

Nexus is designed as an OpenCode plugin and does not directly run inside Claude Code. However, many Claude Code workflows and patterns are compatible or have workarounds.

## Compatibility Matrix

| Feature | Status | Notes |
|---------|--------|-------|
| Hooks | ✅ Supported | OpenCode plugin hooks work the same way |
| Commands (slash) | ✅ Supported | Nexus registers `/nexus` commands in OpenCode TUI |
| Skills | ✅ Supported | Nexus agent prompts work as OpenCode skills |
| MCP Servers | ✅ Supported | OpenCode supports MCP; Nexus tools register via plugin API |
| Sub-agents | ✅ Supported | `nexus.spawn()` creates real OpenCode sessions |
| Agent names | ⚠️ Partial | Nexus uses OpenCode agent types, not Claude Code agent names |
| CLAUDE.md | ❌ Not applicable | Nexus uses `.opencode/nexus.jsonc` for config |
| Headless mode | ⚠️ Partial | Nexus tools work headless; TUI features require OpenCode TUI |

## What Works

### Hooks
Nexus registers session hooks via `ctx.session.hook()` which is equivalent to Claude Code's hook system. The hook intercepts `/nexus` commands and routes them to the orchestrator.

### Commands
Nexus registers the following slash commands in OpenCode's command palette:
- `/nexus` — Main entry point (config wizard)
- `/nexus config` — Configure models and budget
- `/nexus status` — Show orchestrator status
- `/nexus dashboard` — Show dashboard summary
- `/nexus web` — Start web dashboard
- `/nexus model` — Select model for a role
- `/nexus reset` — Reset configuration
- `/nexus review` — Quick code review (Claude Code–style)
- `/nexus fix` — Fix last error (Claude Code–style)
- `/nexus explain` — Explain last change (Claude Code–style)

### Skills
Nexus agent prompts (nexus-orchestrator, nexus-coder, etc.) are registered as OpenCode agents which function like Claude Code skills. Each agent has a specialized system prompt and permissions.

### MCP Servers
Nexus registers its tools via `ctx.tool.transform()` which is OpenCode's equivalent of MCP tool registration. The tools (`nexus.status`, `nexus.spawn`, `nexus.costs`, etc.) are available to any agent session.

### Sub-agents
`nexus.spawn()` creates real OpenCode sessions linked to the parent via `parentID`. This is functionally equivalent to Claude Code's sub-agent spawning.

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
| `/review` | `/nexus review` command |
| `CLAUDE.md` | `.opencode/nexus.jsonc` |
| Sub-agents | `nexus.spawn()` / `nexus.delegate()` |
| Skills | OpenCode agent files in `~/.config/opencode/agents/` |
| MCP | `nexus.*` tools registered via plugin API |
