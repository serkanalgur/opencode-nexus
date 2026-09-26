import { spawn, type ChildProcess } from "node:child_process"

export interface NotificationOptions {
  title: string
  body: string
  sound?: boolean
  silent?: boolean
}

// ── Script constants ────────────────────────────────────────────────────────
//
// The rule this file is built around: user text NEVER enters a script or
// command string. It only ever arrives through a channel that carries DATA
// (an argv slot, or an environment variable) and is never parsed as CODE.
//
// The previous implementation interpolated `options.title` / `options.body`
// straight into `display notification "..."` and handed that to `osascript`.
// A body of
//
//     x" & (do shell script "touch /tmp/pwned") & "y
//
// closed the string literal and called `do shell script`, so a task name was
// arbitrary shell. That is reproduced in test/notifications.test.ts, which
// asserts on the generated argv rather than on whether a payload happened to
// fire. The constants are exported so a test can assert the generated script
// is BYTE-IDENTICAL to them, and additionally that it is identical across a
// benign and a hostile input — the property that actually matters.
//
// `silent` and `sound` are handled by CHOOSING between a fixed set of script
// constants, never by building one.

export const MACOS_SCRIPT_WITH_SOUND = [
  "on run argv",
  'display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"',
  "end run"
].join("\n")

export const MACOS_SCRIPT_SILENT = [
  "on run argv",
  "display notification (item 2 of argv) with title (item 1 of argv)",
  "end run"
].join("\n")

/**
 * Windows toast via the built-in `Windows.UI.Notifications` WinRT API.
 *
 * Two deliberate choices, both forced by documented `powershell.exe`
 * behaviour (about_PowerShell_exe):
 *
 * 1. NOT `New-BurntToastNotification`. That cmdlet ships in the third-party
 *    BurntToast module, which is not present on a stock Windows install, so
 *    the old path could never have worked. This uses the OS API instead.
 *
 * 2. User text arrives via environment variables, not `-Command` arguments.
 *    The docs state that when `-Command` takes a string, "all arguments
 *    following it are interpreted as part of the command to execute" — so
 *    `powershell -Command <script> <title> <body>` APPENDS the title and body
 *    to the code string, which is the same injection as the AppleScript one.
 *    A `param()` block does not fix that; the arguments are joined into the
 *    command before the block is ever bound. Environment values are not
 *    re-parsed as code, so `$env:NEXUS_NOTIFY_TITLE` is inert text.
 *
 * The title and body also go through `CreateTextNode()`, so they are XML
 * escaped by the API rather than by us.
 *
 * ⚠️ THIS PATH HAS NEVER BEEN EXECUTED. It is verified only by asserting on
 * the generated argv (see the "Windows" block in test/notifications.test.ts),
 * which pins the security property and nothing else. It has not been run on a
 * real Windows host, and the previous implementation — which was also never
 * executed and also looked entirely reasonable in source — is the reason that
 * distinction matters. Before trusting this function operationally, run
 * `nexus.notifications.test` on a real Windows machine and confirm a toast
 * appears.
 *
 * KNOWN FUNCTIONAL RISK, same caveat: `CreateToastNotifier('Nexus')` names an
 * arbitrary AUMID. For an UNPACKAGED app — which a terminal-launched plugin is
 * — that AUMID is not registered with the shell, and Windows requires a
 * registered AUMID (or a COM activator) to display a toast under an app
 * identity. The toast may therefore never appear. Mitigation, if that proves
 * to be the case: a WinRT toast cannot be shown at all, so the fallback has to
 * be a different mechanism entirely (a tray balloon, or a shortcut with a
 * registered AUMID) rather than a tweak to this script. The failure mode is at
 * least honest — a broken notifier exits non-zero and the reason is recorded in
 * `getStats()` — so this is a risk of a silent-looking no-op, NOT a risk of a
 * false "delivered" claim.
 */
