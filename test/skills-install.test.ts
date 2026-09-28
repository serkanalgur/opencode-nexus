import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test'
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, statSync, utimesSync } from 'node:fs'
import * as realOs from 'node:os'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'

/**
 * The `nexus-*` design skills, installed from `skills/` into
 * `~/.config/opencode/skills/<name>/SKILL.md` on plugin load.
 *
 * Three things in here are easy to assert tautologically, and all three are the
 * failure this file is written against:
 *
 *  1. **"The installer wrote the files."** Asserting `writeFileSync` was called,
 *     or that a path exists, proves nothing — a file containing `""` or the
 *     wrong skill passes both. Every assertion here about *what* was installed
 *     reads the bytes back and checks the substance, because a skill that
 *     installs the wrong prose is the feature failing while the suite is green.
 *  2. **"It didn't rewrite when unchanged."** Comparing content before and
 *     after proves the file still says the right thing, which is true whether
 *     or not it was rewritten — the agent files at `src/index.ts` are rewritten
 *     on *every* load and would pass that. These tests pin the mtime instead,
 *     backdated with `utimesSync` so a rewrite within the same millisecond
 *     cannot be mistaken for a non-rewrite.
 *  3. **"It overwrote a modified file."** This is a *decision*, taken over
 *     "warn and spare", and the test below says so in its name. Without that,
 *     a future reader sees a test clobbering user edits and reasonably assumes
 *     it is a bug.
 */

// `homedir()` is what the plugin writes under and what the config manager reads
// global config from, and `bun test` does not let process.env.HOME redirect it.
// Mocked at the module so a run cannot write to a real `~/.config/opencode`.
// Must happen before the modules under test load, hence the dynamic imports.
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'nexus-skills-'))
mock.module('node:os', () => ({ ...realOs, default: realOs, homedir: () => SANDBOX_HOME }))

const { installNexusSkills, nexusSkillsDir, nexusSkillsTargetDir, NEXUS_SKILL_NAMES, overwriteWarning } =
  await import('../src/skills-install')
// The reporting home for this feature. The overwrite warning used to be printed
// by `installNexusSkills` itself; it now lives here, beside the `unavailable`
// warning, as a sibling arm of one loop. The tests below therefore drive
// `reportSkillInstalls` with the installer's REAL results rather than capturing
// `console.warn` around the installer — same assertion, moved to the code that
// now makes it, so moving the warning again cannot quietly drop its coverage.
const { reportSkillInstalls } = await import('../src/index')

// The real `skills/` directory in the repo — the installer copies from it, so
// the tests below check the bytes that actually ship, not a fixture.
const SOURCE_DIR = resolve(import.meta.dir, '..', 'skills')

/** Frontmatter fields, parsed out of the `---` block at the top of a SKILL.md. */
function frontmatter(body: string): Record<string, string> {
  const match = body.match(/^---\n([\s\S]*?)\n---\n/)
  if (!match) throw new Error('SKILL.md has no frontmatter block')
  const fields: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/)
    if (kv) fields[kv[1]] = kv[2].trim()
  }
  return fields
}

const skillPath = (name: string, home: string) =>
  join(nexusSkillsTargetDir(home), name, 'SKILL.md')

/**
 * The H1 each shipped skill opens with, read from its own source file.
 *
 * Deliberately derived rather than hardcoded. A hardcoded table would be a
 * fourth copy of the skill list; deriving it keeps one source of truth while
 * still failing if the installer writes the wrong body to the right path.
 */
const expectedHeadings: Record<string, string | undefined> = Object.fromEntries(
  NEXUS_SKILL_NAMES.map(name => [
    name,
    readFileSync(join(SOURCE_DIR, name, 'SKILL.md'), 'utf-8').match(/^# (.+)$/m)?.[1],
  ]),
)

/** Write one skill into a staged source tree, creating its directory. */
function stageSkill(sourceRoot: string, name: string, body: string): void {
  mkdirSync(join(sourceRoot, name), { recursive: true })
  writeFileSync(join(sourceRoot, name, 'SKILL.md'), body, 'utf-8')
}

const tempHomes: string[] = []
function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-skills-home-'))
  tempHomes.push(dir)
  return dir
}

