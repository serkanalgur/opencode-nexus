import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Installs the `nexus-*` design skills into the user's global skills directory
 * on plugin load.
 *
 * This is the skills counterpart to the agent files `src/index.ts` writes to
 * `~/.config/opencode/agents/`, and it deliberately is not a second copy of
 * that mechanism: it is a different destination, a different trigger (content
 * equality rather than a version number), and a testable pure-ish core.
 *
 * ## Why content equality and not a version marker
 *
 * `src/index.ts` rewrites the agent files unconditionally on every load, which
 * is right for prose the plugin fully owns. Rewriting the same three skill
 * files on every single load would churn their mtimes forever, and an mtime is
 * something tools watch — an editor reloading a file the user never touched, a
 * file watcher firing, a `git status` on a home directory. So: write when the
 * file is missing, or when the bytes on disk differ from the bytes this
 * version ships. A release that edits a SKILL.md updates the installed copy;
 * a release that does not touch it leaves the file, and its mtime, alone.
 *
 * ## Why there is no override mechanism here
 *
 * OpenCode registers skill sources in precedence order — built-in, then
 * `.claude/skills` / `.agents/skills`, then `~/.config/opencode/skills`, then
 * project `.opencode/skills`, then explicit `skills` config entries — with
 * later sources winning. These files are written to the *global* tier, so a
 * user's own copy in project `.opencode/skills/nexus-design-taste/SKILL.md`
 * already shadows this one for that project. Adding config here to detect and
 * spare a modified global file would create a second source of truth for
 * precedence that OpenCode already owns, and the two would eventually
 * disagree. The escape hatch is documented in the README instead.
 */

/**
 * The skills this package installs, as `~/.config/opencode/skills/<name>/SKILL.md`.
 *
 * The `nexus-` prefix is load-bearing rather than cosmetic: it is what makes a
 * user-supplied copy *shadow* this one (same identifier, higher-precedence
 * tier) instead of *colliding* with it as two unrelated skills that both
 * advertise themselves to the model. A user should be able to drop in their own
 * `nexus-design-taste` and have it take over cleanly.
 */
export const NEXUS_SKILL_NAMES = [
  'nexus-design-taste',
  'nexus-interface-a11y',
  'nexus-design-review',
] as const

export type NexusSkillName = (typeof NEXUS_SKILL_NAMES)[number]

/**
 * - `created` — nothing was there; the file is new.
 * - `updated` — the file existed with different bytes; this version's text won.
 * - `unchanged` — the file already matched byte for byte; nothing was written.
 * - `unavailable` — the shipped `SKILL.md` could not be read, so there was
 *   nothing to install. Surfaced rather than swallowed: a skill that fails to
 *   ship is the whole feature failing silently, and the only in-process signal
 *   available is this one.
 */
export type SkillInstallAction = 'created' | 'updated' | 'unchanged' | 'unavailable'

export interface SkillInstallResult {
  readonly name: NexusSkillName
  readonly path: string
  readonly action: SkillInstallAction
}

/**
 * The `skills/` directory as it exists in the installed package.
 *
 * Both `src/` and the bundled `dist/` sit exactly one level below the package
 * root, so `../skills` resolves correctly whether the plugin runs from source
 * (`bun run dev`) or from the published tarball. That invariant is the whole
 * reason this is a plain join and not a search: a search would be able to
 * wander into a user's project and pick up the wrong `skills/`.
 */
export function nexusSkillsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')
}

/**
 * Where the skills land inside a home directory. Takes the home directory
 * rather than calling `homedir()` itself so that the whole installer is
 * testable against a temp directory with no environment mocking and no risk of
 * a test run writing to a real `~/.config/opencode/skills`.
 */
export function nexusSkillsTargetDir(homeDir: string): string {
  return join(homeDir, '.config', 'opencode', 'skills')
}