export const WINDOWS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
  "$template = [Windows.UI.Notifications.ToastTemplateType]::ToastText02",
  "$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent($template)",
  "$texts = $xml.GetElementsByTagName('text')",
  "$texts.Item(0).AppendChild($xml.CreateTextNode($env:NEXUS_NOTIFY_TITLE)) | Out-Null",
  "$texts.Item(1).AppendChild($xml.CreateTextNode($env:NEXUS_NOTIFY_BODY)) | Out-Null",
  "$toast = New-Object Windows.UI.Notifications.ToastNotification $xml",
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Nexus').Show($toast)"
].join("\n")

/** Environment variable names carrying the user text on Windows. */
export const WINDOWS_NOTIFY_ENV = {
  title: "NEXUS_NOTIFY_TITLE",
  body: "NEXUS_NOTIFY_BODY"
} as const

/** How long a notifier may take before we give up on it. */
const NOTIFY_TIMEOUT_MS = 3000

/**
 * A fully-built notifier invocation.
 *
 * Exported (and pure) so tests can assert on the exact argv without spawning
 * anything. `args` never contains user text except as discrete elements.
 */
export interface NotificationInvocation {
  readonly command: string
  readonly args: readonly string[]
  readonly env?: Readonly<Record<string, string>>
}

function macScriptFor(options: NotificationOptions): string {
  // `silent` and `sound: false` both mean "no sound", so they collapse to the
  // same constant. Selecting between two constants — rather than appending a
  // suffix — is what keeps the script source immutable.
  return options.silent || options.sound === false
    ? MACOS_SCRIPT_SILENT
    : MACOS_SCRIPT_WITH_SOUND
}

/**
 * macOS: a constant `osascript` program that reads its own `argv`.
 *
 * The `--` is load-bearing and was verified on darwin, not assumed. Without
 * it, a title beginning with `-` is consumed by `osascript` as one of its own
 * options: a title of `-l` makes it fail with `no such component "B"` and the
 * wrong `argv`, which fails SILENTLY and looks exactly like the bug this
 * replaces. `osascript` also does not document `--`, but it is consumed as an
 * option terminator and never reaches `argv`.
 */
export function buildMacOSInvocation(options: NotificationOptions): NotificationInvocation {
  return {
    command: "osascript",
    args: ["-e", macScriptFor(options), "--", options.title, options.body]
  }
}

/** Linux: `notify-send` already takes argv, so no quoting is involved. */
export function buildLinuxInvocation(options: NotificationOptions): NotificationInvocation {
  return {
    command: "notify-send",
    args: [options.title, options.body]
  }
}

/**
 * Windows: constant command string, user text in the environment.
 *
 * ⚠️ NEVER EXECUTED. See the long note on `WINDOWS_SCRIPT` above — this
 * function's output is asserted on but has never been spawned on Windows, and
 * it carries a real AUMID risk. Read that note before trusting it.
 */
export function buildWindowsInvocation(options: NotificationOptions): NotificationInvocation {
  return {
    command: "powershell",
    args: ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SCRIPT],
    env: {
      ...process.env,
      [WINDOWS_NOTIFY_ENV.title]: options.title,
      [WINDOWS_NOTIFY_ENV.body]: options.body
    }
  }
}

/**
 * Build the invocation for a platform, or `null` where we have no notifier.
 */
export function buildInvocation(
  platform: string,
  options: NotificationOptions
): NotificationInvocation | null {
  switch (platform) {
    case "darwin":
      return buildMacOSInvocation(options)
    case "linux":
      return buildLinuxInvocation(options)
    case "win32":
      return buildWindowsInvocation(options)
    default:
      return null
  }
}

export type SpawnFn = typeof spawn

