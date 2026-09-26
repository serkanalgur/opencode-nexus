import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import * as realOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Task } from '../src/types'

/**
 * Same HOME sandboxing rationale as `dag-fallback-respawn.test.ts`:
 * `configManager` reads `homedir()/.config/opencode/nexus.jsonc` and
 * `initialize` reads `location.directory`. Without this, a developer's own
 * `notifications` block would decide the outcome of these tests.
 */
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'nexus-notif-home-'))
mock.module('node:os', () => ({ ...realOs, default: realOs, homedir: () => SANDBOX_HOME }))

const { NexusOrchestrator } = await import('../src/orchestrator')
const { NexusConfigManager } = await import('../src/config')
const { NotificationManager, WINDOWS_NOTIFY_ENV } = await import('../src/notifications')
const { NOTIFICATIONS_TEST_DESCRIPTION, runNotificationsTest } = await import('../src/index')

const tempDirs: string[] = [SANDBOX_HOME]

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-notif-project-'))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  mock.module('node:os', () => realOs)
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

/** A project dir whose `nexus.jsonc` carries the given `notifications` block. */
function projectWithNotifications(notifications: unknown): string {
  const dir = makeTempDir()
  mkdirSync(join(dir, '.opencode'), { recursive: true })
  writeFileSync(
    join(dir, '.opencode', 'nexus.jsonc'),
    `// test\n{\n${notifications === null ? '' : `  "notifications": ${JSON.stringify(notifications)},\n`}  "budget": { "maxTotalCost": 10 }\n}\n`,
    'utf-8'
  )
  return dir
}

const mockCtx = (directory: string) => ({
  location: { directory },
  session: {
    create: mock(() => Promise.resolve({ id: 'ses_notif_1' })),
    switchAgent: mock(() => Promise.resolve()),
    switchModel: mock(() => Promise.resolve()),
    prompt: mock(() => Promise.resolve()),
    wait: mock(() => Promise.resolve()),
    context: mock(() => Promise.resolve([
      { type: 'assistant', content: [{ type: 'text', text: 'done' }] }
    ])),
    background: mock(() => Promise.resolve()),
    hook: mock(() => Promise.resolve())
  },
  storage: {
    set: mock(() => Promise.resolve()),
    get: mock(() => Promise.resolve(null))
  }
})

type Ctx = ReturnType<typeof mockCtx>

/** Config that fails fast, so a DAG node reaches its notification quickly. */
function newOrchestrator(overrides?: Record<string, unknown>) {
  return new NexusOrchestrator({
    schedulerInterval: 1,
    selfHealing: { enabled: false, maxRetries: 0, retryDelay: 0, backoffMultiplier: 2, contextTransfer: false },
    budget: { maxTotalCost: 10.0, maxCostPerTask: 1.0, maxCostPerAgent: 2.0, alertThreshold: 0.2, hardLimit: false },
    ...overrides
  } as never)
}

async function initialized(directory: string, overrides?: Record<string, unknown>) {
  const orchestrator = newOrchestrator(overrides)
  await orchestrator.initialize(mockCtx(directory) as never)
  return orchestrator
}

function makeTask(id: string, name: string): Task {
  return {
    id,
    name,
    description: `Description for ${id}`,
    requiredRole: 'coder',
    complexity: {
      overall: 50,
      factors: { fileCount: 1, codeLines: 50, dependencyDepth: 0, domainKnowledge: 0, riskLevel: 'low' }
    },
    dependencies: [],
    files: { include: ['a.ts'] },
    priority: 'normal',
    status: 'pending'
  }
}

/**
 * The literal user symptom: a task name containing a double quote. Under the
 * old interpolating implementation this produced an AppleScript syntax error
 * that was swallowed, so the user simply never saw a notification.
 */
const QUOTED_TASK_NAME = 'Fix the "quoted" parser in `foo.ts` & do shell script "x"'

/**
 * One recorded spawn boundary, kept as raw data so the assertions below can be
 * written WITHOUT indexing into argv.
 */
interface RecordedInvocation {
  command: string
  args: readonly string[]
  /**
   * The two Windows text channels, and only those. `attempt()` hands the
   * notifier all of `process.env`, and reading the whole environment into an
   * assertion surface would make the searches below meaningless — and, on
   * Linux, would silently search a copy of the real environment for strings
   * that have nothing to do with the notification.
   */
  notifyText: readonly string[]
}

