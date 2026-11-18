/**
 * The bundled agent definitions in `assets/agents/` and the git-flow section
 * appended to them. Moved out of `src/index.ts` unchanged; `setup()` writes
 * the files.
 */
import type { NexusGitFlowConfig } from "./config"
import { CONVENTIONAL_COMMIT_TYPES, type GitState } from "./git-flow"
import { readFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Bundled agent markdown, resolved relative to this module exactly as
 * `nexusSkillsDir()` resolves `skills/` — so a published package finds it at
 * `<pkg>/assets/agents`, and a source checkout finds it at the repo root. The
 * `'..'` is the same hop `dist/index.js` and `src/index.ts` both need.
 */
export function nexusAgentsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'agents')
}

/** The sub-agent roles written on setup, in the order they are installed. */
const NEXUS_SUBAGENT_FILES = [
  'nexus-architect.md',
  'nexus-coder.md',
  'nexus-designer.md',
  'nexus-documenter.md',
  'nexus-explorer.md',
  'nexus-reviewer.md',
  'nexus-tester.md',
] as const

/**
 * One bundled agent definition, by filename.
 *
 * THROWS on a missing asset rather than returning an empty string. The
 * installer writes whatever it is handed without validating it, so a missing
 * file would otherwise install a silently incomplete agent set — and the roles
 * that went missing are exactly the ones `spawnAgent`'s `agentTypeMap` still
 * maps, so the failure would surface much later as a wrong-agent spawn. Naming
 * the missing path at setup is the cheap way to say it instead.
 */
export function readNexusAgent(name: string): string {
  const path = join(nexusAgentsDir(), name)
  if (!existsSync(path)) {
    throw new Error(`[nexus] missing bundled agent definition: ${path}`)
  }
  return readFileSync(path, 'utf-8')
}

/**
 * Every bundled sub-agent, keyed by filename.
 *
 * Eager, so a partial asset directory fails here — at setup, naming the file —
 * rather than after an agent has been spawned into the wrong role.
 */
export function readNexusSubagents(): Record<string, string> {
  const agents: Record<string, string> = {}
  for (const name of NEXUS_SUBAGENT_FILES) {
    agents[name] = readNexusAgent(name)
  }
  return agents
}


/**
 * The git convention, as markdown appended to every generated agent file.
 *
 * WHY IT IS A FUNCTION OF THE CONFIG BLOCK AND NOT A CONSTANT: each of the four
 * keys has to be able to switch off the sentence it names, or the key would be
 * a knob that reads as a control and is inert — the defect this repository has
 * shipped twice (`dashboard.enabled`, `notifications.enabled`). Every clause
 * below is therefore reachable from exactly one key, and a clause whose key is
 * off is not emitted at all.
 *
 * The wording is DELIBERATELY about the agent's own conduct. It does not say
 * "nexus will reject", because nothing here rejects anything: the check reports
 * and the user decides. An agent told it will be blocked starts gaming the
 * check; an agent told what is expected simply does the work.
 */
export function buildGitFlowConventionSection(
  config: NexusGitFlowConfig,
  state: GitState
): string {
  const lines: string[] = [
    '## Git Convention',
    '',
    `This project is a git work tree${state.branch ? `, currently on \`${state.branch}\`` : ''}. Follow the conventions below unless the user tells you otherwise.`,
    ''
  ]

  if (config.requireBranch) {
    lines.push(
      '- **Work on a branch.** Do not commit directly to the default branch. If the user asks for a change, create or use a feature branch for it.',
      '- Never create a branch, switch branches, or run any git command that rewrites history unless the user asked for it in this conversation.',
      ''
    )
  }

  if (config.conventionalCommits) {
    lines.push(
      '- **Conventional commit subjects.** When you are asked to commit, the subject line is `type(scope): description`, where `type` is one of '
        + CONVENTIONAL_COMMIT_TYPES.join(', ')
        + '. A `!` before the colon marks a breaking change. Example: `feat(parser): support nested arrays`.',
      '- Keep the subject under ~72 characters and in the imperative mood ("add", not "added").',
      ''
    )
  }

  if (config.prBeforeMerge) {
    lines.push(
      '- **Open a pull request; do not merge.** When work is ready for review, push the branch and open a PR rather than merging it into the branch you are on.',
      ''
    )
  }

  lines.push(
    '- **Never commit, push, or merge on your own initiative.** Report the change you made and let the user decide. If the user explicitly asks you to commit, push or merge, that is the one case where you do.',
    '- **No attribution trailers.** Never add `Co-Authored-By` or any similar trailer (e.g. `Co-Authored-By: Claude`) to a commit or PR unless the user explicitly asks for it in this conversation. Do not infer authorship from the model in use.',
    '',
    'You can check where things stand with `nexus.git.check`. It only reports — it never changes anything and never refuses.',
    '',
    'The `gitFlow` block in `.opencode/nexus.jsonc` controls which of these apply. Setting `gitFlow.enabled: false` removes this section entirely on the next plugin start.'
  )

  return lines.join('\n')
}