export interface NotificationManagerOptions {
  /** Test seam. Defaults to `node:child_process.spawn`. */
  spawnImpl?: SpawnFn
  /**
   * Test seam for `NOTIFY_TIMEOUT_MS`. Defaults to the production 3 s.
   *
   * The timeout is a real behaviour — it is what stops a wedged notifier from
   * pinning the call open forever — and a seam is what makes it testable
   * without a test that waits 3 s to assert `false`.
   */
  timeoutMs?: number
}

interface ProcessOutcome {
  ok: boolean
  reason: string | null
}

/**
 * Run a notifier to completion, or fail after `NOTIFY_TIMEOUT_MS`.
 *
 * The timer is cleared on BOTH `close` and `error`. A notifier normally
 * returns in well under 3 s, so leaving the timer armed meant every single
 * notification left a live handle pending for the full 3 seconds — and the
 * `kill()` it was holding could later resolve an already-settled promise.
 * `settled` makes that second resolve impossible rather than merely unlikely.
 */
function runProcess(
  proc: ChildProcess,
  label: string,
  timeoutMs: number = NOTIFY_TIMEOUT_MS
): Promise<ProcessOutcome> {
  return new Promise<ProcessOutcome>((resolve) => {
    let settled = false
    let stderr = ""

    const finish = (outcome: ProcessOutcome): void => {
      if (settled) return
      settled = true
      // Unconditionally cleared, even when the outcome is `close`, so no
      // handle outlives the process it was watching.
      clearTimeout(timer)
      resolve(outcome)
    }

    const timer = setTimeout(() => {
      // Only kill if the process is still running; `close` already settled
      // and cleared us otherwise, but a manual `kill()` here on an
      // already-exited process would emit `error` under some platforms.
      if (!proc.killed) {
        try {
          proc.kill()
        } catch {
          // Nothing useful to do: we are already reporting a timeout.
        }
      }
      finish({ ok: false, reason: `${label} timed out after ${timeoutMs}ms` })
    }, timeoutMs)

    // Best-effort diagnostic detail. Never resolved from, never thrown at.
    proc.stderr?.on("data", (chunk: Buffer | string) => {
      if (stderr.length < 500) stderr += String(chunk)
    })

    proc.on("error", (error: Error) => {
      finish({ ok: false, reason: `${label} could not start: ${error.message}` })
    })

    proc.on("close", (code: number | null) => {
      if (code === 0) {
        finish({ ok: true, reason: null })
        return
      }
      const detail = stderr.trim()
      finish({
        ok: false,
        reason: `${label} exited with code ${code}${detail ? `: ${detail}` : ""}`
      })
    })
  })
}

export interface NotificationStats {
  /** Notifications the OS accepted. */
  sent: number
  /** Notifications that were attempted and did not land. */
  failed: number
  /** Calls short-circuited because notifications are switched off. */
  suppressed: number
  /** Reason for the most recent failure, or `null`. */
  lastError: string | null
  /** ISO timestamp of the most recent failure, or `null`. */
  lastErrorAt: string | null
  enabled: boolean
  platform: string
}

export class NotificationManager {
  private enabled: boolean
  private platform: string
  private readonly spawnImpl: SpawnFn
  private readonly timeoutMs: number
  private sent = 0
  private failed = 0
  private suppressed = 0
  private lastError: string | null = null
  private lastErrorAt: string | null = null

  constructor(enabled: boolean = true, options: NotificationManagerOptions = {}) {
    this.enabled = enabled
    this.platform = process.platform
    this.spawnImpl = options.spawnImpl ?? spawn
    this.timeoutMs = options.timeoutMs ?? NOTIFY_TIMEOUT_MS
  }

  /**
   * Send an OS notification.
   *
   * Never throws. A notification is a courtesy to the user, and a notifier
   * that is broken, missing, or being handed hostile text must not be able to
   * fail a task, a DAG node, or the broadcaster. So failures are non-fatal —
   * but they are no longer SILENT either: each one is logged and counted, and
   * `getStats()` reports the totals, which is what makes "I never see
   * notifications" answerable.
   */
  async notify(options: NotificationOptions): Promise<boolean> {
    if (!this.enabled) {
      this.suppressed += 1
      return false
    }

    const outcome = await this.attempt(options)
    if (outcome.ok) {
      this.sent += 1
      return true
    }
    this.failed += 1
    this.lastError = outcome.reason
    this.lastErrorAt = new Date().toISOString()
    console.error(`[nexus] notification failed: ${outcome.reason}`)
    return false
  }