/**
 * Every channel user text can reach on ANY platform, in one flat list.
 *
 * This is what makes the assertions below index-free. `NotificationManager`
 * reads `process.platform` at construction, so the argv shape is genuinely
 * different per platform — 5 elements on darwin, 2 on linux, and on win32 the
 * text is not in argv AT ALL, it is in the environment. An assertion like
 * `args[4]` therefore does not merely fail on two of the three platforms, it
 * fails VACUOUSLY: `expect(flat).not.toContain(title)` where `args[4]` is
 * `undefined` passes no matter what, so "does not notify for the limit" was a
 * no-op on `ubuntu-latest`, which is where CI actually runs.
 */
function textChannels(invocation: RecordedInvocation): string[] {
  return [...invocation.args, ...invocation.notifyText]
}

/**
 * Did the notifier receive a message with this title?
 *
 * Searches the WHOLE text surface rather than a fixed index, so one predicate
 * is correct on darwin, linux and win32 — and so a negative answer is a real
 * negative. The positive cases in this file are what keep the negative ones
 * honest: the very same predicate finds 'Nexus: Budget Alert' one test away.
 */
function sawTitle(invocations: readonly RecordedInvocation[], title: string): boolean {
  return invocations.some((invocation) =>
    textChannels(invocation).some((channel) => channel.includes(title))
  )
}

/** The notifier binary each platform uses, so the command name is still pinned. */
const EXPECTED_COMMAND: Readonly<Record<string, string>> = {
  darwin: 'osascript',
  linux: 'notify-send',
  win32: 'powershell'
}

/**
 * Replace the orchestrator's notifier with one that records invocations at the
 * spawn boundary, so these tests assert on what WOULD have been spawned
 * without spawning `osascript` and without a display server.
 */
function recordingNotifications() {
  const invocations: RecordedInvocation[] = []
  const manager = new NotificationManager(true, {
    spawnImpl: ((command: string, args: readonly string[], options?: { env?: Record<string, string | undefined> }) => {
      const env = options?.env ?? {}
      invocations.push({
        command,
        args: [...args],
        notifyText: [env[WINDOWS_NOTIFY_ENV.title], env[WINDOWS_NOTIFY_ENV.body]].filter(
          (value): value is string => typeof value === 'string'
        )
      })
      const proc = new EventEmitter() as EventEmitter & {
        kill: () => void
        killed: boolean
        stderr: null
      }
      proc.kill = () => {}
      proc.killed = false
      proc.stderr = null
      queueMicrotask(() => proc.emit('close', 0))
      return proc as never
    }) as never
  })
  return { manager, invocations }
}

