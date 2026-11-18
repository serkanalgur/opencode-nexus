/** Worktree and git convention tools. Registered from `setup()` in `src/index.ts`. */
import type { ToolEditor, ToolDeps } from "./deps"

export function registerGitTools(editor: ToolEditor, deps: ToolDeps): void {
  const { orchestrator } = deps

  editor.add({
    name: "worktree.enable",
    description: "Enable git worktree isolation for agents",
    input: { type: "object", properties: { repoRoot: { type: "string", description: "Repository root (defaults to cwd)" } } },
    options: { codemode: true },
    execute: async (input: unknown) => {
      const { repoRoot } = input as { repoRoot?: string }
      orchestrator.enableWorktrees(repoRoot || process.cwd())
      return { content: "Git worktree isolation enabled." }
    }
  })

  // Reports, never blocks. The description says so in the tool's own
  // listing, because the single most important property of this tool is the
  // one a model cannot infer from its name: it does not change the
  // repository, and it does not refuse.
  editor.add({
    name: "git.check",
    description: "Report on the git convention for this repository: branch, conventional commit subjects, and whether the branch is published. Read-only — it runs no git commit, push or merge, and never refuses. With `decision`, record this repository's one-time answer instead.",
    input: {
      type: "object",
      properties: {
        decision: {
          type: "string",
          enum: ["on", "off"],
          description: "Record the answer for this repository and stop asking. Omit to just report."
        },
        cwd: { type: "string", description: "Directory to inspect. Defaults to the working directory." }
      },
      additionalProperties: false
    },
    options: { codemode: true },
    execute: async (input: unknown) => {
      const { decision, cwd } = input as { decision?: 'on' | 'off'; cwd?: string }
      try {
        if (decision) {
          const recorded = orchestrator.recordGitFlowDecision(decision, cwd)
          return {
            content: [
              `Recorded the git convention decision for this repository: ${recorded}.`,
              `It is keyed by the resolved repository root and stored in ~/.config/opencode/nexus-gitflow.json,`,
              `which is nexus's own global config directory — nothing was written to your repository and no git command was run.`,
              `This will not be asked again for this repository.`,
              `Current effective state: ${orchestrator.resolveGitFlow(cwd).reason}`
            ].join(' ')
          }
        }
        const report = orchestrator.checkGitFlow(cwd)
        // STATUS-SHAPED, and the ask travels through here. A subagent is
        // driven by tool calls and has no channel to a human, so the only
        // way to ask is to TELL the agent it must ask: the instruction is
        // in the tool result the agent is already reading, and the agent
        // carries it to the user in its own next message. It is emitted only
        // when the answer is genuinely undecided, so a second run in a repo
        // that has already answered stays silent.
        const lines = [
          report.summary,
          '',
          ...report.commits.map(c => `  ${c.conventional ? '✅' : '❌'} ${c.sha.slice(0, 8)} ${c.subject}`),
          report.commits.length === 0 ? '  (no commit subjects were read)' : '',
          '',
          `Scope: commits on this branch since \`${report.scope.base}\` (${report.scope.baseSource}).`,
          `This check ${report.didNot.join('; ')}.`
        ].filter(Boolean)
        if (report.decision === null) {
          lines.push('',
            'ACTION FOR YOU, NOT FOR A TOOL: the git convention is enabled by default and no answer has been recorded for this repository.',
            'Ask the user ONCE, in your own reply, and do not proceed past the question without an answer:',
            '  1. whether nexus should follow the branch / conventional-commit / PR path in this repository, or stay out of its git entirely;',
            '  2. then call this tool again with decision: "on" or decision: "off" to record the answer.',
            'Report what you found either way — this tool never refuses and never writes to the repository.'
          )
        }
        return { content: lines.join('\n') }
      } catch (err) {
        // The one failure this tool can surface is a decision recorded
        // outside a repository, which is a genuine "there is nothing to
        // record" rather than a crash. Reported as text, because a tool
        // result the agent can read and relay beats an exception it has to
        // interpret.
        return { content: `git.check could not complete: ${err instanceof Error ? err.message : String(err)}. No git command was run and nothing was written.` }
      }
    }
  })

  editor.add({
    name: "worktree.list",
    description: "List active agent worktrees",
    input: { type: "object", properties: {}, additionalProperties: false },
    options: { codemode: true },
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
    options: { codemode: true },
    execute: async () => {
      if (orchestrator.worktreeManager) {
        orchestrator.worktreeManager.cleanupAll()
        orchestrator.worktreeManager = null
      }
      return { content: "Worktree isolation disabled." }
    }
  })
}