  /**
   * Send a probe notification and report whether the OS notifier ACCEPTED it.
   *
   * "Accepted", specifically — that is the honest ceiling here and the
   * difference from the old wording matters, because "does it work for me?" is
   * the question this whole feature exists to answer. `delivered` is the
   * notifier's exit code, and the OS notifier reports acceptance, not
   * perception: on macOS `osascript` exits 0 when Notification Center has this
   * app muted, when Focus/Dnd is on, and when title and body are both empty
   * (all three verified on darwin); on Windows `Show()` returning without
   * throwing means the toast was SUBMITTED to the shell, not that a toast was
   * drawn. So `delivered: true` means "the OS took it", and a user who still
   * sees nothing is looking at a Focus/mute/permission problem, not at a
   * broken notifier. `stats` is the part that narrows it: a non-zero `failed`
   * with a reason is a real notifier failure, while `delivered: true` and
   * still nothing visible is a delivery-path setting.
   *
   * Unlike `notify()`, this always attempts delivery even when notifications
   * are disabled, because "are notifications working?" and "are they switched
   * off?" are different questions and the caller needs to be told which one
   * they are looking at. A failure here is always reported with its reason
   * from the notifier itself, never a hardcoded success.
   */
  async test(): Promise<{
    delivered: boolean
    reason: string | null
    enabled: boolean
    platform: string
    stats: NotificationStats
  }> {
    if (this.platform !== "darwin" && this.platform !== "linux" && this.platform !== "win32") {
      return {
        delivered: false,
        reason: `no notifier for platform "${this.platform}"`,
        enabled: this.enabled,
        platform: this.platform,
        stats: this.getStats()
      }
    }

    const probe: NotificationOptions = {
      title: "Nexus: notifications on",
      body: "If you can read this, OS notifications are working.",
      sound: true
    }

    // Deliberately NOT counting this as traffic: it is a diagnostic, not a
    // task event, and inflating `failed` with probes would make the counters
    // lie about the run.
    const outcome = await this.attempt(probe)
    return {
      delivered: outcome.ok,
      reason: outcome.reason,
      enabled: this.enabled,
      platform: this.platform,
      stats: this.getStats()
    }
  }

  /**
   * One notifier invocation, and the single place that can report a failure
   * reason. Kept separate from `notify()` so the counters stay in one place
   * and so `test()` can probe without being counted as run traffic.
   */
  private async attempt(options: NotificationOptions): Promise<ProcessOutcome> {
    const invocation = buildInvocation(this.platform, options)
    if (invocation === null) {
      return { ok: false, reason: `no notifier for platform "${this.platform}"` }
    }

    let proc: ChildProcess
    try {
      proc = this.spawnImpl(invocation.command, [...invocation.args], {
        env: invocation.env ? { ...invocation.env } : process.env
      })
    } catch (error) {
      return {
        ok: false,
        reason: `${invocation.command} could not start: ${
          error instanceof Error ? error.message : String(error)
        }`
      }
    }

    return runProcess(proc, invocation.command, this.timeoutMs)
  }

  /**
   * Totals for `getStatus()`. The answer to "do notifications work for me?"
   * is `sent > 0 && failed === 0`, and it is not derivable from anything else
   * the orchestrator exposes.
   */
  getStats(): NotificationStats {
    return {
      sent: this.sent,
      failed: this.failed,
      suppressed: this.suppressed,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
      enabled: this.enabled,
      platform: this.platform
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
  }

  isEnabled(): boolean {
    return this.enabled
  }
}