/** Notifications are fired without being awaited, so let the microtasks drain. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 25))
}

describe('notifications: a task name with a quote still notifies', () => {
  it('delivers a completion notification for a quoted task name', async () => {
    const orchestrator = await initialized(makeTempDir())
    const { manager, invocations } = recordingNotifications()
    orchestrator.notifications = manager

    await orchestrator.execute({ tasks: [makeTask('t1', QUOTED_TASK_NAME)] })
    await settle()

    // The old code produced `display notification ""Fix the "quoted"...""`,
    // which is an AppleScript syntax error, swallowed by a bare catch, and
    // the user saw nothing. Now the task name survives whole, in a channel
    // that carries data.
    expect(invocations.length).toBeGreaterThan(0)
    const invocation = invocations[0] as RecordedInvocation
    expect(invocation.command).toBe(EXPECTED_COMMAND[process.platform])

    // Index-free, and therefore true on all three platforms: the user text is
    // carried in exactly ONE channel. It is not duplicated into a command
    // string, and it is not split across channels by its own quotes.
    const carriers = textChannels(invocation).filter((channel) => channel.includes(QUOTED_TASK_NAME))
    expect(carriers).toHaveLength(1)
    expect(manager.getStats().failed).toBe(0)
  })

  it('keeps the whole task name in ONE text channel, unsplit by its quotes', async () => {
    const orchestrator = await initialized(makeTempDir())
    const { manager, invocations } = recordingNotifications()
    orchestrator.notifications = manager

    await orchestrator.execute({ tasks: [makeTask('t1', QUOTED_TASK_NAME)] })
    await settle()

    const invocation = invocations[0] as RecordedInvocation
    const carriers = textChannels(invocation).filter((channel) => channel.includes(QUOTED_TASK_NAME))
    expect(carriers).toHaveLength(1)
    // The name is a substring of the body, not the whole body: the name and the
    // outcome share one channel, and the quotes never split it.
    expect(carriers[0]).toContain('completed successfully')
    expect(carriers[0]).toContain(`& do shell script "x"`)
  })
})

describe('notifications: budget:exceeded now notifies', () => {
  /**
   * `checkBudget` is reached from `trackCost`, which is public and takes
   * REQUIRED provenance — so this drives the real accounting path rather than
   * reaching into a private. A zero-cost mock session never charges anything,
   * so the budget has to be crossed deliberately.
   */
  function crossBudget(orchestrator: InstanceType<typeof NexusOrchestrator>): void {
    orchestrator.trackCost('agent_budget', 'openai/gpt-5-mini', 99, 1000, {
      usage: 'measured',
      pricing: 'model-costs'
    })
  }

  it('sends a notification when the hard limit trips, and still pauses', async () => {
    const dir = makeTempDir()
    const orchestrator = await initialized(dir, {
      budget: { maxTotalCost: 1, maxCostPerTask: 1, maxCostPerAgent: 2, alertThreshold: 0.2, hardLimit: true }
    })
    const { manager, invocations } = recordingNotifications()
    orchestrator.notifications = manager
    const events: string[] = []
    orchestrator.on('budget:exceeded', () => events.push('budget:exceeded'))

    crossBudget(orchestrator)
    await settle()

    expect(events).toContain('budget:exceeded')
    // The single most notification-worthy event in the product used to be
    // silent: it emitted an event and paused, and nothing told the user.
    expect(sawTitle(invocations, 'Nexus: Budget Limit Reached')).toBe(true)
    expect((orchestrator as unknown as { paused: boolean }).paused).toBe(true)
  })

  it('does not ALSO fire the low-budget alert when the hard limit trips', async () => {
    // The double-fire this pins down. When the limit trips, `remaining` is <= 0,
    // so `remainingPercent` is <= 0, which trivially satisfies
    // `remainingPercent <= alertThreshold` — so testing the alert first made
    // ONE overage emit BOTH notifications, the first reading
    // `Budget low: $-49.00 remaining (-4900.0%)`. The two are different
    // conditions, so this is not an `else`: the alert is skipped because the
    // terminal event has already latched, not because the conditions are equal.
    const orchestrator = await initialized(makeTempDir(), {
      budget: { maxTotalCost: 1, maxCostPerTask: 1, maxCostPerAgent: 2, alertThreshold: 0.2, hardLimit: true }
    })
    const { manager, invocations } = recordingNotifications()
    orchestrator.notifications = manager
    const events: string[] = []
    orchestrator.on('budget:alert', () => events.push('budget:alert'))
    orchestrator.on('budget:exceeded', () => events.push('budget:exceeded'))

    crossBudget(orchestrator)
    await settle()

    // The terminal event stands alone: one event, one notification.
    expect(events).toEqual(['budget:exceeded'])
    expect(invocations).toHaveLength(1)
    expect(sawTitle(invocations, 'Nexus: Budget Limit Reached')).toBe(true)
    expect(sawTitle(invocations, 'Nexus: Budget Alert')).toBe(false)
    // Belt and braces on the copy itself: no notification anywhere reports a
    // negative remaining balance.
    for (const invocation of invocations) {
      for (const channel of textChannels(invocation)) {
        expect(channel).not.toContain('-4900.0%')
      }
    }
  })

  it('does not re-notify on either budget event after the limit has latched', async () => {
    const orchestrator = await initialized(makeTempDir(), {
      budget: { maxTotalCost: 1, maxCostPerTask: 1, maxCostPerAgent: 2, alertThreshold: 0.2, hardLimit: true }
    })
    const { manager, invocations } = recordingNotifications()
    orchestrator.notifications = manager

    crossBudget(orchestrator)
    await settle()
    const afterFirst = invocations.length

    crossBudget(orchestrator)
    crossBudget(orchestrator)
    await settle()

    // `budgetExceeded` already guarded the limit against repeats; the alert had
    // no guard of its own (pre-existing), and inherits the same one by virtue of
    // being gated on it. One overage, one notification, however many times the
    // accounting runs.
    expect(invocations).toHaveLength(afterFirst)
  })

  it('does not notify for the limit when there is no hard limit', async () => {
    const orchestrator = await initialized(makeTempDir(), {
      budget: { maxTotalCost: 1, maxCostPerTask: 1, maxCostPerAgent: 2, alertThreshold: 0.2, hardLimit: false }
    })
    const { manager, invocations } = recordingNotifications()
    orchestrator.notifications = manager

    crossBudget(orchestrator)
    await settle()

    // The negative assertion that CI used to run vacuously. It is only
    // meaningful next to the positive below, which proves `sawTitle` can
    // actually find a title in this same recording on this same platform.
    expect(sawTitle(invocations, 'Nexus: Budget Limit Reached')).toBe(false)
    // ...but the pre-existing alert is untouched.
    expect(sawTitle(invocations, 'Nexus: Budget Alert')).toBe(true)
  })

  it('still sends the pre-existing budget:alert notification', async () => {
    const orchestrator = await initialized(makeTempDir(), {
      budget: { maxTotalCost: 1, maxCostPerTask: 1, maxCostPerAgent: 2, alertThreshold: 0.2, hardLimit: false }
    })
    const { manager, invocations } = recordingNotifications()
    orchestrator.notifications = manager

    crossBudget(orchestrator)
    await settle()

    expect(sawTitle(invocations, 'Nexus: Budget Alert')).toBe(true)
  })
})

