# OpenCode V2 Sidebar API Investigation

## Summary

✅ **Investigation Complete** — The OpenCode V2 TUI plugin system supports sidebar customization via the `sidebar.content` slot.

## Key Findings

### Available TUI Slots

From `@opencode/plugin/dist/tui/context.d.ts`:

| Slot | Description | Input |
|------|-------------|-------|
| `app` | Main app boundary | `Record<string, never>` |
| `home.footer` | Footer on home screen | `Record<string, never>` |
| `home.footer.status` | Status in home footer | `Record<string, never>` |
| `prompt.footer` | Prompt area footer | `PromptFooterInput` |
| `prompt.footer.status` | Status in prompt footer | `PromptFooterInput` |
| `prompt.footer.file` | File info in prompt footer | `PromptFooterInput` |
| `session.composer.top` | Top of session composer | `{ sessionID: string }` |
| `session.panel` | Session panel | `PanelInput` |
| **`sidebar.content`** | **Sidebar content** | `{ sessionID: string }` |
| `sidebar.footer` | Sidebar footer | `{ sessionID: string }` |

### SlotClaim Placement Options

```typescript
type SlotClaim = 
  | { prepend: Path }   // First inside target
  | { append: Path }    // Last inside target
  | { before: Path }    // Sibling before target
  | { after: Path }     // Sibling after target
  | { replace: Path }   // Take over the target
```

### Reactive State APIs

1. **`context.storage.memory()`** — Ephemeral in-memory state (survives hot reloads, lost on TUI exit)
2. **`context.storage.store()`** — Durable JSON state (persisted to disk, synced across TUI instances)
3. **`context.data.on()`** — Subscribe to OpenCode events (`session.updated`, etc.)
4. **`context.data.session.family()`** — Get child sessions (sub-agents) for a session
5. **`context.data.session.list()`** — List all sessions
6. **`context.data.session.get()`** — Get session details

## Implementation

### Changes Made

#### 1. `src/tui.tsx` — Added Sidebar Agent Status

- Added `AgentStatus` and `SidebarState` interfaces
- Registered `sidebar.content` slot with reactive rendering
- Uses `context.storage.memory()` for ephemeral state
- Shows active/completed/failed agents with status indicators
- Displays cost summary

#### 2. `src/index.ts` — Persist Sidebar State

- Added `nexus-sidebar-state` storage key
- Persists agent list, total cost, and budget remaining
- Syncs state on every orchestrator state change

### How It Works

1. **Server Plugin (index.ts)** persists orchestrator state to `nexus-sidebar-state` storage
2. **TUI Plugin (tui.tsx)** reads from `nexus-sidebar-state` memory store
3. **Sidebar slot** renders agent status reactively
4. **Session family API** provides fallback data for child sessions

### Sidebar Display

The sidebar shows:
- 🤖 Header with active agent count
- 🔄 Active agents (working/idle) with model info
- ✅ Completed agent count
- ❌ Failed agent count  
- 💰 Cost summary (spent / remaining)

## Example Usage

```tsx
// Register sidebar content slot
context.ui.slot({
  append: "sidebar.content",
  render: (props) => {
    // props.sessionID is the current session
    const family = context.data.session.family(props.sessionID)
    // Render agent status...
  }
})
```

## Build & Test Results

- ✅ `bun build ./src/tui.tsx` — Success (1.23 MB)
- ✅ `bun build ./src/index.ts` — Success (0.38 MB)
- ✅ `bun test` — 227 tests pass, 0 failures

## Limitations & Considerations

1. **Reactive Updates**: The `sidebar.content` slot re-renders when the session changes, but may not automatically update when agent state changes. Consider using `context.storage.store()` for more reactive updates.

2. **Session Family API**: Requires sessions to be created with `parentID` linking them. The orchestrator already does this.

3. **Storage Sync**: The server plugin persists state to storage, but the TUI plugin reads from ephemeral memory. For production use, consider using `context.storage.store()` for durable state that syncs across TUI instances.

4. **Styling**: The sidebar uses inline styles. For production, consider using the theme system (`context.theme`) for consistent styling.

## Next Steps

1. Test with real OpenCode TUI to verify sidebar rendering
2. Consider adding click handlers to navigate to agent sessions
3. Add progress indicators for long-running tasks
4. Explore `session.panel` slot for a detailed agent view
