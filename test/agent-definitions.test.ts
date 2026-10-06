import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Coverage for the bundled agent definitions in `assets/agents/`.
 *
 * WHY THIS EXISTS. The definitions are BUNDLED DATA, not code: nothing imports
 * them, `tsc` never reads them, and Biome does not lint them. They are read once
 * at plugin setup by `readNexusSubagents()` (`src/index.ts`) and written to
 * `~/.config/opencode/agents`. So every way this directory can break is invisible
 * to the type checker and to the linter:
 *
 *   - a role prompt deleted → `readNexusAgent` throws at setup, which
 *     `setup()`'s `catch` reports but cannot recover from: that role simply is
 *     not installed, and it surfaces much later as a wrong-agent spawn.
 *   - a permissions block lost → OpenCode DROPS the agent from the registry
 *     entirely. Not a degraded agent — no agent. This is the sharpest edge the
 *     whole plugin has, and it is a markdown file that no compiler reads.
 *
 * The one pre-existing check, in `test/spawn-subagent-tool.test.ts`, boots the
 * plugin and asserts the `action:`/`effect:` counts balance for
 * `nexus-coder.md` ALONE. That is real coverage of one file; the other six are
 * unguarded, and nothing asserts the directory's contents match the roles the
 * orchestrator can actually spawn.
 */

const AGENTS_DIR = join(import.meta.dir, '..', 'assets', 'agents')

/** Mirrors `agentTypeMap` in `src/orchestrator.ts` — the roles spawnAgent can resolve. */
const SPAWNABLE_ROLES = [
  'architect',
  'coder',
  'reviewer',
  'tester',
  'explorer',
  'documenter',
  'designer',
] as const

/** The orchestrator itself, installed separately and not in the role map. */
const ORCHESTRATOR = 'nexus-orchestrator.md'

function agentPath(name: string): string {
  return join(AGENTS_DIR, name)
}

function readAgent(name: string): string {
  return readFileSync(agentPath(name), 'utf8')
}

/**
 * The frontmatter block, or '' when there is none.
 *
 * Split on the delimiters rather than pattern-matching, because a file that has
 * lost its opening `---` still *contains* `action:` lines — a regex over the
 * whole body would find them and report the agent as healthy when it is exactly
 * the broken case this exists to catch.
 */
function frontmatterOf(content: string): string {
  if (!content.startsWith('---')) return ''
  const end = content.indexOf('\n---', 3)
  return end === -1 ? '' : content.slice(3, end)
}

describe('every spawnable role has a bundled agent definition', () => {
  it('ships one prompt per role, and no orphans', () => {
    const expected = [...SPAWNABLE_ROLES.map((r) => `nexus-${r}.md`), ORCHESTRATOR].sort()

    const onDisk = [...new Bun.Glob('nexus-*.md').scanSync({ cwd: AGENTS_DIR })].sort()

    // Both directions. The forward half catches a role with no prompt; the
    // reverse catches a prompt for a role the orchestrator cannot spawn, which
    // installs an agent nothing will ever use.
    const missing = expected.filter((f) => !onDisk.includes(f))
    const orphaned = onDisk.filter((f) => !expected.includes(f))

    expect({ missing, orphaned }).toEqual({ missing: [], orphaned: [] })
  })
})