describe('notifications: config block', () => {
  it('defaults to enabled', () => {
    expect(new NexusConfigManager().getConfig().notifications).toEqual({ enabled: true })
  })

  it('reads `notifications.enabled: false` from nexus.jsonc', async () => {
    const dir = projectWithNotifications({ enabled: false })
    const orchestrator = await initialized(dir)
    expect(orchestrator.configManager.getConfig().notifications.enabled).toBe(false)
    // The hardcoded `new NotificationManager(true)` is gone: the manager is
    // seeded from config, so this knob is no longer inert.
    expect(orchestrator.notifications?.isEnabled()).toBe(false)
  })

  it('honours `notifications.enabled: false` passed to the constructor', async () => {
    const orchestrator = await initialized(makeTempDir(), { notifications: { enabled: false } })
    expect(orchestrator.notifications?.isEnabled()).toBe(false)
  })

  it('a level setting only `enabled` does not blank out its siblings', () => {
    // The specific `dashboard` bug from 2.7.0: a spread would resolve the
    // whole block from the winning level and drop the fields it omitted.
    const dir = projectWithNotifications({ enabled: false })
    const manager = new NexusConfigManager()
    manager.loadFromPath(dir)
    expect(manager.getConfig().notifications).toEqual({ enabled: false })
  })

  it('a config file with no notifications block leaves the default alone', () => {
    const dir = projectWithNotifications(null)
    const manager = new NexusConfigManager()
    manager.loadFromPath(dir)
    expect(manager.getConfig().notifications).toEqual({ enabled: true })
  })

  it('survives a TUI model change without deleting the user setting', () => {
    // `saveProjectConfig` writes the RETURNED object as the whole file, so a
    // block omitted from `getSaveableConfig()` is a block deleted from disk
    // the first time a model is changed in the TUI.
    const dir = projectWithNotifications({ enabled: false })
    const manager = new NexusConfigManager()
    manager.loadFromPath(dir)
    const saveable = (manager as unknown as {
      getSaveableConfig: () => { notifications?: unknown; models?: unknown }
    }).getSaveableConfig()
    expect(saveable.notifications).toEqual({ enabled: false })
  })

  it('survives a notifier that rejects, rather than crashing the orchestrator', async () => {
    // The floating-promise safety argument. `sendNotification` discards the
    // promise, `notify` is `async`, and `engines.node >= 22` terminates the
    // process on an unhandled rejection by default — so a cosmetic feature
    // would be able to kill the orchestrator. `emit`'s per-handler isolation
    // does not help: these call sites are direct statements in the DAG and
    // budget paths.
    //
    // `notify()` swallows its own failures today, so this cannot happen yet.
    // That is exactly why it needs a test rather than a comment: the handler in
    // `sendNotification` is the thing that keeps a future regression from
    // becoming a process exit, and a test is what makes it stay.
    const orchestrator = await initialized(makeTempDir(), {
      budget: { maxTotalCost: 1, maxCostPerTask: 1, maxCostPerAgent: 2, alertThreshold: 0.2, hardLimit: true }
    })
    let rejects = 0
    const logged: string[] = []
    const previousError = console.error
    console.error = mock((...args: unknown[]) => { logged.push(String(args[0])) })
    try {
      orchestrator.notifications = {
        notify: () => { rejects += 1; return Promise.reject(new Error('notifier exploded')) },
        isEnabled: () => true,
        setEnabled: () => {},
        getStats: () => ({ sent: 0, failed: 0, suppressed: 0, lastError: null, lastErrorAt: null, enabled: true, platform: process.platform })
      } as never

      // The real budget path, hard limit on, so the notification is fired from a
      // direct statement in `checkBudget()` — not from inside an `emit` handler.
      orchestrator.trackCost('agent_budget', 'openai/gpt-5-mini', 99, 1000, {
        usage: 'measured',
        pricing: 'model-costs'
      })
      await settle()

      // The notifier was called, and its rejection was handled rather than
      // escaping: the budget path ran to completion (the limit latched and the
      // run paused) and the handler logged the failure.
      expect(rejects).toBe(1)
      expect((orchestrator as unknown as { paused: boolean }).paused).toBe(true)
      expect(logged.join('\n')).toContain('notification rejected')
      expect(logged.join('\n')).toContain('notifier exploded')
    } finally {
      console.error = previousError
    }
  })

  it('suppresses notifications when disabled, and counts the suppression', async () => {
    const dir = projectWithNotifications({ enabled: false })
    const orchestrator = await initialized(dir)
    const { manager, invocations } = recordingNotifications()
    manager.setEnabled(false)
    orchestrator.notifications = manager

    await orchestrator.execute({ tasks: [makeTask('t1', 'a task')] })
    await settle()

    expect(invocations.length).toBe(0)
    const stats = manager.getStats()
    expect(stats.suppressed).toBeGreaterThan(0)
    expect(stats.sent).toBe(0)
  })
})