/**
 * The warning for the one destructive thing this installer does.
 *
 * REPORTED BY THE CALLER, not printed here. This file had two `console.warn`
 * call sites' worth of reporting in one and none in the other: the `unavailable`
 * case is reported by `src/index.ts` from the returned results, and the
 * overwrite was reported here. Two homes for one feature's output means the
 * prefix, the tone and the decision of what is worth saying are all maintained
 * twice, and a test that captures `console.warn` around the installer cannot
 * see the half that moved. Both are now sibling arms of the same loop over the
 * same `SkillInstallResult[]`, so `unavailable` and `updated` are reported by
 * the same code, with the same `[nexus] ` prefix, from the same place.
 *
 * The installer's own return value is unchanged, and the DECISION is unchanged
 * — `updated` was already a first-class result, which is all the caller needs.
 * What moved is only the printing.
 *
 * Fires only on `updated` — a file that existed and whose bytes differed from
 * what this version ships. Two neighbouring outcomes are deliberately silent:
 *
 * - `created` — nothing was lost. A missing file is the expected first run, and
 *   warning about a first install is noise that teaches the user to ignore
 *   warnings from this installer.
 * - `unchanged` — no write happened at all, so there is nothing to report. This
 *   is also the steady state on almost every load by design, so a warning here
 *   would fire on nearly every startup, which is exactly how a warning stops
 *   being read.
 *
 * ## Per-file, not one summary after the loop
 *
 * Each warning carries a different path, and a path is what the user has to act
 * on. A summary would still have to name all three files, so it saves only the
 * repeated sentence while making the output harder to scan — and a user who
 * only ever edits one of the three has to read past the other two either way.
 * Repetition here is bounded by real work: a load only warns for the skills
 * this release actually changed, which is typically one, and is three only on a
 * release that legitimately rewrote all three. The varying part (the path) is
 * placed immediately after the prefix so the three are distinguishable at a
 * glance rather than reading as one warning pasted three times.
 */
export function overwriteWarning(name: NexusSkillName, path: string): string {
  return (
    `[nexus] Overwrote ${path}: it is managed by this plugin and will be replaced ` +
    `again on upgrade, so local edits made there will not survive. To customise this ` +
    `skill, put your own copy at .opencode/skills/${name}/SKILL.md in your project ` +
    `instead, which OpenCode's source precedence already prefers over the global one.`
  )
}

/**
 * Install every shipped skill under `homeDir`, overwriting any copy whose
 * content differs from this version's.
 *
 * Failures are per-skill, not per-run: a missing or unreadable SKILL.md is
 * reported as `unavailable` and the remaining skills still install. Aborting
 * all three because one file is absent would make a packaging mistake take down
 * two features that were fine.
 */
export function installNexusSkills(
  sourceDir: string,
  homeDir: string,
): SkillInstallResult[] {
  const skillsRoot = nexusSkillsTargetDir(homeDir)
  const results: SkillInstallResult[] = []

  for (const name of NEXUS_SKILL_NAMES) {
    const dir = join(skillsRoot, name)
    const target = join(dir, 'SKILL.md')
    let shipped: string

    try {
      shipped = readFileSync(join(sourceDir, name, 'SKILL.md'), 'utf-8')
    } catch {
      results.push({ name, path: target, action: 'unavailable' })
      continue
    }

    const alreadyMatches = existsSync(target) && readFileSync(target, 'utf-8') === shipped

    if (alreadyMatches) {
      results.push({ name, path: target, action: 'unchanged' })
      continue
    }

    const isNew = !existsSync(target)
    mkdirSync(dir, { recursive: true })
    writeFileSync(target, shipped, 'utf-8')
    results.push({ name, path: target, action: isNew ? 'created' : 'updated' })
    // Reported by the caller, from `action: 'updated'` — see `overwriteWarning`.
    // The write above is still the specified policy and it still succeeded; the
    // difference is only who says so, which is now the same code that reports a
    // skill that did not ship.
  }

  return results
}
