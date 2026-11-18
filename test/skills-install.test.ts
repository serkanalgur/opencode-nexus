import { describe, it, expect, afterAll, mock } from 'bun:test'
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import * as realOs from 'node:os'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * The `nexus-*` design skills, registered with OpenCode through
 * `ctx.skill.transform` instead of being copied into
 * `~/.config/opencode/skills`.
 *
 * What these tests guard:
 *  1. **The registered skill carries the real text.** Asserting that `add` was
 *     called proves nothing; a skill with an empty body passes that. The
 *     substance checks read the `content` and `description` actually handed to
 *     OpenCode.
 *  2. **A user's copy still wins.** The README promises that a user's own
 *     `nexus-design-taste` overrides the shipped one. `editor.add` is a plain
 *     map set in core, so the plugin must not add over an existing id.
 *  3. **Upgrading cleans up after earlier versions, without losing edits.** An
 *     unmodified global copy is removed; an edited one is kept and reported.
 */

// `homedir()` is mocked at the module so a run cannot touch a real
// `~/.config/opencode`. Must happen before the modules under test load.
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'nexus-skills-'))
mock.module('node:os', () => ({ ...realOs, default: realOs, homedir: () => SANDBOX_HOME }))

const {
  NEXUS_SKILL_NAMES,
  keptModifiedWarning,
  loadNexusSkills,
  nexusSkillsDir,
  nexusSkillsTargetDir,
  parseSkillMarkdown,
  registerNexusSkills,
  retireInstalledSkills,
} = await import('../src/skills-install')
const { default: plugin, reportSkillSetup } = await import('../src/index')

// The real `skills/` directory: the tests check the text that actually ships.
const SOURCE_DIR = resolve(import.meta.dir, '..', 'skills')

const tempDirs: string[] = []
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function stageSkill(sourceRoot: string, name: string, body: string): void {
  mkdirSync(join(sourceRoot, name), { recursive: true })
  writeFileSync(join(sourceRoot, name, 'SKILL.md'), body, 'utf-8')
}

const installedPath = (name: string, home: string) => join(nexusSkillsTargetDir(home), name, 'SKILL.md')

function installOldCopy(home: string, name: string, body: string): string {
  const path = installedPath(name, home)
  mkdirSync(join(nexusSkillsTargetDir(home), name), { recursive: true })
  writeFileSync(path, body, 'utf-8')
  return path
}

/** A registry with core's semantics: `add` is a map set, `get` a lookup. */
function fakeRegistry(existing: string[] = []) {
  const skills = new Map<string, any>(existing.map((id) => [id, { id, user: true }]))
  return { skills, registry: { get: (id: string) => skills.get(id), add: (s: any) => { skills.set(s.id, s) } } }
}

function captureWarnings(body: () => unknown): string[] {
  const original = console.warn
  const seen: string[] = []
  console.warn = (...args: unknown[]) => { seen.push(args.map(String).join(' ')) }
  try { body() } finally { console.warn = original }
  return seen
}

async function captureWarningsAsync(body: () => Promise<unknown>): Promise<string[]> {
  const original = console.warn
  const seen: string[] = []
  console.warn = (...args: unknown[]) => { seen.push(args.map(String).join(' ')) }
  try { await body() } finally { console.warn = original }
  return seen
}

