import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { routeNexusCommand, type NexusLocalCommand } from '../src/tui'

/**
 * `/nexus <subcommand>` routing in the TUI.
 *
 * The defect this file is written against: the server's `handleCommand`
 * (`src/orchestrator.ts`) implements `status`, `agents`, `costs`, `pause`,
 * `resume` and `dashboard`, while the TUI's dispatcher handled only `config`,
 * `status`, `dashboard`, `overview`, `web`, `model` and `reset`. Everything
 * else fell to `default:` and showed a command list — a list that did not
 * contain the word the user had just typed. So `/nexus agents`,
 * `/nexus costs`, `/nexus pause` and `/nexus resume` were all silently
 * swallowed: a real server command, answered by a TUI that could not answer it.
 *
 * The fix is a fall-through (`routeNexusCommand`), and a fall-through has one
 * failure mode that a four-case switch does not: a name the TUI claims
 * locally could be forwarded instead, so `/nexus config` would open a prompt
 * rather than the config dialog. The tests below pin the forwarding half AND
 * the local-wins half, because only the second one can catch a routing change
 * that works for the four new commands and breaks the seven old ones.
 */
describe('/nexus routing: the four server-only commands reach the server', () => {
  it('forwards each of them, with the exact text the user typed', () => {
    // The STRING, not "something was submitted". A router that forwarded
    // `/nexus  `, or lowercased the word, or sent a fixed template, would pass
    // a `submitted === true` assertion and fail this one. `text` is what the
    // server's `handleCommand` will split, so it is the only thing that
    // matters end to end.
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['agents', '/nexus agents'],
      ['costs', '/nexus costs'],
      ['pause', '/nexus pause'],
      ['resume', '/nexus resume'],
    ]
    for (const [typed, expected] of cases) {
      const route = routeNexusCommand(typed)
      expect(route).toEqual({ kind: 'forward', text: expected })
    }
  })

  it('forwards the `agents` filter, because the server reads it at parts[2]', () => {
    // `handleCommand` does `this.listAgents(parts[2])`, so the filter is a real
    // argument and a router that dropped the tail would silently return
    // unfiltered agents. The tail is asserted through the forwarded string,
    // which is the only channel the TUI has — it cannot read the server's
    // reply back.
    const route = routeNexusCommand('agents reviewer')
    expect(route).toEqual({ kind: 'forward', text: '/nexus agents reviewer' })
  })

  it('keeps a multi-word tail intact rather than forwarding only the verb', () => {
    // The strongest form of the argument assertion: a router that forwarded
    // just `/nexus agents` would pass the test above if that test only checked
    // the verb, and would lose a user's filter silently. Compared against a
    // string built from the input, not from a literal.
    const input = 'agents  reviewer  working'
    const route = routeNexusCommand(input)
    expect(route.kind).toBe('forward')
    if (route.kind !== 'forward') throw new Error('unreachable')
    expect(route.text).toBe(`/nexus ${input.trim()}`)
  })

  it('forwards an unknown word too, so the server owns the command list', () => {
    // The other half of the robustness claim. The TUI used to answer an
    // unrecognised word with a hardcoded list, which is a second copy of a
    // list the server owns and which was already wrong. Forwarding lets the
    // server's own `Unknown command. Available: …` reply come back, so a
    // subcommand added there works from the TUI with no TUI edit.
    expect(routeNexusCommand('banana')).toEqual({ kind: 'forward', text: '/nexus banana' })
  })
})