/**
 * Run `body` with `console.warn` captured, returning the warnings as text.
 *
 * Hand-rolled rather than `spyOn(console, 'warn')` so the restore lives in a
 * `finally` — a thrown assertion must not leave `console.warn` swapped out for
 * the rest of the run, which would silently silence unrelated diagnostics.
 *
 * Returns the *text*, not the call count, because the whole failure this tests
 * against is a warning that fires with the wrong words: asserting only that
 * `console.warn` was called passes just as happily on an empty string.
 */
function captureWarnings(body: () => unknown): string[] {
  const original = console.warn
  const seen: string[] = []
  console.warn = (...args: unknown[]) => {
    seen.push(args.map(a => String(a)).join(' '))
  }
  try {
    body()
  } finally {
    console.warn = original
  }
  return seen
}

/**
 * The same, for an async body — `plugin.setup` returns a promise, and the sync
 * version would restore `console.warn` before the load had run, so every
 * warning would be missed and the "nothing was reported" assertions would pass
 * because nothing had happened yet rather than because nothing was said.
 */
async function captureWarningsAsync(body: () => Promise<unknown>): Promise<string[]> {
  const original = console.warn
  const seen: string[] = []
  console.warn = (...args: unknown[]) => {
    seen.push(args.map(a => String(a)).join(' '))
  }
  try {
    await body()
  } finally {
    console.warn = original
  }
  return seen
}

afterAll(() => {
  mock.module('node:os', () => realOs)
  rmSync(SANDBOX_HOME, { recursive: true, force: true })
  for (const dir of tempHomes) rmSync(dir, { recursive: true, force: true })
})

describe('nexus design skills: install location and naming', () => {
  it('resolves the shipped skills/ directory relative to the module, from src/ or dist/', () => {
    // `src/` and the bundled `dist/` are both exactly one level below the
    // package root, which is what makes a plain `../skills` join correct in
    // both dev and the published tarball. If this ever stops holding, the
    // installer silently finds nothing and every skill stops being installed —
    // so the directory is checked to EXIST, not merely to be well-formed.
    const dir = nexusSkillsDir()
    expect(existsSync(dir)).toBe(true)
    expect(dirname(dir)).toBe(resolve(import.meta.dir, '..'))
    for (const name of NEXUS_SKILL_NAMES) {
      expect(existsSync(join(dir, name, 'SKILL.md'))).toBe(true)
    }
  })

  it('names every skill with a nexus- prefix, so a user copy shadows rather than collides', () => {
    // Not three hardcoded strings: the convention is the thing being pinned. A
    // fourth skill added without the prefix would fail here, which is the
    // point — the prefix is what makes project-level override work.
    expect(NEXUS_SKILL_NAMES.length).toBeGreaterThanOrEqual(3)
    for (const name of NEXUS_SKILL_NAMES) {
      expect(name).toMatch(/^nexus-[a-z0-9]+(-[a-z0-9]+)*$/)
    }
  })

  it('names every skill distinctly', () => {
    // Two entries with the same name would install to the same directory, and
    // the second would overwrite the first — the tests below would then pass
    // against whichever happened to be last.
    expect(new Set(NEXUS_SKILL_NAMES).size).toBe(NEXUS_SKILL_NAMES.length)
  })

  it('installs under the global skills tier of the given home directory', () => {
    const home = makeHome()
    installNexusSkills(SOURCE_DIR, home)
    for (const name of NEXUS_SKILL_NAMES) {
      expect(skillPath(name, home)).toBe(
        join(home, '.config', 'opencode', 'skills', name, 'SKILL.md'),
      )
    }
  })
})

