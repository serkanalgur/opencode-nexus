import { readFileSync, existsSync, rmSync, readdirSync, rmdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * The `nexus-*` design skills: read from the package's own `skills/` directory
 * and registered with OpenCode through `ctx.skill.transform`.
 *
 * ## Why registered, not installed
 *
 * Earlier versions copied each SKILL.md into the user's global
 * `~/.config/opencode/skills/<name>/` on every load. That wrote into the user's
 * home directory, left files behind after an uninstall, and needed a
 * content-equality check and an overwrite warning to avoid churning mtimes and
 * silently discarding edits. V2 lets a plugin contribute skills directly
 * (`SkillEditor.add`), the same way core registers the skills it finds on disk,
 * so nothing is written any more. `path` points at the SKILL.md inside the
 * installed package, which is where it already lives.
 *
 * ## Precedence: a user's copy still wins
 *
 * The README promises that a user's own `.opencode/skills/nexus-design-taste`
 * overrides the shipped one. In core, `editor.add` is a plain map set, so
 * whichever transform runs last wins, and the order between plugins is not
 * something this package controls. So a Nexus skill is added only when no
 * skill with that id exists yet (`registerNexusSkills`). A file skill's id is
 * its directory name, which is why the `nexus-` prefix is load-bearing: a user
 * copy with the same directory name shadows this one instead of appearing as a
 * second, competing skill.
 *
 * ## Retiring the copies earlier versions installed
 *
 * The global copies those versions wrote would now count as "a user's copy" and
 * shadow the registered skill forever. `retireInstalledSkills` removes them,
 * but only when the bytes still match what this version ships. Every earlier
 * load re-synced those files to the shipped text, so an exact match is a copy
 * this plugin wrote and nobody has changed. A copy that differs was edited by
 * the user; it is kept, and the caller says that it now overrides the shipped
 * skill.
 */

/**
 * The skills this package registers.
 *
 * The `nexus-` prefix is load-bearing rather than cosmetic: it is what makes a
 * user-supplied copy *shadow* this one (same identifier) instead of *colliding*
 * with it as two unrelated skills that both advertise themselves to the model.
 */
export const NEXUS_SKILL_NAMES = [
  'nexus-design-taste',
  'nexus-interface-a11y',
  'nexus-design-review',
] as const

export type NexusSkillName = (typeof NEXUS_SKILL_NAMES)[number]

/**
 * A shipped skill in the shape `SkillEditor.add` takes. Plain strings here; the
 * caller brands them for the SDK, so this module has no runtime SDK import.
 */
export interface ShippedSkill {
  readonly id: NexusSkillName
  readonly name: string
  readonly description: string
  /** Absolute path of the SKILL.md inside the installed package. */
  readonly path: string
  /** The markdown body with the frontmatter removed, as core's own parser stores it. */
  readonly content: string
}

export interface UnavailableSkill {
  readonly name: NexusSkillName
  readonly path: string
  readonly reason: string
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
 * Where earlier versions installed the skills inside a home directory. Only
 * `retireInstalledSkills` reads it now. Takes the home directory rather than
 * calling `homedir()` so tests can point it at a temp directory.
 */
export function nexusSkillsTargetDir(homeDir: string): string {
  return join(homeDir, '.config', 'opencode', 'skills')
}

/**
 * Split a SKILL.md into its frontmatter fields and body.
 *
 * Handles the subset the shipped files use: a leading `---` block of
 * `key: value` lines. Returns `null` when there is no frontmatter block, which
 * the caller reports rather than registering a skill with no description (the
 * description is the only part of a skill the model sees before loading it).
 */
export function parseSkillMarkdown(text: string): { fields: Record<string, string>; body: string } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return null
  const fields: Record<string, string> = {}
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const kv = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
    if (kv?.[1]) fields[kv[1]] = (kv[2] ?? '').trim()
  }
  return { fields, body: text.slice(match[0].length) }
}

/**
 * Read every shipped skill. Failures are per skill: a missing or malformed
 * SKILL.md is reported as unavailable and the others still load, because a
 * packaging mistake in one file should not take down the two that are fine.
 */