describe('/nexus routing: a TUI-local command is never forwarded', () => {
  it('claims every local command, so none of them can reach the server', () => {
    // This is the test that fails if the fall-through is done wrong. If any of
    // these came back as `forward`, the corresponding dialog would stop opening
    // and start costing a model turn instead. Asserted over the whole local
    // vocabulary, aliases included, because an alias is exactly the string
    // most likely to be missed by a set that only lists the long forms.
    const local: ReadonlyArray<readonly [string, NexusLocalCommand]> = [
      ['config', 'config'],
      ['c', 'config'],
      ['status', 'status'],
      ['s', 'status'],
      ['dashboard', 'dashboard'],
      ['d', 'dashboard'],
      ['overview', 'overview'],
      ['web', 'web'],
      ['w', 'web'],
      ['model', 'model'],
      ['m', 'model'],
      ['reset', 'reset'],
    ]
    for (const [typed, expected] of local) {
      expect(routeNexusCommand(typed)).toEqual({ kind: 'local', command: expected })
    }
  })

  it('does not forward `config`, which must open the config dialog', () => {
    // Spelled out on its own because it is the specific regression named in the
    // brief: a fall-through that let `config` through would replace a local
    // dialog with a submitted prompt.
    const route = routeNexusCommand('config')
    expect(route.kind).toBe('local')
    // And specifically NOT a forward, asserted on the property rather than on
    // the whole object, so a route that grew extra fields cannot make this pass
    // by matching a snapshot taken after the fact.
    if (route.kind === 'forward') throw new Error(`config was forwarded as ${route.text}`)
  })

  it('claims a local command even when it carries an argument', () => {
    // `model <role>` and `dashboard [port] [host]` take arguments, and the
    // argument must not be what decides the route. A router that looked at the
    // whole input rather than the first token would forward `/nexus model
    // coder` and open a prompt instead of the role picker.
    expect(routeNexusCommand('model coder')).toEqual({ kind: 'local', command: 'model' })
    expect(routeNexusCommand('dashboard 4747')).toEqual({ kind: 'local', command: 'dashboard' })
    expect(routeNexusCommand('web 4748 0.0.0.0')).toEqual({ kind: 'local', command: 'web' })
  })

  it('claims a local command padded with whitespace', () => {
    // The user types spaces. A router that split on a single ' ' and compared
    // `parts[0]` without trimming would see `''` for a leading space and
    // forward `/nexus  config` — the exact failure above, reached by typing
    // normally.
    expect(routeNexusCommand('  config  ')).toEqual({ kind: 'local', command: 'config' })
    expect(routeNexusCommand(' agents ')).toEqual({ kind: 'forward', text: '/nexus agents' })
  })

  it('treats an empty argument as unknown rather than forwarding a bare command', () => {
    // `/nexus` with no argument opens the config flow, and that is decided by
    // the `if (input)` above the dispatcher — not by this function. Forwarding
    // `/nexus ` here would submit an empty command to the server, so the empty
    // case is reported distinctly and the caller keeps its existing behaviour.
    expect(routeNexusCommand('')).toEqual({ kind: 'unknown' })
    expect(routeNexusCommand('   ')).toEqual({ kind: 'unknown' })
    expect(routeNexusCommand(undefined)).toEqual({ kind: 'unknown' })
  })

  it('does not claim a local command by prefix: `configs` is not `config`', () => {
    // Guards the boundary in the other direction. If the local lookup ever
    // became a `startsWith`, then `agents` would still work and every test
    // above would still pass, while `costs`/`config` collisions appeared. The
    // server has no `configs`, so this must forward and be answered there.
    expect(routeNexusCommand('configs')).toEqual({ kind: 'forward', text: '/nexus configs' })
    expect(routeNexusCommand('cost')).toEqual({ kind: 'forward', text: '/nexus cost' })
  })

  it('does not treat an object prototype key as a local command', () => {
    // A real bug, found while writing this file rather than by being asked for.
    // The local lookup was `token in LOCAL_COMMANDS`, and `in` walks the
    // PROTOTYPE chain: `toString`, `constructor`, `valueOf` and `hasOwnProperty`
    // are all "in" a plain object literal. So `/nexus constructor` resolved to
    // `{ kind: 'local', command: Object }` — a local command that is not one,
    // carrying a value that is not a string. It would have been handed to the
    // dispatcher's switch, matched nothing, and been reported as a local
    // command that the TUI does not implement. The server was never asked, so
    // the exact swallowing this file exists to fix, reached by typing a word.
    //
    // Asserted for each prototype key, because fixing `constructor` alone (say,
    // by adding it to the local table, which would be the wrong fix) would
    // leave the other three.
    for (const key of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      const route = routeNexusCommand(key)
      expect(route.kind).toBe('forward')
      if (route.kind !== 'forward') throw new Error(`prototype key ${key} was claimed locally`)
    }
  })
})

describe('/nexus routing: it agrees with the server about what it implements', () => {
  /**
   * Every subcommand the server's `handleCommand` answers, read out of the
   * source rather than restated here.
   *
   * Parsed from `src/orchestrator.ts` so the list cannot go stale: a
   * subcommand added to the server shows up as a new entry in this array, and
   * the assertions below then state what the TUI does with it. Written as a
   * source read because a hand-copied list is a fourth copy of the same
   * enumeration — the bug class this whole change exists to remove.
   */
  function serverCommands(): string[] {
    const source = readFileSync(resolve(import.meta.dir, '..', 'src', 'orchestrator.ts'), 'utf-8')
    const start = source.indexOf('handleCommand(text: string): string {')
    if (start === -1) throw new Error('handleCommand not found in src/orchestrator.ts')
    // Up to the `default:` arm, so the subcommand cases are the only ones read
    // and the parser cannot wander into a later switch in the same file.
    const body = source.slice(start, source.indexOf('default:', start))
    const names = [...body.matchAll(/case '([a-z]+)':/g)].map(m => m[1])
    return [...new Set(names)]
  }

  it('routes every subcommand the server implements', () => {
    const implemented = serverCommands()
    // Non-empty, or the parse above silently matched nothing and this test
    // would pass while asserting nothing at all.
    expect(implemented.length).toBeGreaterThan(0)
    expect(implemented).toContain('agents')

    for (const command of implemented) {
      const route = routeNexusCommand(command)
      // Every one of them is reachable: either the TUI claims it, or the server
      // is asked. What must never happen is `unknown` — that is the bug, an
      // implemented command the user cannot run.
      expect(route.kind).not.toBe('unknown')
    }
  })

  it('agrees with the server on which of them the TUI answers itself', () => {
    // The overlap is the interesting part, and it is exactly two: `status` and
    // `dashboard` are implemented on BOTH sides, and the TUI answers them
    // locally on purpose — its own summary, and a browser-opening flow the
    // server cannot perform. The rest are server-only. Asserted as a set
    // comparison rather than a count, so losing or gaining a member fails.
    const serverOnly = serverCommands().filter(c => !['status', 'dashboard'].includes(c))
    expect(serverOnly.sort()).toEqual(['agents', 'costs', 'pause', 'resume'])

    for (const command of serverOnly) {
      expect(routeNexusCommand(command)).toEqual({ kind: 'forward', text: `/nexus ${command}` })
    }
    // And the two shared ones stay local, so the TUI's own behaviour is not
    // replaced by a round trip just because the server happens to know the word.
    expect(routeNexusCommand('status')).toEqual({ kind: 'local', command: 'status' })
    expect(routeNexusCommand('dashboard')).toEqual({ kind: 'local', command: 'dashboard' })
  })
})