afterAll(() => {
  mock.module('node:os', () => realOs)
  rmSync(SANDBOX_HOME, { recursive: true, force: true })
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

describe('nexus design skills: naming and location', () => {
  it('resolves the shipped skills/ directory relative to the module, from src/ or dist/', () => {
    const dir = nexusSkillsDir()
    expect(resolve(dir)).toBe(SOURCE_DIR)
    for (const name of NEXUS_SKILL_NAMES) {
      expect(existsSync(join(dir, name, 'SKILL.md'))).toBe(true)
    }
  })

  it('names every skill with a nexus- prefix, so a user copy shadows rather than collides', () => {
    for (const name of NEXUS_SKILL_NAMES) expect(name.startsWith('nexus-')).toBe(true)
  })

  it('names every skill distinctly', () => {
    expect(new Set(NEXUS_SKILL_NAMES).size).toBe(NEXUS_SKILL_NAMES.length)
  })
})

describe('nexus design skills: what gets registered', () => {
  const { skills, unavailable } = loadNexusSkills(SOURCE_DIR)
  const byId = Object.fromEntries(skills.map((s) => [s.id, s]))

  it('loads all three, with nothing unavailable', () => {
    expect(unavailable).toEqual([])
    expect(skills.map((s) => s.id).sort()).toEqual([...NEXUS_SKILL_NAMES].sort())
  })

  it('uses the directory name as the id, as core does for a file skill', () => {
    for (const s of skills) expect(s.name).toBe(s.id)
  })

  it('points path at the SKILL.md inside the package', () => {
    for (const s of skills) expect(s.path).toBe(join(SOURCE_DIR, s.id, 'SKILL.md'))
  })

  it('registers the body without the frontmatter, and the frontmatter description separately', () => {
    for (const s of skills) {
      const source = readFileSync(s.path, 'utf-8')
      expect(s.content.startsWith('---')).toBe(false)
      expect(source.endsWith(s.content)).toBe(true)
      expect(s.content.trimStart().startsWith('# ')).toBe(true)
      expect(source).toContain(`description: ${s.description}`)
    }
  })

  it('gives every skill a description that states when to load it', () => {
    for (const s of skills) {
      // The description is the only part of a skill the model sees before
      // loading it, so a bare noun phrase cannot do its job.
      expect(s.description.length).toBeGreaterThan(80)
      expect(s.description.toLowerCase()).toMatch(/load|use|when|before|audit/)
    }
  })

  it('gives every skill a distinct description', () => {
    expect(new Set(skills.map((s) => s.description)).size).toBe(skills.length)
  })

  it('registers substance, not a placeholder: each skill names the thing it prevents', () => {
    // Description and body together, because the model sees both: some traits
    // are named only in the description, which used to be part of the same file.
    const text = (id: string) => `${byId[id]!.description}\n${byId[id]!.content}`
    const taste = text('nexus-design-taste')
    for (const trait of ['border-radius', 'shadow', 'middot', 'arrow', 'all-caps', 'eyebrow']) {
      expect(taste.toLowerCase()).toContain(trait)
    }
    expect(taste).toContain('Spend your boldness in exactly one place')
    expect(taste).toContain('could a reader reorder')

    const a11y = text('nexus-interface-a11y')
    for (const figure of ['4.5:1', '3:1', '24 by 24 CSS pixels', '44 by 44 CSS pixels', '200%', '320 CSS pixels']) {
      expect(a11y).toContain(figure)
    }
    expect(a11y).toContain('SC 1.4.1')
    expect(a11y).toContain('Level A')
    expect(a11y).toContain('not a WCAG success criterion')
    expect(a11y).toContain('https://www.w3.org/TR/WCAG22/')

    const review = text('nexus-design-review')
    expect(review).toContain('You refuse to:')
    expect(review).toContain('change the thing you are auditing')
    expect(review).toContain('reviewer who')
    for (const severity of ['Blocking', 'Serious', 'Polish']) expect(review).toContain(severity)
    for (const field of ['**Problem**', '**Direction**', '**Rationale**', '**States**', '**Constraints**', '**Open questions**']) {
      expect(review).toContain(field)
    }
  })
})

describe('parseSkillMarkdown', () => {
  it('splits frontmatter fields from the body', () => {
    expect(parseSkillMarkdown('---\nname: x\ndescription: Use when y\n---\n\n# X\nbody\n')).toEqual({
      fields: { name: 'x', description: 'Use when y' },
      body: '\n# X\nbody\n',
    })
  })

  it('returns null without a frontmatter block', () => {
    expect(parseSkillMarkdown('# No frontmatter\n')).toBeNull()
  })
})

describe('loadNexusSkills: resilience', () => {
  it('reports a missing skill and still loads the others', () => {
    const source = tempDir('nexus-skills-src-')
    stageSkill(source, 'nexus-design-taste', '---\nname: nexus-design-taste\ndescription: Load when styling\n---\n# T\n')
    stageSkill(source, 'nexus-interface-a11y', '---\nname: nexus-interface-a11y\ndescription: Load when building UI\n---\n# A\n')
    const { skills, unavailable } = loadNexusSkills(source)
    expect(skills.map((s) => s.id).sort()).toEqual(['nexus-design-taste', 'nexus-interface-a11y'])
    expect(unavailable).toEqual([{
      name: 'nexus-design-review',
      path: join(source, 'nexus-design-review', 'SKILL.md'),
      reason: 'is not present in the installed package',
    }])
  })

  it('reports a skill with no description rather than registering it', () => {
    const source = tempDir('nexus-skills-src-')
    for (const name of NEXUS_SKILL_NAMES) stageSkill(source, name, `---\nname: ${name}\n---\n# ${name}\n`)
    const { skills, unavailable } = loadNexusSkills(source)
    expect(skills).toEqual([])
    expect(unavailable.map((u) => u.reason)).toEqual(NEXUS_SKILL_NAMES.map(() => 'has no frontmatter description'))
  })
})

describe('registerNexusSkills: a user copy wins', () => {
  const { skills } = loadNexusSkills(SOURCE_DIR)

  it('adds every skill to an empty registry', () => {
    const { skills: registered, registry } = fakeRegistry()
    const results = registerNexusSkills(registry, skills, (s) => ({ ...s }))
    expect(results.every((r) => r.action === 'registered')).toBe(true)
    expect([...registered.keys()].sort()).toEqual([...NEXUS_SKILL_NAMES].sort())
    expect(registered.get('nexus-design-taste').content).toBe(skills.find((s) => s.id === 'nexus-design-taste')!.content)
  })

  it('does not add over a skill with the same id', () => {
    const { skills: registered, registry } = fakeRegistry(['nexus-design-taste'])
    const results = registerNexusSkills(registry, skills, (s) => ({ ...s }))
    expect(results.find((r) => r.name === 'nexus-design-taste')!.action).toBe('shadowed')
    expect(registered.get('nexus-design-taste')).toEqual({ id: 'nexus-design-taste', user: true })
    expect(registered.has('nexus-interface-a11y')).toBe(true)
  })
})

describe('retireInstalledSkills: cleaning up earlier versions', () => {
  it('removes an unmodified copy, and its directory when that leaves it empty', () => {
    const home = tempDir('nexus-skills-home-')
    const shipped = readFileSync(join(SOURCE_DIR, 'nexus-design-taste', 'SKILL.md'), 'utf-8')
    const path = installOldCopy(home, 'nexus-design-taste', shipped)

    const results = retireInstalledSkills(SOURCE_DIR, home)

    expect(results.find((r) => r.name === 'nexus-design-taste')).toEqual({ name: 'nexus-design-taste', path, action: 'removed' })
    expect(existsSync(path)).toBe(false)
    expect(existsSync(join(nexusSkillsTargetDir(home), 'nexus-design-taste'))).toBe(false)
  })

  it('keeps a copy the user edited, byte for byte', () => {
    const home = tempDir('nexus-skills-home-')
    const edited = '---\nname: nexus-design-taste\ndescription: my own\n---\n# Mine\n'
    const path = installOldCopy(home, 'nexus-design-taste', edited)

    const results = retireInstalledSkills(SOURCE_DIR, home)

    expect(results.find((r) => r.name === 'nexus-design-taste')!.action).toBe('kept-modified')
    expect(readFileSync(path, 'utf-8')).toBe(edited)
  })

  it('leaves other files in the skill directory alone', () => {
    const home = tempDir('nexus-skills-home-')
    const shipped = readFileSync(join(SOURCE_DIR, 'nexus-design-review', 'SKILL.md'), 'utf-8')
    installOldCopy(home, 'nexus-design-review', shipped)
    const extra = join(nexusSkillsTargetDir(home), 'nexus-design-review', 'notes.md')
    writeFileSync(extra, 'mine', 'utf-8')

    retireInstalledSkills(SOURCE_DIR, home)

    expect(existsSync(extra)).toBe(true)
  })

  it('reports absent when nothing was installed, and writes nothing', () => {
    const home = tempDir('nexus-skills-home-')
    const results = retireInstalledSkills(SOURCE_DIR, home)
    expect(results.map((r) => r.action)).toEqual(NEXUS_SKILL_NAMES.map(() => 'absent'))
    expect(existsSync(nexusSkillsTargetDir(home))).toBe(false)
  })
})

describe('reportSkillSetup', () => {
  it('warns for an unavailable skill, naming it and why', () => {
    const warnings = captureWarnings(() => reportSkillSetup(
      [{ name: 'nexus-design-review', path: '/pkg/skills/nexus-design-review/SKILL.md', reason: 'is not present in the installed package' }],
      [],
    ))
    expect(warnings).toEqual(['[nexus] Skill nexus-design-review is not present in the installed package; it was not registered (/pkg/skills/nexus-design-review/SKILL.md)'])
  })

  it('warns for a kept edited copy, saying it overrides the shipped skill and how to undo that', () => {
    const path = '/home/u/.config/opencode/skills/nexus-design-taste/SKILL.md'
    const warnings = captureWarnings(() => reportSkillSetup([], [{ name: 'nexus-design-taste', path, action: 'kept-modified' }]))
    expect(warnings).toEqual([keptModifiedWarning('nexus-design-taste', path)])
    expect(warnings[0]).toContain(path)
    expect(warnings[0]).toContain('overrides the built-in skill')
    expect(warnings[0]).toContain('delete this file to use the shipped version')
  })

  it('is silent for removed and absent', () => {
    const warnings = captureWarnings(() => reportSkillSetup([], [
      { name: 'nexus-design-taste', path: '/a', action: 'removed' },
      { name: 'nexus-interface-a11y', path: '/b', action: 'absent' },
    ]))
    expect(warnings).toEqual([])
  })
})

describe('nexus design skills: wiring into plugin load', () => {
  function bootCtx(registered: Map<string, any>) {
    return {
      location: { directory: SANDBOX_HOME },
      storage: { set: mock(() => Promise.resolve()), get: mock(() => Promise.resolve(null)) },
      tool: {
        transform: mock(async (cb: any) => { cb({ namespace: () => {}, add: () => {} }) }),
        list: mock(() => Promise.resolve([])),
      },
      skill: {
        transform: mock(async (cb: any) => {
          cb({ get: (id: string) => registered.get(id), add: (s: any) => { registered.set(s.id, s) } })
        }),
      },
      session: {
        create: mock(() => Promise.resolve({ id: 'ses_skills' })),
        prompt: mock(() => Promise.resolve()),
        wait: mock(() => Promise.resolve()),
        context: mock(() => Promise.resolve([])),
        hook: mock(() => Promise.resolve()),
      },
    } as any
  }

  it('registers the skills on load and writes nothing under the home directory', async () => {
    const registered = new Map<string, any>()
    const cleanup = await plugin.setup(bootCtx(registered))

    expect([...registered.keys()].sort()).toEqual([...NEXUS_SKILL_NAMES].sort())
    for (const name of NEXUS_SKILL_NAMES) {
      const skill = registered.get(name)
      expect(skill.path).toBe(join(SOURCE_DIR, name, 'SKILL.md'))
      expect(skill.content.length).toBeGreaterThan(500)
      expect(existsSync(installedPath(name, SANDBOX_HOME))).toBe(false)
    }
    await (cleanup as any)?.()
  })

  it('retires an unmodified copy from an earlier version, then registers the shipped skill', async () => {
    const shipped = readFileSync(join(SOURCE_DIR, 'nexus-interface-a11y', 'SKILL.md'), 'utf-8')
    const path = installOldCopy(SANDBOX_HOME, 'nexus-interface-a11y', shipped)
    const registered = new Map<string, any>()

    const warnings = await captureWarningsAsync(async () => {
      const cleanup = await plugin.setup(bootCtx(registered))
      await (cleanup as any)?.()
    })

    expect(existsSync(path)).toBe(false)
    expect(registered.has('nexus-interface-a11y')).toBe(true)
    expect(warnings.filter((w) => w.includes('Kept'))).toEqual([])
  })

  it('reports an edited copy from a real plugin load', async () => {
    const path = installOldCopy(SANDBOX_HOME, 'nexus-design-review', '---\nname: nexus-design-review\ndescription: mine\n---\n# Mine\n')
    const warnings = await captureWarningsAsync(async () => {
      const cleanup = await plugin.setup(bootCtx(new Map()))
      await (cleanup as any)?.()
    })
    expect(warnings).toContain(keptModifiedWarning('nexus-design-review', path))
    rmSync(join(nexusSkillsTargetDir(SANDBOX_HOME), 'nexus-design-review'), { recursive: true, force: true })
  })
})