export function loadNexusSkills(sourceDir: string): { skills: ShippedSkill[]; unavailable: UnavailableSkill[] } {
  const skills: ShippedSkill[] = []
  const unavailable: UnavailableSkill[] = []

  for (const name of NEXUS_SKILL_NAMES) {
    const path = join(sourceDir, name, 'SKILL.md')
    let text: string
    try {
      text = readFileSync(path, 'utf-8')
    } catch {
      unavailable.push({ name, path, reason: 'is not present in the installed package' })
      continue
    }
    const parsed = parseSkillMarkdown(text)
    if (!parsed || !parsed.fields.description) {
      unavailable.push({ name, path, reason: 'has no frontmatter description' })
      continue
    }
    skills.push({
      id: name,
      name: parsed.fields.name || name,
      description: parsed.fields.description,
      path,
      content: parsed.body,
    })
  }

  return { skills, unavailable }
}

/** The two methods of OpenCode's `SkillEditor` this module uses. */
export interface SkillRegistry<S> {
  get(id: string): unknown
  add(skill: S): void
}

/**
 * - `registered` — no skill with this id existed, so the shipped one was added.
 * - `shadowed` — a skill with this id already exists (a user's own copy), so
 *   the shipped one was not added and the user's copy stays in force.
 */
export type SkillRegisterAction = 'registered' | 'shadowed'

/**
 * Add each shipped skill unless a skill with the same id is already registered.
 * See the module comment for why an existing skill wins.
 */
export function registerNexusSkills<S>(
  registry: SkillRegistry<S>,
  skills: readonly ShippedSkill[],
  toSkill: (skill: ShippedSkill) => S,
): { name: NexusSkillName; action: SkillRegisterAction }[] {
  return skills.map((skill) => {
    if (registry.get(skill.id) !== undefined) return { name: skill.id, action: 'shadowed' as const }
    registry.add(toSkill(skill))
    return { name: skill.id, action: 'registered' as const }
  })
}

/**
 * - `removed` — an unmodified copy from an earlier version was deleted.
 * - `kept-modified` — a copy exists with different bytes; it was left alone
 *   because it was edited, and it now overrides the shipped skill.
 * - `absent` — nothing was installed there.
 */
export type SkillRetireAction = 'removed' | 'kept-modified' | 'absent'

export interface SkillRetireResult {
  readonly name: NexusSkillName
  readonly path: string
  readonly action: SkillRetireAction
}

/**
 * Remove the global copies earlier versions installed, when they are unchanged.
 *
 * Only `SKILL.md` is deleted, and its directory only when that leaves it empty,
 * so anything else a user put in that directory survives. A skill this version
 * cannot read is not touched: with nothing to compare against, the copy on disk
 * cannot be shown to be ours.
 */
export function retireInstalledSkills(sourceDir: string, homeDir: string): SkillRetireResult[] {
  const root = nexusSkillsTargetDir(homeDir)
  const results: SkillRetireResult[] = []

  for (const name of NEXUS_SKILL_NAMES) {
    const dir = join(root, name)
    const path = join(dir, 'SKILL.md')
    if (!existsSync(path)) {
      results.push({ name, path, action: 'absent' })
      continue
    }

    let shipped: string
    let installed: string
    try {
      shipped = readFileSync(join(sourceDir, name, 'SKILL.md'), 'utf-8')
      installed = readFileSync(path, 'utf-8')
    } catch {
      results.push({ name, path, action: 'kept-modified' })
      continue
    }

    if (installed !== shipped) {
      results.push({ name, path, action: 'kept-modified' })
      continue
    }

    rmSync(path)
    if (readdirSync(dir).length === 0) rmdirSync(dir)
    results.push({ name, path, action: 'removed' })
  }

  return results
}

/**
 * The warning for a global copy that was kept because it was edited. It is not
 * an error: the user's file is now the skill OpenCode uses, which may be what
 * they want, but it no longer updates with the plugin, so they are told how to
 * go back to the shipped version.
 */
export function keptModifiedWarning(name: NexusSkillName, path: string): string {
  return (
    `[nexus] Kept ${path}: it differs from the ${name} skill this version ships, so it ` +
    `was left in place and overrides the built-in skill. Nexus no longer installs skills ` +
    `into ~/.config/opencode/skills; delete this file to use the shipped version, or keep ` +
    `it as your own copy (a project .opencode/skills/${name}/SKILL.md works the same way).`
  )
}