describe('notifications: getStatus reports the counts', () => {
  it('includes the notification stats so "do they work for me?" is answerable', async () => {
    const orchestrator = await initialized(makeTempDir())
    const parsed = JSON.parse(orchestrator.getStatus()) as {
      notifications: { sent: number; failed: number; enabled: boolean; platform: string }
    }
    expect(parsed.notifications).toBeDefined()
    expect(parsed.notifications.enabled).toBe(true)
    expect(parsed.notifications.platform).toBe(process.platform)
    expect(typeof parsed.notifications.sent).toBe('number')
    expect(typeof parsed.notifications.failed).toBe('number')
  })

  it('surfaces a failure reason through getStatus', async () => {
    const orchestrator = await initialized(makeTempDir())
    const previous = console.error
    console.error = mock(() => {})
    try {
      orchestrator.notifications = new NotificationManager(true, {
        spawnImpl: (() => {
          const proc = new EventEmitter() as EventEmitter & { kill: () => void; killed: boolean; stderr: null }
          proc.kill = () => {}
          proc.killed = false
          proc.stderr = null
          queueMicrotask(() => proc.emit('close', 3))
          return proc as never
        }) as never
      })
      await orchestrator.notifications?.notify({ title: 'T', body: 'B' })
      const parsed = JSON.parse(orchestrator.getStatus()) as {
        notifications: { failed: number; lastError: string | null }
      }
      expect(parsed.notifications.failed).toBe(1)
      expect(parsed.notifications.lastError).toContain('exited with code 3')
    } finally {
      console.error = previous
    }
  })

  it('reports null before the manager exists, rather than throwing', () => {
    const orchestrator = newOrchestrator()
    const parsed = JSON.parse(orchestrator.getStatus()) as { notifications: unknown }
    expect(parsed.notifications).toBeNull()
  })
})

describe('nexus.notifications.test tool', () => {
  it('has a description that says it is for verifying setup', () => {
    expect(NOTIFICATIONS_TEST_DESCRIPTION).toMatch(/verify/i)
    expect(NOTIFICATIONS_TEST_DESCRIPTION).toMatch(/never seeing notifications/i)
  })

  it('reports the real boolean and reason rather than claiming success', async () => {
    const orchestrator = await initialized(makeTempDir())
    const previous = console.error
    console.error = mock(() => {})
    try {
      orchestrator.notifications = new NotificationManager(true, {
        spawnImpl: (() => {
          const proc = new EventEmitter() as EventEmitter & { kill: () => void; killed: boolean; stderr: null }
          proc.kill = () => {}
          proc.killed = false
          proc.stderr = null
          queueMicrotask(() => proc.emit('close', 1))
          return proc as never
        }) as never
      })
      const content = await runNotificationsTest(orchestrator)
      const result = JSON.parse(content) as { delivered: boolean; reason: string | null }
      expect(result.delivered).toBe(false)
      expect(result.reason).toContain('exited with code 1')
    } finally {
      console.error = previous
    }
  })

  it('reports success when the notifier accepts the notification', async () => {
    const orchestrator = await initialized(makeTempDir())
    const { manager } = recordingNotifications()
    orchestrator.notifications = manager
    const content = await runNotificationsTest(orchestrator)
    const result = JSON.parse(content) as { delivered: boolean; reason: string | null }
    expect(result.delivered).toBe(true)
    expect(result.reason).toBeNull()
  })

  it('says so when the manager is not initialised, instead of reporting a notifier failure', async () => {
    const orchestrator = newOrchestrator()
    const content = await runNotificationsTest(orchestrator)
    const result = JSON.parse(content) as { delivered: boolean; reason: string; stats: unknown }
    expect(result.delivered).toBe(false)
    expect(result.reason).toMatch(/not initialised/i)
    expect(result.stats).toBeNull()
  })
})
