import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test"
import { EventEmitter } from "node:events"
import {
  NotificationManager,
  buildInvocation,
  buildMacOSInvocation,
  buildLinuxInvocation,
  buildWindowsInvocation,
  MACOS_SCRIPT_SILENT,
  MACOS_SCRIPT_WITH_SOUND,
  WINDOWS_NOTIFY_ENV,
  WINDOWS_SCRIPT,
  type NotificationInvocation,
  type NotificationOptions
} from "../src/notifications"

/**
 * A literal `${` in a plain string trips `noTemplateCurlyInString`. That is a
 * false positive here — the `${...}` IS the payload — so the sigil is
 * concatenated instead of suppressing a rule this repo does not otherwise
 * suppress. The resulting text is identical either way.
 */
const SIGIL = "$"

/**
 * Text that, if any of it ever reached a script or command STRING, would
 * break out of it or reach a shell. Assembled from the classes of escape
 * that matter per platform rather than from one platform's syntax, so the
 * same payload is hostile to AppleScript, PowerShell and a POSIX shell.
 */
const HOSTILE_TEXT = [
  'plain text',
  '"double quotes"',
  "'single quotes'",
  'x" & (do shell script "touch /tmp/pwned") & "y',
  '"; Remove-Item -Recurse C:\\ ; "#',
  '`backticks`',
  '$(whoami)',
  `${SIGIL}{IFS}`,
  'back\\slash "and\\" escape',
  'semi;colon && or || pipe | redirect > out',
  'line1\nline2',
  'new\r\nline',
  'tab\there',
  "'); Write-Output pwned; ('",
  `${SIGIL}{env:PATH}`,
  '\\u0041 unicode-ish \\x41'
].join(" ~ ")

/**
 * Title and body are DISTINCT hostile values, not the same one twice.
 *
 * With one shared payload, every argv assertion below still passes if the
 * builders emit `[..., body, title]` — the two are indistinguishable, so a
 * silent title/body swap across the whole product is undetectable by this
 * file. The runtime behaviour is correct by construction and was confirmed
 * positionally, but "correct today" is not the same as "pinned"; these markers
 * are what pin it. Each still contains all of `HOSTILE_TEXT`, so every
 * "the payload is not in the command string" assertion keeps working unchanged.
 */
const TITLE_MARKER = "TITLE-SLOT-MARKER"
const BODY_MARKER = "BODY-SLOT-MARKER"
const HOSTILE_TITLE = `${HOSTILE_TEXT} ~ ${TITLE_MARKER}`
const HOSTILE_BODY = `${HOSTILE_TEXT} ~ ${BODY_MARKER}`

/**
 * A spawn seam that no-ops: it records nothing, shows nothing, and resolves
 * `close` with the given code.
 *
 * Tests that used the real `spawn` fired genuine OS notifications on a
 * developer's machine — including, for a while, real notifications titled with
 * the injection payload below. Worse than the noise: a real notifier's exit
 * code is host-dependent, so any assertion built on it was only as stable as
 * the machine running it. Nothing in this file needs a real notifier; the
 * argv assertions are the security property, and the outcome assertions want a
 * chosen exit code.
 */
function fakeSpawnExiting(code: number | null): () => never {
  return () => {
    const proc = new EventEmitter() as EventEmitter & {
      kill: () => void
      killed: boolean
      stderr: null
    }
    proc.kill = () => {}
    proc.killed = false
    proc.stderr = null
    queueMicrotask(() => proc.emit("close", code))
    return proc as never
  }
}