describe('each bundled agent carries a usable frontmatter permissions block', () => {
  it.each([...SPAWNABLE_ROLES.map((r) => `nexus-${r}.md`), ORCHESTRATOR])(
    '%s has frontmatter whose permissions all name an effect',
    (name) => {
      const content = readAgent(name)
      const frontmatter = frontmatterOf(content)

      // A missing or unterminated frontmatter block fails here first, with a
      // message that names the cause, rather than surfacing as a confusing
      // `action` count of zero further down.
      expect(frontmatter).not.toBe('')
      expect(frontmatter).toMatch(/^description:\s*\S/m)
      expect(frontmatter).toMatch(/^mode:\s*\S/m)

      const actions = frontmatter.match(/action:/g) ?? []
      const effects = frontmatter.match(/effect:/g) ?? []

      // OpenCode drops an agent whose rules lack an `effect`, so an unbalanced
      // block is an agent that silently does not register.
      expect({ name, actions: actions.length, effects: effects.length }).toEqual({
        name,
        actions: actions.length,
        effects: effects.length,
      })
      expect(actions.length).toBeGreaterThan(0)

      // And the effect has to be one OpenCode actually understands.
      for (const effect of frontmatter.match(/effect:\s*(\S+)/g) ?? []) {
        expect(['allow', 'deny', 'ask']).toContain(effect.replace(/effect:\s*/, ''))
      }
    }
  )

  it('keeps the read-only roles read-only', () => {
    // reviewer, explorer and designer are documented as judges: the orchestrator
    // routes them work the user cannot act on until they answer. An `allow` on
    // `edit` for one of these turns a review into an unreviewed edit, and nothing
    // at runtime would say so.
    //
    // architect is deliberately NOT in this list. The orchestrator's role table
    // describes it as "Design system architecture (read-only)", but its own
    // permissions block grants `edit: allow` — so architect CAN write. That is a
    // real contradiction between the prompt and the permission, and it is left
    // as-is here rather than silently resolved: this test pins what the file
    // actually says, and the discrepancy is reported rather than papered over.
    // Which of the two should change is a product decision, not a lint fix.
    for (const role of ['reviewer', 'explorer', 'designer'] as const) {
      const frontmatter = frontmatterOf(readAgent(`nexus-${role}.md`))
      const editRules = frontmatter.split('- action:').filter((r) => /\bedit\b/.test(r))
      expect(editRules.length).toBeGreaterThan(0)
      for (const rule of editRules) {
        expect(rule).toMatch(/effect:\s*deny/)
      }
    }
  })

  it('records the architect prompt/permission contradiction rather than hiding it', () => {
    // If someone resolves the architect discrepancy above — by denying edit, or
    // by correcting the role table — this test is what should be updated, and it
    // is named so the update is deliberate.
    const frontmatter = frontmatterOf(readAgent('nexus-architect.md'))
    const editRule = frontmatter.split('- action:').find((r) => /\bedit\b/.test(r))
    expect(editRule).toMatch(/effect:\s*allow/)
  })
})

describe('each role states an output contract and when to escalate', () => {
  it.each(SPAWNABLE_ROLES.map((r) => `nexus-${r}.md`))(
    '%s has an Output Contract and a When to Escalate section',
    (name) => {
      const content = readAgent(name)
      expect(content).toMatch(/^## Output Contract$/m)
      expect(content).toMatch(/^## When to Escalate$/m)
    }
  )
})

describe('commit-capable prompts prohibit attribution trailers', () => {
  // Roles whose frontmatter grants `shell` can run `git commit`; the
  // orchestrator opens PRs. Models hallucinate trailers such as
  // "Co-Authored-By: Claude" even when the model is not Claude, so the rule is
  // pinned per prompt. Only designer denies `shell`; reviewer and explorer
  // deny only `edit`, and OpenCode's permission resolution falls through to a
  // catch-all allow for them — they CAN run `git commit`, so they carry the
  // rule too. Designer's protection is the appended git-convention section
  // (`buildGitFlowConventionSection`), covered in `test/git-flow.test.ts`.
  const COMMIT_CAPABLE = ['nexus-coder.md', 'nexus-tester.md', 'nexus-documenter.md', 'nexus-architect.md', 'nexus-reviewer.md', 'nexus-explorer.md', ORCHESTRATOR]

  it.each(COMMIT_CAPABLE)(
    '%s forbids Co-Authored-By and similar trailers unless the user asks',
    (name) => {
      // One anchored regex, not three loose substrings: the substring version
      // passes for an INVERTED rule ("never add ... unless ... Do not
      // infer ..."), because each fragment is still present somewhere in the
      // file. The anchor ties the fragments together in the order the rule
      // states them, so an inversion fails here.
      const content = readAgent(name)
      expect(content).toMatch(
        /NEVER add `Co-Authored-By`[\s\S]{0,120}unless the user explicitly asks for it in this conversation\. Do not infer authorship from the model in use\./
      )
    }
  )

  it('every agent that can shell carries the attribution rule', () => {
    // OpenCode's permission resolution falls through to a catch-all allow, so
    // an agent that never names `shell` can still run `git commit`. Stated
    // that way round on purpose: unless the frontmatter explicitly denies
    // `shell`, the prompt must carry the rule. This is the invariant that
    // would have caught reviewer and explorer missing it.
    for (const name of [...SPAWNABLE_ROLES.map((r) => `nexus-${r}.md`), ORCHESTRATOR]) {
      const frontmatter = frontmatterOf(readAgent(name))
      const shellDenied = /action:\s*shell[\s\S]*?effect:\s*deny/.test(frontmatter)
      if (!shellDenied) expect(readAgent(name)).toMatch(/Co-Authored-By/)
    }
  })
})