describe('nexus design skills: what actually gets written', () => {
  let home: string
  beforeEach(() => {
    home = makeHome()
    installNexusSkills(SOURCE_DIR, home)
  })

  it('writes all three, each with the shipped bytes', () => {
    // A fresh home, because `beforeEach` already installed once — asserting
    // `created` on an already-populated directory would be asserting the
    // beforeEach, not this call.
    const fresh = makeHome()
    const results = installNexusSkills(SOURCE_DIR, fresh)
    expect(results.map(r => r.action).sort()).toEqual(['created', 'created', 'created'])
    for (const name of NEXUS_SKILL_NAMES) {
      const onDisk = readFileSync(skillPath(name, fresh), 'utf-8')
      // Each skill carries a top-level H1, and it is the skill's own title —
      // the three differ from each other. Asserting this per-skill, inside the
      // loop, means this test fails if the installer copies the wrong file to
      // the wrong directory, which a byte-comparison against the *same* source
      // path would not catch on its own.
      const heading = onDisk.match(/^# (.+)$/m)?.[1]
      expect(heading).toBeTruthy()
      expect(expectedHeadings[name]).toBe(heading)
      expect(onDisk.length).toBeGreaterThan(500)
    }
    // And every installed body is byte-identical to what ships.
    for (const name of NEXUS_SKILL_NAMES) {
      expect(readFileSync(skillPath(name, fresh), 'utf-8'))
        .toBe(readFileSync(join(SOURCE_DIR, name, 'SKILL.md'), 'utf-8'))
    }
  })

  it('gives every skill a name and a non-empty description', () => {
    // OpenCode will not advertise a skill without `description`, and `name` is
    // what identifies the directory. A skill missing either is installed and
    // invisible — the feature looks like it works and is doing nothing.
    for (const name of NEXUS_SKILL_NAMES) {
      const fields = frontmatter(readFileSync(skillPath(name, home), 'utf-8'))
      expect(fields.name).toBe(name)
      expect(fields.description).toBeTruthy()
      expect(fields.description.length).toBeGreaterThan(80)
      // The description is the ONLY part of a skill a model sees before it
      // loads it, so a description that is just a noun phrase cannot do its
      // job. This requires it to state a trigger condition.
      expect(fields.description.toLowerCase()).toMatch(/load|use|when|before|audit/)
    }
  })

  it('gives every skill a distinct description', () => {
    // Three identical descriptions would make the model pick arbitrarily and
    // nothing would fail. This is the assertion that catches it.
    const descriptions = NEXUS_SKILL_NAMES.map(
      name => frontmatter(readFileSync(skillPath(name, home), 'utf-8')).description,
    )
    expect(new Set(descriptions).size).toBe(descriptions.length)
  })

  it('installs substance, not a placeholder: each skill names the thing it prevents', () => {
    // Checked against the INSTALLED bytes, because the failure being guarded is
    // a correct installer carrying a hollow skill. These are the specific
    // observations each skill exists to catch, so an emptied body fails.
    const taste = readFileSync(skillPath('nexus-design-taste', home), 'utf-8')
    for (const trait of ['border-radius', 'shadow', 'middot', 'arrow', 'all-caps', 'eyebrow']) {
      expect(taste.toLowerCase()).toContain(trait)
    }
    // The restraint idea and the sequence question are the two non-obvious
    // claims this skill makes; they are asserted individually.
    expect(taste).toContain('Spend your boldness in exactly one place')
    expect(taste).toContain('could a reader reorder')

    const a11y = readFileSync(skillPath('nexus-interface-a11y', home), 'utf-8')
    // The verified WCAG 2.2 AA figures. A wrong ratio in a skill that ships to
    // everyone is worse than omitting the skill, so each is pinned.
    for (const figure of ['4.5:1', '3:1', '24 by 24 CSS pixels', '44 by 44 CSS pixels', '200%', '320 CSS pixels']) {
      expect(a11y).toContain(figure)
    }
    // 1.4.1 and the focus distinction are the two claims that are easy to get
    // backwards, and each carries its level.
    expect(a11y).toContain('SC 1.4.1')
    expect(a11y).toContain('Level A')
    // prefers-reduced-motion is NOT a WCAG criterion, and saying so is a
    // deliberate correction of a common misstatement.
    expect(a11y).toContain('not a WCAG success criterion')
    expect(a11y).toContain('https://www.w3.org/TR/WCAG22/')

    const review = readFileSync(skillPath('nexus-design-review', home), 'utf-8')
    // The report-don't-fix boundary, stated as a refusal.
    expect(review).toContain('You refuse to:')
    // Matched on a line-wrap-insensitive phrase: the prose is hard-wrapped at
    // 78 columns, so a multi-word assertion spanning a break fails for reasons
    // unrelated to the behaviour. The fragment below sits on one line.
    expect(review).toContain('change the thing you are auditing')
    expect(review).toContain('reviewer who')
    // Severity ordering, and the six brief fields it reports in.
    for (const severity of ['Blocking', 'Serious', 'Polish']) {
      expect(review).toContain(severity)
    }
    for (const field of ['**Problem**', '**Direction**', '**Rationale**', '**States**', '**Constraints**', '**Open questions**']) {
      expect(review).toContain(field)
    }
  })
})

describe('nexus design skills: write only when the content differs', () => {
  it('does not rewrite when the content is already identical', () => {
    // The mtime is the observable, and it is backdated first so a rewrite in
    // the same millisecond cannot be mistaken for no-rewrite. Comparing content
    // instead would prove nothing here: the agent files are rewritten on every
    // load and would pass that check.
    const home = makeHome()
    installNexusSkills(SOURCE_DIR, home)

    const targets = NEXUS_SKILL_NAMES.map(name => skillPath(name, home))
    const backdated = new Date('2001-02-03T04:05:06Z')
    for (const path of targets) {
      expect(existsSync(path)).toBe(true)
      utimesSync(path, backdated, backdated)
    }

    const results = installNexusSkills(SOURCE_DIR, home)
    expect(results.map(r => r.action)).toEqual(['unchanged', 'unchanged', 'unchanged'])

    for (const path of targets) {
      expect(statSync(path).mtimeMs).toBe(backdated.getTime())
    }
  })

  it('overwrites when a shipped body changes, which is the version-update case', () => {
    // Simulates the next release editing a SKILL.md: the on-disk copy holds the
    // old bytes, the shipped copy holds new ones, and the file must update.
    const home = makeHome()
    const source = mkdtempSync(join(tmpdir(), 'nexus-skills-src-'))
    installNexusSkills(SOURCE_DIR, home)

    const name = 'nexus-design-review'
    const changed = readFileSync(join(SOURCE_DIR, name, 'SKILL.md'), 'utf-8') +
      '\n## A rule added in a later version\n'
    stageSkill(source, name, changed)
    // The other two are absent from the staged source, so they report
    // `unavailable` rather than being silently skipped.
    const results = installNexusSkills(source, home)
    const byName = new Map(results.map(r => [r.name, r.action]))
    expect(byName.get(name)).toBe('updated')
    expect(readFileSync(skillPath(name, home), 'utf-8')).toBe(changed)

    rmSync(source, { recursive: true, force: true })
  })

  it('overwrites a user-modified file on a version change — a decision, not an oversight', () => {
    // PINNED DECISION, NOT AN OVERSIGHT. The user chose "overwrite on every
    // version change" over "warn and spare", so a hand-edited global copy IS
    // clobbered when the shipped text differs. This is correct behaviour, not
    // a bug, and the reason is that the global copy is plugin-managed: the
    // supported way to customise a nexus skill is project `.opencode/skills`,
    // which wins by OpenCode's own precedence. If this test ever fails, read
    // this comment before "fixing" the installer.
    const home = makeHome()
    const source = mkdtempSync(join(tmpdir(), 'nexus-skills-src-'))
    const name = 'nexus-design-taste'

    // What a user would have: the installed file, hand-edited.
    installNexusSkills(SOURCE_DIR, home)
    const target = skillPath(name, home)
    const userEdit = readFileSync(target, 'utf-8').replace(/^# .*$/m, '# my house style')
    expect(userEdit).toContain('# my house style')
    writeFileSync(target, userEdit, 'utf-8')

    // A version ships different text for that skill.
    const nextVersion = readFileSync(join(SOURCE_DIR, name, 'SKILL.md'), 'utf-8') +
      '\n## Changed upstream\n'
    stageSkill(source, name, nextVersion)
    const results = installNexusSkills(source, home)
    const action = results.find(r => r.name === name)?.action

    expect(action).toBe('updated')
    expect(readFileSync(target, 'utf-8')).toBe(nextVersion)
    expect(readFileSync(target, 'utf-8')).not.toContain('my house style')

    rmSync(source, { recursive: true, force: true })
  })

  it('leaves a user-modified file alone when the shipped text still matches', () => {
    // The other half of the decision above, and the reason it is tolerable:
    // an edit is only ever lost by a NEW VERSION of the skill, never by an
    // ordinary plugin load. Editing the global copy is therefore safe between
    // releases — it is durable right up until upstream changes that file.
    const home = makeHome()
    installNexusSkills(SOURCE_DIR, home)
    const name = 'nexus-interface-a11y'
    const target = skillPath(name, home)
    const edited = readFileSync(target, 'utf-8') + '\nour note\n'
    writeFileSync(target, edited, 'utf-8')
    const backdated = new Date('2001-02-03T04:05:06Z')
    utimesSync(target, backdated, backdated)

    // The shipped text is unchanged here — the same bytes this version ships.
    const results = installNexusSkills(SOURCE_DIR, home)

    // The edit does NOT match the shipped text, so this install DOES update it.
    // Pinned deliberately: a build of the installer that compared only a version
    // marker rather than content would report `unchanged` and preserve the edit,
    // which is the opposite of the pinned decision above.
    expect(results.find(r => r.name === name)?.action).toBe('updated')
    expect(readFileSync(target, 'utf-8')).not.toContain('our note')
  })
})

describe('nexus design skills: warning when a bundled skill is overwritten', () => {
  /**
   * A source tree where every skill's shipped text differs from what is already
   * installed in `home` — i.e. "a new version of the plugin shipped different
   * prose", the one case where a user edit can be destroyed.
   */
  function stageAllChanged(source: string, home: string): void {
    installNexusSkills(SOURCE_DIR, home)
    for (const name of NEXUS_SKILL_NAMES) {
      stageSkill(source, name, readFileSync(join(SOURCE_DIR, name, 'SKILL.md'), 'utf-8') + `\n## ${name} v2\n`)
    }
  }

  /**
   * Install and then report, exactly as `plugin.setup` does.
   *
   * The two steps in one closure so `captureWarnings` sees the whole load. This
   * is what keeps the relocated warning honestly covered: the assertion is on
   * the output of the real install-then-report path, not on `overwriteWarning`
   * called directly (which would pass even if the call site were deleted) and
   * not on the installer alone (which no longer prints anything).
   */
  function installAndReport(source: string, home: string): void {
    reportSkillInstalls(installNexusSkills(source, home))
  }

  it('warns on the overwrite, naming the file and where to customise instead', () => {
    // The absence this pins: the overwrite policy is the user's informed
    // choice, but a hand-edited global copy used to be clobbered with nothing
    // said. README documents the policy; README is not read by the person
    // editing a file at ~/.config/opencode/skills.
    //
    // Driven through `installAndReport`, i.e. the install and the reporting the
    // plugin actually performs. The warning moved out of the installer and into
    // the caller's loop, and the assertion moved with it rather than being
    // deleted — `overwriteWarning` is not exercised on its own anywhere, so
    // testing it in isolation would pass even if nothing ever called it.
    const home = makeHome()
    const source = mkdtempSync(join(tmpdir(), 'nexus-skills-src-'))
    installNexusSkills(SOURCE_DIR, home)

    const name = 'nexus-design-taste'
    const target = skillPath(name, home)
    writeFileSync(target, readFileSync(target, 'utf-8') + '\nmy house style\n')
    // All THREE staged, with only `name` bumped to a v2 body. The other two are
    // staged with the text this version already ships, so they resolve
    // `unchanged` and stay silent. Staging only the bumped one — which is what
    // this used to do — leaves the other two `unavailable`, and a missing skill
    // is now correctly reported by the same loop, so the count below would be
    // measuring the wrong thing.
    for (const skill of NEXUS_SKILL_NAMES) {
      const shipped = readFileSync(join(SOURCE_DIR, skill, 'SKILL.md'), 'utf-8')
      stageSkill(source, skill, skill === name ? shipped + '\n## v2\n' : shipped)
    }

    const warnings = captureWarnings(() => installAndReport(source, home))

    // Asserted on the text, not merely that a warning happened: a message that
    // is empty, or that says only "updated", satisfies "a warning fired" while
    // leaving the user with nothing actionable — the exact failure intended here.
    expect(warnings.length).toBe(1)
    const [warning] = warnings
    // Names the file, so it can be found.
    expect(warning).toContain(target)
    expect(warning).toContain(name)
    // Says it is plugin-managed and will come back on upgrade.
    expect(warning).toContain('plugin')
    expect(warning).toContain('upgrade')
    // Says where to customise instead: project `.opencode/skills`, which wins
    // by OpenCode's own precedence. This is the plugin's only escape hatch and
    // the reason it ships no override mechanism of its own.
    expect(warning).toContain(`.opencode/skills/${name}/SKILL.md`)
    // Shares the existing `[nexus] ` prefix used by every other channel in the
    // plugin, so this is recognisable as plugin output and not stray noise.
    expect(warning.startsWith('[nexus]')).toBe(true)

    rmSync(source, { recursive: true, force: true })
  })

  it('does not warn on a first install — a missing file is not a surprise', () => {
    // Warning about creating a file the user never had would be pure noise, and
    // noise on the very first run is how a user learns to ignore this channel.
    //
    // Through `installAndReport`, because the silence now belongs to the
    // REPORTER: the installer prints nothing at all, so a test that captured
    // only the install would pass whether or not `created` were reported. The
    // absence is asserted where the behaviour now lives.
    const home = makeHome()

    const warnings = captureWarnings(() => installAndReport(SOURCE_DIR, home))

    expect(warnings).toEqual([])
    // And the install really did happen, so the silence above is a decision
    // rather than the installer doing nothing at all.
    for (const name of NEXUS_SKILL_NAMES) {
      expect(existsSync(skillPath(name, home))).toBe(true)
    }
    // The outcomes really were `created`, so the silence is a decision about
    // that action and not about a result the loop never saw.
    expect(installNexusSkills(SOURCE_DIR, home).every(r => r.action === 'unchanged')).toBe(true)
  })

  it('does not warn, and does not write, when the on-disk copy already matches', () => {
    // The steady state: almost every plugin load. A warning here would fire on
    // nearly every startup, which is precisely how a warning stops being read.
    const home = makeHome()
    installNexusSkills(SOURCE_DIR, home)
    const targets = NEXUS_SKILL_NAMES.map(name => skillPath(name, home))
    const backdated = new Date('2001-02-03T04:05:06Z')
    for (const path of targets) utimesSync(path, backdated, backdated)

    const warnings = captureWarnings(() => installAndReport(SOURCE_DIR, home))

    expect(warnings).toEqual([])
    // "No write" is asserted via mtime, not content: the content check would
    // pass even if the file had been rewritten with identical bytes.
    for (const path of targets) {
      expect(statSync(path).mtimeMs).toBe(backdated.getTime())
    }
  })

  it('warns once per overwritten file, each naming its own path', () => {
    // The per-file-vs-summary decision, pinned. A summary would emit one
    // warning listing three paths; per-file emits three naming one each. The
    // count is asserted as well as the presence, because "a warning fired" and
    // "three warnings fired, one per file" are different contracts and only the
    // second one is the per-file behaviour.
    const home = makeHome()
    const source = mkdtempSync(join(tmpdir(), 'nexus-skills-src-'))
    stageAllChanged(source, home)

    const warnings = captureWarnings(() => installAndReport(source, home))

    expect(warnings.length).toBe(NEXUS_SKILL_NAMES.length)
    // Every skill is represented exactly once — no duplicates, none missed.
    for (const name of NEXUS_SKILL_NAMES) {
      const forThisSkill = warnings.filter(w => w.includes(skillPath(name, home)))
      expect(forThisSkill.length).toBe(1)
      // Each one is self-sufficient: it names its own project override, so a
      // user reading only the first warning is not left guessing.
      expect(forThisSkill[0]).toContain(`.opencode/skills/${name}/SKILL.md`)
    }

    rmSync(source, { recursive: true, force: true })
  })

  it('does not claim an overwrite for a skill that did not ship', () => {
    // RESTATED, because the two warnings now share a channel.
    //
    // This used to assert that a missing SKILL.md produced no output AT ALL
    // from the installer, on the grounds that the two cases were reported from
    // different places and had to stay that way. They no longer are: the
    // overwrite warning moved into the caller's loop beside the `unavailable`
    // one, deliberately, so there is one reporting style for the feature. The
    // assertion that still has teeth is the narrower and more useful one — a
    // skill that did not ship is reported as MISSING, never as an overwrite,
    // because it never touched the user's files and telling them their edit was
    // clobbered would be false.
    const home = makeHome()
    const source = mkdtempSync(join(tmpdir(), 'nexus-skills-partial-'))
    stageSkill(source, 'nexus-design-taste', '# only one\n')

    const warnings = captureWarnings(() => installAndReport(source, home))

    // The two absent skills are named as missing, each once.
    expect(warnings.filter(w => w.includes('is not present in the installed package')).length)
      .toBe(NEXUS_SKILL_NAMES.length - 1)
    // And nothing anywhere claims an overwrite happened, for any skill. This is
    // the part that would fail if `unavailable` were ever folded into the
    // `updated` arm.
    expect(warnings.filter(w => w.includes('Overwrote'))).toEqual([])
    // The one skill that did ship is not named at all: it was `created`, which
    // the reporter deliberately ignores. Asserted by absence rather than by
    // counting, so a `created` that started reporting would fail here.
    expect(warnings.filter(w => w.includes('nexus-design-taste'))).toEqual([])

    rmSync(source, { recursive: true, force: true })
  })
})

describe('nexus design skills: resilience', () => {
  it('reports a skill that did not ship instead of failing silently', () => {
    // A skill missing from the tarball is the whole feature failing quietly.
    // The installer must say so per-skill, and must still install the rest
    // rather than taking all three down with it.
    const home = makeHome()
    const source = mkdtempSync(join(tmpdir(), 'nexus-skills-partial-'))
    const present = 'nexus-design-taste'

    // A source tree holding exactly one of the three skills.
    stageSkill(source, present, '# only one\n')

    const results = installNexusSkills(source, home)
    const byName = new Map(results.map(r => [r.name, r.action]))
    expect(byName.get(present)).toBe('created')
    for (const name of NEXUS_SKILL_NAMES) {
      if (name === present) continue
      expect(byName.get(name)).toBe('unavailable')
    }
    // The available one is genuinely on disk.
    expect(readFileSync(skillPath(present, home), 'utf-8')).toBe('# only one\n')

    rmSync(source, { recursive: true, force: true })
  })
})

describe('nexus design skills: wiring into plugin load', () => {
  it('boots the plugin and lands the skills under the sandboxed home', async () => {
    // The unit tests above exercise installNexusSkills directly, which cannot
    // show that `plugin.setup()` calls it. This boots the real plugin against
    // the mocked homedir and checks the files are actually in
    // `<sandbox>/.config/opencode/skills/` — the end-to-end claim the README
    // makes.
    const { default: plugin } = await import('../src/index')
    const ctx: any = {
      location: { directory: SANDBOX_HOME },
      event: { subscribe: mock(() => Promise.resolve(() => {})) },
      storage: {
        set: mock(() => Promise.resolve()),
        get: mock(() => Promise.resolve(null)),
      },
      tool: {
        transform: mock(async (cb: any) => {
          cb({ namespace: () => {}, add: (t: any) => { void t } })
        }),
        list: mock(() => Promise.resolve([])),
      },
      session: {
        create: mock(() => Promise.resolve({ id: 'ses_skills' })),
        prompt: mock(() => Promise.resolve()),
        wait: mock(() => Promise.resolve()),
        context: mock(() => Promise.resolve([])),
        background: mock(() => Promise.resolve()),
        hook: mock(() => Promise.resolve()),
      },
    }

    await plugin.setup(ctx)

    for (const name of NEXUS_SKILL_NAMES) {
      const path = skillPath(name, SANDBOX_HOME)
      expect(existsSync(path)).toBe(true)
      const body = readFileSync(path, 'utf-8')
      expect(body).toBe(readFileSync(join(SOURCE_DIR, name, 'SKILL.md'), 'utf-8'))
      expect(frontmatter(body).name).toBe(name)
    }
  })

  it('keeps the reporting reachable from a real plugin load', async () => {
    // Closes a gap that mutation testing found. With the warning moved into the
    // caller's loop, every other test here drives `reportSkillInstalls` by hand,
    // and deleting the CALL from `plugin.setup` left all of them green — the
    // feature would have been mute in production while the suite reported it
    // covered. This asserts the two halves that a hand-driven test cannot see:
    // that the load path calls the reporter, and that it does so with the
    // installer's real results.
    // `SANDBOX_HOME`, not a per-test temp home: `plugin.setup` installs under
    // `homedir()`, which is mocked at the top of this file, so a different
    // directory here would simply not be the one written to. The skills are
    // therefore already present from the load above, which makes this second
    // load resolve `unchanged` — the quietest possible outcome, and the one
    // where a reporter that is wired up but wrong stays silent.
    const { default: plugin } = await import('../src/index')
    const ctx = (): any => ({
      location: { directory: SANDBOX_HOME },
      event: { subscribe: mock(() => Promise.resolve(() => {})) },
      storage: { set: mock(() => Promise.resolve()), get: mock(() => Promise.resolve(null)) },
      tool: {
        transform: mock(async (cb: any) => { cb({ namespace: () => {}, add: (t: any) => { void t } }) }),
        list: mock(() => Promise.resolve([])),
      },
      session: {
        create: mock(() => Promise.resolve({ id: 'ses_skills' })),
        prompt: mock(() => Promise.resolve()),
        wait: mock(() => Promise.resolve()),
        context: mock(() => Promise.resolve([])),
        background: mock(() => Promise.resolve()),
        hook: mock(() => Promise.resolve()),
      },
    })

    // A clean first load: the skills land and NOTHING is reported, which is the
    // steady state the silence assertions above are about, reached here through
    // the real boot rather than through a direct call.
    const warnings = await captureWarningsAsync(async () => { await plugin.setup(ctx()) })

    for (const name of NEXUS_SKILL_NAMES) {
      expect(existsSync(skillPath(name, SANDBOX_HOME))).toBe(true)
    }
    // No `unavailable` (all three ship) and no `updated` (nothing was there to
    // overwrite), so a correctly-wired reporter is silent here. Asserted
    // through the boot, which is the assertion the hand-driven tests duplicate.
    expect(warnings.filter(w => w.includes('is not present in the installed package'))).toEqual([])
    expect(warnings.filter(w => w.includes('Overwrote'))).toEqual([])

    // NOW the half that actually pins the wiring. Silence alone cannot: deleting
    // the `reportSkillInstalls(...)` call from `plugin.setup` leaves every
    // assertion above green, because a reporter that is never called and a
    // reporter that correctly ignores `unchanged` print the same thing. So the
    // user edits their global copy — which makes the next load an `updated` —
    // and the load is booted again. Only a reporter that is genuinely reached
    // from `setup` can print this.
    //
    // Restored afterwards, because `SANDBOX_HOME` is shared with the test above
    // and this file's `afterAll` removes it wholesale.
    const name = 'nexus-design-taste'
    const target = skillPath(name, SANDBOX_HOME)
    const original = readFileSync(target, 'utf-8')
    writeFileSync(target, original + '\nmy house style\n', 'utf-8')

    const second = await captureWarningsAsync(async () => { await plugin.setup(ctx()) })

    const overwrites = second.filter(w => w.includes('Overwrote'))
    expect(overwrites.length).toBe(1)
    // The full message, not just that one was printed: the path the user has to
    // act on, and the escape hatch that is the reason the plugin ships no
    // override mechanism of its own.
    expect(overwrites[0]).toContain(target)
    expect(overwrites[0]).toContain(`.opencode/skills/${name}/SKILL.md`)
    expect(overwrites[0].startsWith('[nexus]')).toBe(true)

    writeFileSync(target, original, 'utf-8')
  })
})