describe("NotificationManager", () => {
  let manager: NotificationManager

  beforeEach(() => {
    manager = new NotificationManager()
  })

  describe("constructor", () => {
    it("should create with default enabled state", () => {
      expect(manager.isEnabled()).toBe(true)
    })

    it("should create with disabled state", () => {
      const disabled = new NotificationManager(false)
      expect(disabled.isEnabled()).toBe(false)
    })
  })

  describe("setEnabled / isEnabled", () => {
    it("should toggle enabled state", () => {
      manager.setEnabled(false)
      expect(manager.isEnabled()).toBe(false)
      manager.setEnabled(true)
      expect(manager.isEnabled()).toBe(true)
    })
  })

  describe("notify", () => {
    it("should return false when disabled", async () => {
      manager.setEnabled(false)
      const result = await manager.notify({ title: "Test", body: "Hello" })
      expect(result).toBe(false)
    })

    it("should return a boolean when enabled", async () => {
      // Will return false on CI (no display), but should not throw
      const result = await manager.notify({ title: "Test", body: "Hello" })
      expect(typeof result).toBe("boolean")
    })

    it("should accept notification options", async () => {
      // Should not throw with any option combination
      const options: NotificationOptions[] = [
        { title: "Test", body: "Hello" },
        { title: "Test", body: "Hello", sound: true },
        { title: "Test", body: "Hello", sound: false },
        { title: "Test", body: "Hello", silent: true },
      ]
      for (const opts of options) {
        const result = await manager.notify(opts)
        expect(typeof result).toBe("boolean")
      }
    })

    it("should not crash on errors (best-effort)", async () => {
      // Even with invalid data, should not throw
      const result = await manager.notify({ title: "", body: "" })
      expect(typeof result).toBe("boolean")
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The injection tests.
//
// These assert on the GENERATED ARGV, not on whether a payload happened to
// execute. That is deliberate and is the more valuable test: it is fast,
// it is cross-platform, and — the key property — it CANNOT PASS BY LUCK. A
// side-effect test would pass or fail depending on the host's `osascript`
// and on whether the payload's side effect was observable, and on a machine
// where `osascript` is absent it would pass for the wrong reason. Asserting
// the script text is byte-identical to a constant that does not depend on
// the input catches the defect itself.
// ─────────────────────────────────────────────────────────────────────────────

describe("command injection", () => {
  const hostile: NotificationOptions = { title: HOSTILE_TITLE, body: HOSTILE_BODY, sound: true }
  const benign: NotificationOptions = { title: "Task done", body: "All good", sound: true }
  describe("macOS: the AppleScript is a constant and the text is argv", () => {
    it("emits a script byte-identical to the constant, with hostile text in no script", () => {
      const args = buildMacOSInvocation(hostile).args
      expect(args[0]).toBe("-e")
      expect(args[1]).toBe(MACOS_SCRIPT_WITH_SOUND)
    })

    it("produces the SAME script for benign and hostile input (input-independence)", () => {
      // The property that actually matters, and one that no amount of
      // correct escaping can fake: the script text is a function of the
      // options' FLAGS only, never of their content.
      const withSound = buildMacOSInvocation(hostile).args[1]
      const withBenign = buildMacOSInvocation(benign).args[1]
      const silent = buildMacOSInvocation({ ...hostile, silent: true }).args[1]
      const soundOff = buildMacOSInvocation({ ...hostile, sound: false }).args[1]
      expect(withSound).toBe(withBenign)
      expect(silent).toBe(MACOS_SCRIPT_SILENT)
      expect(soundOff).toBe(MACOS_SCRIPT_SILENT)
      expect(silent).not.toBe(MACOS_SCRIPT_WITH_SOUND)
    })

    it("passes the text only as discrete argv elements after a `--` terminator", () => {
      const args = buildMacOSInvocation(hostile).args
      // `--` must sit between the script and the data, or osascript consumes a
      // leading-dash title as one of its own options — verified on darwin,
      // where a title of `-l` fails with `no such component "B"`.
      expect(args[2]).toBe("--")
      // Distinct values, in this order: `osascript` reads `item 1` as the title
      // and `item 2` as the body, so a swap here is a silent inversion.
      expect(args[3]).toBe(HOSTILE_TITLE)
      expect(args[4]).toBe(HOSTILE_BODY)
      // Nothing else in argv carries it.
      expect(args.length).toBe(5)
    })

    it("keeps the hostile text out of every element except the two data slots", () => {
      const args = [...buildMacOSInvocation(hostile).args]
      // Remove exactly the two slots that are allowed to hold the payload;
      // whatever is left must be only the fixed scaffolding.
      expect(args.splice(3, 2)).toEqual([HOSTILE_TITLE, HOSTILE_BODY])
      expect(args).toEqual(["-e", MACOS_SCRIPT_WITH_SOUND, "--"])
      // And none of the shell primitives that make a payload dangerous can
      // appear anywhere in that residue. (Quotes legitimately do, in the
      // constant `sound name "Glass"` — which is exactly why the assertion
      // above pins the residue to byte-identical constants rather than
      // trying to blacklist characters.)
      const residue = args.join("\u0000")
      for (const fragment of ["&", "`", "$(", "${", "do shell script", "run script"]) {
        expect(residue).not.toContain(fragment)
      }
    })

    it("never mentions the payload's shell primitives inside the script", () => {
      const script = buildMacOSInvocation(hostile).args[1] as string
      // A hand-rolled "escape the quotes" fix would fail here even if it
      // happened to be correct for the payload at hand, because the script
      // would have grown escaping machinery.
      expect(script).not.toContain("\\\"")
      expect(script).not.toContain("do shell script")
      expect(script).not.toContain("run script")
      expect(script).toContain("(item 1 of argv)")
      expect(script).toContain("(item 2 of argv)")
    })

    it("survives a title that looks like an osascript option", () => {
      const args = buildMacOSInvocation({ title: "-l", body: "-e" }).args
      expect(args[2]).toBe("--")
      expect(args[3]).toBe("-l")
      expect(args[4]).toBe("-e")
    })
  })

  describe("Linux: already argv, and still argv", () => {
    it("passes title and body as the only two argv elements, in that order", () => {
      const args = buildLinuxInvocation(hostile).args
      expect(args).toEqual([HOSTILE_TITLE, HOSTILE_BODY])
    })

    it("has no script surface at all", () => {
      expect(buildLinuxInvocation(hostile).command).toBe("notify-send")
      expect(buildLinuxInvocation(hostile).env).toBeUndefined()
    })
  })

  describe("Windows: constant -Command script, text in the environment", () => {
    it("emits a command string byte-identical to the constant", () => {
      const invocation = buildWindowsInvocation(hostile)
      const commandIndex = invocation.args.indexOf("-Command")
      expect(commandIndex).toBeGreaterThan(-1)
      expect(invocation.args[commandIndex + 1]).toBe(WINDOWS_SCRIPT)
    })

    it("produces the SAME command string for benign and hostile input", () => {
      expect(buildWindowsInvocation(hostile).args).toEqual(buildWindowsInvocation(benign).args)
    })

    it("does NOT put user text in any argv element (regression on the -Command form)", () => {
      // `powershell -Command <script> <text>` APPENDS the text to the command
      // string — the docs state all arguments after -Command are interpreted
      // as part of the command. So the text must not be an argv element here,
      // and this assertion is what pins that decision down.
      const invocation = buildWindowsInvocation(hostile)
      for (const arg of invocation.args) {
        expect(arg).not.toContain(HOSTILE_TEXT)
        expect(arg).not.toContain(TITLE_MARKER)
        expect(arg).not.toContain(BODY_MARKER)
        expect(arg).not.toContain("do shell script")
        expect(arg).not.toContain("$(")
        expect(arg).not.toContain("${")
      }
    })

    it("does not reference BurntToast, which is absent on a stock Windows install", () => {
      expect(WINDOWS_SCRIPT).not.toContain("New-BurntToastNotification")
      expect(WINDOWS_SCRIPT).toContain("Windows.UI.Notifications")
    })

    it("carries the text in the environment, escaping it as data not code", () => {
      const env = buildWindowsInvocation(hostile).env
      expect(env?.[WINDOWS_NOTIFY_ENV.title]).toBe(HOSTILE_TITLE)
      expect(env?.[WINDOWS_NOTIFY_ENV.body]).toBe(HOSTILE_BODY)
      // The script reads the text as an env lookup and interpolates nothing.
      expect(WINDOWS_SCRIPT).toContain(`$env:${WINDOWS_NOTIFY_ENV.title}`)
      expect(WINDOWS_SCRIPT).toContain(`$env:${WINDOWS_NOTIFY_ENV.body}`)
      expect(WINDOWS_SCRIPT).toContain("CreateTextNode")
    })

    it("keeps a fixed set of leading flags so no field is user-controlled", () => {
      expect(buildWindowsInvocation(hostile).args.slice(0, 2)).toEqual([
        "-NoProfile",
        "-NonInteractive"
      ])
    })
  })

  describe("platform dispatch", () => {
    it("never returns a script for an unsupported platform", () => {
      expect(buildInvocation("sunos", hostile)).toBeNull()
      expect(buildInvocation("aix", hostile)).toBeNull()
    })
  })

  /**
   * The title/body ORDER, pinned once, for all three platforms.
   *
   * Every other assertion in this file is about where user text is allowed to
   * go. This one is about the one remaining thing that can be silently wrong
   * while every other test still passes: a builder emitting `[..., body,
   * title]`. That inverts every notification the product ever sends — title and
   * body swapped, and on Windows the AUMID-independent toast texts swapped too.
   *
   * It is worth its own block because it is the only test here that fails if
   * the two fields are transposed, and it is written against `buildInvocation`
   * rather than the per-platform builders so all three are covered by one
   * statement. `title` is pinned to `item 1`/`$texts.Item(0)`/`argv[0]`, which
   * is the reading order of every notifier involved.
   */
  describe("title before body, on every platform", () => {
    it("places the title ahead of the body in whatever channel carries them", () => {
      for (const platform of ["darwin", "linux", "win32"]) {
        const invocation = buildInvocation(platform, {
          title: TITLE_MARKER,
          body: BODY_MARKER
        })
        expect(invocation).not.toBeNull()
        const titleIndex = textChannels(platform, invocation!).indexOf(TITLE_MARKER)
        const bodyIndex = textChannels(platform, invocation!).indexOf(BODY_MARKER)
        expect(titleIndex).toBeGreaterThanOrEqual(0)
        expect(bodyIndex).toBeGreaterThanOrEqual(0)
        expect(titleIndex).toBeLessThan(bodyIndex)
      }
    })

    it("does not put the title in the body slot or the body in the title slot", () => {
      // Belt and braces on the same fact, phrased so the failure names the
      // transposition directly rather than as a numeric index mismatch.
      const mac = buildInvocation("darwin", { title: TITLE_MARKER, body: BODY_MARKER })
      expect(mac?.args).toContain(TITLE_MARKER)
      expect(mac?.args).toContain(BODY_MARKER)
      expect(mac?.args.indexOf(TITLE_MARKER)).toBeLessThan(mac?.args.indexOf(BODY_MARKER) as number)

      const linux = buildInvocation("linux", { title: TITLE_MARKER, body: BODY_MARKER })
      expect(linux?.args).toEqual([TITLE_MARKER, BODY_MARKER])

      const win = buildInvocation("win32", { title: TITLE_MARKER, body: BODY_MARKER })
      expect(win?.env?.[WINDOWS_NOTIFY_ENV.title]).toBe(TITLE_MARKER)
      expect(win?.env?.[WINDOWS_NOTIFY_ENV.body]).toBe(BODY_MARKER)
      expect(win?.env?.[WINDOWS_NOTIFY_ENV.body]).not.toBe(TITLE_MARKER)
    })
  })
})

/**
 * Every channel a platform can carry user text in, in the order a notifier
 * reads them: argv on darwin and linux, environment on win32.
 */
function textChannels(platform: string, invocation: NotificationInvocation): string[] {
  return platform === "win32"
    ? [invocation.env?.[WINDOWS_NOTIFY_ENV.title] ?? "", invocation.env?.[WINDOWS_NOTIFY_ENV.body] ?? ""]
    : [...invocation.args]
}

describe("failure is visible", () => {
  it("counts a success and reports it", async () => {
    // `spawnImpl` rather than the real `spawn`: the old version fired a real
    // notification on the developer's machine, and then could only assert
    // `typeof result === "boolean"` because a real notifier's exit code is
    // host-dependent. A no-op notifier that exits 0 makes this deterministic
    // AND falsifiable — a manager that lost the success, or counted it as a
    // failure, fails here instead of passing for any reason at all.
    const manager = new NotificationManager(true, { spawnImpl: fakeSpawnExiting(0) })
    const result = await manager.notify({ title: "T", body: "B" })
    expect(result).toBe(true)
    const stats = manager.getStats()
    expect(stats.sent).toBe(1)
    expect(stats.failed).toBe(0)
    expect(stats.lastError).toBeNull()
    expect(stats.platform).toBe(process.platform)
  })

  it("counts a suppression when disabled, and says the last error is untouched", async () => {
    const manager = new NotificationManager(false)
    await manager.notify({ title: "T", body: "B" })
    const stats = manager.getStats()
    expect(stats.suppressed).toBe(1)
    expect(stats.sent).toBe(0)
    // A deliberate mute is not a failure, so it must not look like one.
    expect(stats.failed).toBe(0)
    expect(stats.lastError).toBeNull()
  })

  it("records a reason when the notifier exits non-zero, and logs it", async () => {
    const errorLog = mock((..._args: unknown[]) => {})
    const previous = console.error
    console.error = errorLog
    try {
      const manager = new NotificationManager(true, {
        spawnImpl: () => {
          const proc = new EventEmitter() as EventEmitter & {
            kill: () => void
            killed: boolean
            stderr: null
          }
          proc.kill = () => {}
          proc.killed = false
          proc.stderr = null
          queueMicrotask(() => proc.emit("close", 1))
          return proc as never
        }
      })
      const result = await manager.notify({ title: "T", body: "B" })
      expect(result).toBe(false)
      const stats = manager.getStats()
      expect(stats.failed).toBe(1)
      expect(stats.sent).toBe(0)
      expect(stats.lastError).toContain("exited with code 1")
      expect(stats.lastErrorAt).not.toBeNull()
      // The reason is findable, not just counted.
      expect(errorLog).toHaveBeenCalled()
      expect(String(errorLog.mock.calls[0]?.[0])).toContain("exited with code 1")
    } finally {
      console.error = previous
    }
  })

  it("records a reason when the notifier cannot start at all", async () => {
    const errorLog = mock((..._args: unknown[]) => {})
    const previous = console.error
    console.error = errorLog
    try {
      const manager = new NotificationManager(true, {
        spawnImpl: () => {
          const proc = new EventEmitter() as EventEmitter & {
            kill: () => void
            killed: boolean
            stderr: null
          }
          proc.kill = () => {}
          proc.killed = false
          proc.stderr = null
          queueMicrotask(() => proc.emit("error", new Error("spawn osascript ENOENT")))
          return proc as never
        }
      })
      expect(await manager.notify({ title: "T", body: "B" })).toBe(false)
      expect(manager.getStats().lastError).toContain("could not start")
      expect(manager.getStats().lastError).toContain("ENOENT")
    } finally {
      console.error = previous
    }
  })

  it("never throws into a task path, whatever the text", async () => {
    // No real notifier: this used to genuinely display `HOSTILE_TEXT` as a
    // notification title on whoever ran `bun test`. The hostile-text guarantee
    // is a property of the generated argv, which the "command injection" block
    // above asserts directly; spawning it adds noise and nothing else.
    const manager = new NotificationManager(true, { spawnImpl: fakeSpawnExiting(0) })
    await expect(manager.notify({ title: HOSTILE_TITLE, body: HOSTILE_BODY })).resolves.toBe(true)
    await expect(manager.notify({ title: "", body: "" })).resolves.toBe(true)
    // And the counters stayed coherent through both.
    expect(manager.getStats().failed).toBe(0)
    expect(manager.getStats().sent).toBe(2)
  })

  it("reports a failure rather than throwing when the notifier is unusable", async () => {
    // The other half of "never throws": a broken notifier is a recorded
    // failure, not an exception escaping into a DAG node.
    const manager = new NotificationManager(true, { spawnImpl: fakeSpawnExiting(1) })
    const previous = console.error
    console.error = mock(() => {})
    try {
      expect(await manager.notify({ title: HOSTILE_TITLE, body: HOSTILE_BODY })).toBe(false)
      expect(manager.getStats().failed).toBe(1)
      expect(manager.getStats().lastError).toContain("exited with code 1")
    } finally {
      console.error = previous
    }
  })
})

describe("notifications.test() reports the real result", () => {
  it("reports success when the notifier exits 0", async () => {
    const manager = new NotificationManager(true, {
      spawnImpl: () => {
        const proc = new EventEmitter() as EventEmitter & {
          kill: () => void
          killed: boolean
          stderr: null
        }
        proc.kill = () => {}
        proc.killed = false
        proc.stderr = null
        queueMicrotask(() => proc.emit("close", 0))
        return proc as never
      }
    })
    const result = await manager.test()
    expect(result.delivered).toBe(true)
    expect(result.reason).toBeNull()
    expect(result.platform).toBe(process.platform)
  })

  it("reports NOT delivered, with a reason, when the notifier fails", async () => {
    const previous = console.error
    console.error = mock(() => {})
    try {
      const manager = new NotificationManager(true, {
        spawnImpl: () => {
          const proc = new EventEmitter() as EventEmitter & {
            kill: () => void
            killed: boolean
            stderr: null
          }
          proc.kill = () => {}
          proc.killed = false
          proc.stderr = null
          queueMicrotask(() => proc.emit("close", 2))
          return proc as never
        }
      })
      const result = await manager.test()
      // The whole point: never a hardcoded success.
      expect(result.delivered).toBe(false)
      expect(result.reason).toContain("exited with code 2")
    } finally {
      console.error = previous
    }
  })

  it("probes even when notifications are switched off, and says so", async () => {
    const manager = new NotificationManager(false, {
      spawnImpl: () => {
        const proc = new EventEmitter() as EventEmitter & {
          kill: () => void
          killed: boolean
          stderr: null
        }
        proc.kill = () => {}
        proc.killed = false
        proc.stderr = null
        queueMicrotask(() => proc.emit("close", 0))
        return proc as never
      }
    })
    const result = await manager.test()
    // "are notifications working?" and "are they muted?" are different
    // questions, and both are now answerable from one call.
    expect(result.enabled).toBe(false)
    expect(result.delivered).toBe(true)
    // ...and a probe is not run traffic, so it does not inflate the counters.
    expect(result.stats.sent).toBe(0)
    expect(result.stats.failed).toBe(0)
  })

  it("reports the notifier's own reason rather than a generic one", async () => {
    // This block previously asserted only `typeof result.delivered ===
    // "boolean"` on all three supported platforms, which is true of a method
    // that returned a hardcoded `false` — near-vacuous, and it is dropped in
    // favour of the branch that can actually fail. The SUPPORTED branch is
    // covered above ("reports success when the notifier exits 0" and "reports
    // NOT delivered, with a reason, when the notifier fails"), both with a
    // chosen exit code, so nothing is lost by not re-asserting the shape here.
    const manager = new NotificationManager(true, { spawnImpl: fakeSpawnExiting(3) })
    const previous = console.error
    console.error = mock(() => {})
    try {
      const result = await manager.test()
      // On any platform with no notifier the reason must name the platform;
      // on the three CI platforms the reason must be the notifier's own.
      if (process.platform === "darwin" || process.platform === "linux" || process.platform === "win32") {
        expect(result.delivered).toBe(false)
        expect(result.reason).toContain("exited with code 3")
      } else {
        expect(result.delivered).toBe(false)
        expect(result.reason).toContain("no notifier")
        expect(result.reason).toContain(process.platform)
      }
    } finally {
      console.error = previous
    }
  })
})

describe("no handle outlives the notifier", () => {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  let outstanding = 0

  beforeEach(() => {
    outstanding = 0
    globalThis.setTimeout = ((handler: () => void, ms?: number, ...rest: unknown[]) => {
      outstanding += 1
      return realSetTimeout(handler, ms, ...rest)
    }) as unknown as typeof globalThis.setTimeout
    globalThis.clearTimeout = ((handle: unknown) => {
      outstanding -= 1
      return realClearTimeout(handle as never)
    }) as unknown as typeof globalThis.clearTimeout
  })

  afterEach(() => {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  })

  function fakeSpawn(emit: (proc: EventEmitter) => void) {
    return () => {
      const proc = new EventEmitter() as EventEmitter & {
        kill: () => void
        killed: boolean
        stderr: null
      }
      proc.kill = () => {
        proc.killed = true
      }
      proc.killed = false
      proc.stderr = null
      queueMicrotask(() => emit(proc))
      return proc as never
    }
  }

  it("leaves no pending timer when the notifier closes quickly", async () => {
    // osascript normally returns in well under 3s, so the old code armed a
    // 3s timer for EVERY notification and never cleared it.
    const manager = new NotificationManager(true, { spawnImpl: fakeSpawn(p => p.emit("close", 0)) })
    expect(await manager.notify({ title: "T", body: "B" })).toBe(true)
    expect(outstanding).toBe(0)
  })

  it("leaves no pending timer when the notifier fails to start", async () => {
    const manager = new NotificationManager(true, {
      spawnImpl: fakeSpawn(p => p.emit("error", new Error("ENOENT")))
    })
    const previous = console.error
    console.error = mock(() => {})
    try {
      expect(await manager.notify({ title: "T", body: "B" })).toBe(false)
      expect(outstanding).toBe(0)
    } finally {
      console.error = previous
    }
  })

  it("resolves exactly once, and does nothing, when a second signal arrives after close", async () => {
    // The `settled` guard. The previous version of this test asserted only
    // `expect(lateKill).toBe(0)`, which passes identically against an
    // implementation with NO guard at all — nothing ever calls `kill()` after a
    // successful `close`, so it was asserting the absence of something that was
    // already absent.
    //
    // So the second signal is actually DELIVERED here: `close` first, then
    // `error`, which is a real ordering (a notifier killed by our own timeout
    // can emit both). Without the guard the second signal runs a second
    // `finish()`: it calls `clearTimeout` a second time on an already-cleared
    // handle, which is exactly what the `outstanding` counter measures. The
    // counters below are therefore the assertion.
    let killCalls = 0
    const manager = new NotificationManager(true, {
      spawnImpl: () => {
        const proc = new EventEmitter() as EventEmitter & {
          kill: () => void
          killed: boolean
          stderr: null
        }
        proc.kill = () => {
          killCalls += 1
        }
        proc.killed = false
        proc.stderr = null
        queueMicrotask(() => {
          proc.emit("close", 0)
          proc.emit("error", new Error("late EPIPE after close"))
        })
        return proc as never
      }
    })

    expect(await manager.notify({ title: "T", body: "B" })).toBe(true)

    // One `finish` means one resolve and ONE `clearTimeout`. Two finishes leave
    // this at -1, because the shim above decrements unconditionally.
    expect(outstanding).toBe(0)
    // ...and the outcome was neither overwritten nor counted twice.
    expect(manager.getStats().sent).toBe(1)
    expect(manager.getStats().failed).toBe(0)
    expect(manager.getStats().lastError).toBeNull()
    // Nothing armed the timer, so nothing can have killed the process.
    expect(killCalls).toBe(0)
    await new Promise(resolve => realSetTimeout(resolve, 20))
    expect(killCalls).toBe(0)
  })

  it("resolves false and clears the timer when the notifier hangs", async () => {
    // The name of this test used to promise two things it asserted neither of:
    // it only checked that the promise was still pending at 250 ms with a timer
    // armed — a statement about the FIRST 250 ms, not about the timeout.
    // `timeoutMs` is the seam that makes the real thing testable without a
    // 3-second wait, so it now asserts the resolution it names.
    const manager = new NotificationManager(true, {
      spawnImpl: fakeSpawn(() => {}),
      timeoutMs: 60
    })
    const previous = console.error
    console.error = mock(() => {})
    try {
      const pending = manager.notify({ title: "T", body: "B" })

      // Before the timeout: still pending, with the timer armed.
      const settled = await Promise.race([
        pending,
        new Promise<boolean>(resolve => realSetTimeout(() => resolve(true), 10))
      ])
      expect(settled).toBe(true)
      expect(outstanding).toBe(1)

      // On the timeout: resolves FALSE, says so, and leaves no timer behind.
      expect(await pending).toBe(false)
      expect(outstanding).toBe(0)
      const stats = manager.getStats()
      expect(stats.sent).toBe(0)
      expect(stats.failed).toBe(1)
      expect(stats.lastError).toContain("timed out after 60ms")
    } finally {
      console.error = previous
    }
  })

  it("kills the hung notifier when the timeout fires", async () => {
    // The reason the timeout exists at all: a wedged process is terminated
    // rather than left running.
    let killed = false
    const manager = new NotificationManager(true, {
      spawnImpl: () => {
        const proc = new EventEmitter() as EventEmitter & {
          kill: () => void
          killed: boolean
          stderr: null
        }
        proc.kill = () => {
          killed = true
          proc.killed = true
        }
        proc.killed = false
        proc.stderr = null
        return proc as never
      },
      timeoutMs: 40
    })
    const previous = console.error
    console.error = mock(() => {})
    try {
      expect(await manager.notify({ title: "T", body: "B" })).toBe(false)
      expect(killed).toBe(true)
    } finally {
      console.error = previous
    }
  })
})

