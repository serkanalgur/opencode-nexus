import { describe, it, expect, mock, afterAll } from 'bun:test'
import * as realOs from 'node:os'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { blankNonCode, readDashboardHtml, readSourceFile, interfaceFieldNames } from './helpers/dashboard-page'

// `initialize()` loads the global config from `homedir()`, so it is sandboxed
// here for the same reason `test/task-cost.test.ts` sandboxes it: a suite that
// reads the developer's real `~/.config/opencode/nexus.jsonc` is a suite whose
// result depends on the machine. A REAL temp dir, not a home-relative path —
// CI runs on ubuntu and a home-relative fixture has shipped a test that passed
// on darwin and failed on both ubuntu legs.
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'nexus-knobs-'))
mock.module('node:os', () => ({ ...realOs, default: realOs, homedir: () => SANDBOX_HOME }))

const { NexusOrchestrator } = await import('../src/orchestrator')
const { NexusConfigManager, PRESETS, declaredConfigLeaves } = await import('../src/config')
const { TeamManager } = await import('../src/team')
type Orchestrator = InstanceType<typeof NexusOrchestrator>
type Manager = InstanceType<typeof NexusConfigManager>

afterAll(() => {
  mock.module('node:os', () => realOs)
})

const MEASURED = { usage: 'measured', pricing: 'model-costs' } as const

/**
 * A minimal ctx. Nothing here is stubbed at the layer under test: the gate runs
 * inside `trackCost`, which is the public method, and the notification is
 * observed on the real `notifications` field the orchestrator itself calls.
 */
function bareCtx() {
  return {
    location: { directory: SANDBOX_HOME },
    session: {
      create: mock(() => Promise.resolve({ id: 'ses_knobs' })),
      prompt: mock(() => Promise.resolve()),
      wait: mock(() => Promise.resolve()),
      context: mock(() => Promise.resolve([])),
    },
    storage: { get: mock(() => Promise.resolve(null)), set: mock(() => Promise.resolve()) },
    tool: { list: mock(() => Promise.resolve([])) },
  }
}

/**
 * An orchestrator with one registered task, and the notification spy in place.
 *
 * The task goes into `orchestrator.tasks` because that is where
 * `taskIdForAgent` looks — the attribution `checkTaskBudget` depends on. A
 * harness that skipped it would leave the gate unable to fire and the tests
 * below would prove nothing.
 */
async function withTask(
  taskId: string,
  budget: { maxCostPerTask: number },
  body: (o: Orchestrator, agentId: string, raised: Raised[]) => void | Promise<void>
): Promise<Raised[]> {
  const orchestrator = new NexusOrchestrator({ budget: { maxTotalCost: 100, alertThreshold: 0.2, hardLimit: false, ...budget } })
  await orchestrator.initialize(bareCtx() as never)

  const raised: Raised[] = []
  orchestrator.notifications = { notify: (o: Raised) => { raised.push(o); return Promise.resolve() } } as never

  orchestrator['tasks'].set(taskId, {
    id: taskId, name: taskId, description: 'd', requiredRole: 'coder',
    assignedAgent: 'agent-knobs', files: { include: [] },
    complexity: { score: 0.5 },
  } as never)

  await body(orchestrator, 'agent-knobs', raised)
  await orchestrator.shutdown()
  return raised
}

/** One notification as the orchestrator hands it to `NotificationManager`. */
type Raised = { title: string; body: string; sound?: boolean }

describe('maxCostPerTask is enforced, and reports rather than drops', () => {
  it('notifies once when a task crosses the ceiling, and says nothing halted it', async () => {
    const notifications = await withTask('task-1', { maxCostPerTask: 1.00 }, (o, agentId, raised) => {
      o.trackCost(agentId, 'p/m', 0.40, 1000, MEASURED)
      // UNDER the ceiling: nothing. A gate that fired here would be firing on
      // spend rather than on crossing, and the notification would be noise.
      expect(raised).toEqual([])
      o.trackCost(agentId, 'p/m', 0.40, 1000, MEASURED)
      expect(raised).toEqual([])
      // CROSSES it.
      o.trackCost(agentId, 'p/m', 0.40, 1000, MEASURED)
    })

    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.title).toBe('Nexus: Task Over Budget')
    // The task is NAMED. That is the whole value of a per-task ceiling over the
    // run total: "which task ran the bill up".
    expect(notifications[0]?.body).toContain('task-1')
    expect(notifications[0]?.body).toContain('$1.20')
    // And it says out loud that nothing was stopped, because it was not. A
    // notification reading "over its per-task budget" without that clause is
    // how this knob lied in the first place.
    expect(notifications[0]?.body).toContain('Not stopped')
    expect(notifications[0]?.sound).toBe(false)
  })

  it('latches per task: a task that keeps spending is reported once, and two tasks are named separately', async () => {
    // The run-total's latch is a single boolean describing one terminal event.
    // This one is a Set, because N expensive tasks are N facts and a user who
    // wants to know which ones needs all of them.
    const notifications = await withTask('task-1', { maxCostPerTask: 0.50 }, (o, agentId) => {
      o.trackCost(agentId, 'p/m', 0.60, 1000, MEASURED)
      o.trackCost(agentId, 'p/m', 0.60, 1000, MEASURED)
      o.trackCost(agentId, 'p/m', 0.60, 1000, MEASURED)
      // A SECOND task, over the same ceiling, is its own report.
      o['tasks'].set('task-2', {
        id: 'task-2', name: 'task-2', description: 'd', requiredRole: 'coder',
        assignedAgent: 'agent-two', files: { include: [] }, complexity: { score: 0.5 },
      } as never)
      o.trackCost('agent-two', 'p/m', 0.90, 1000, MEASURED)
    })

    expect(notifications).toHaveLength(2)
    // Distinct tasks, in the order they crossed.
    expect(notifications[0]?.body).toContain('task-1')
    expect(notifications[1]?.body).toContain('task-2')
    expect(notifications[1]?.body).not.toContain('task-1')
  })

  it('does not stop the run, drop the task, or un-charge the spend', async () => {
    // The brief's constraint: a new gate must report honestly rather than
    // silently dropping a task. So the assertions are about what did NOT
    // happen — the money is still charged, still attributed, the run is not
    // paused, and the terminal hard limit is untouched.
    const orchestrator = new NexusOrchestrator({
      budget: { maxTotalCost: 100, maxCostPerTask: 0.10, alertThreshold: 0.2, hardLimit: false },
    })
    await orchestrator.initialize(bareCtx() as never)
    orchestrator.notifications = { notify: () => Promise.resolve() } as never
    orchestrator['tasks'].set('task-1', {
      id: 'task-1', name: 't', description: 'd', requiredRole: 'coder',
      assignedAgent: 'a1', files: { include: [] }, complexity: { score: 0.5 },
    } as never)

    orchestrator.trackCost('a1', 'p/m', 5.00, 1000, MEASURED)

    // Every dollar is still counted, still in history, still attributed.
    expect(orchestrator.totalSpent).toBeCloseTo(5.00, 12)
    expect(orchestrator['costHistory']).toHaveLength(1)
    expect(orchestrator['costHistory'][0]?.cost).toBeCloseTo(5.00, 12)
    expect(orchestrator['costByAgent'].get('a1')).toBeCloseTo(5.00, 12)
    // Not paused, and the terminal latch is NOT set: crossing a per-task
    // advisory ceiling is not the same event as exhausting the run budget. With
    // `hardLimit: false` the run's own ceiling is advisory too, and a task going
    // 50x over its own ceiling must not trip the other one.
    expect(orchestrator['paused']).toBe(false)
    expect(orchestrator.isBudgetExceeded()).toBe(false)
    expect(orchestrator.totalSpent).toBeLessThan(orchestrator.budget.maxTotalCost)
    await orchestrator.shutdown()
  })

  it('treats a zero or negative ceiling as "no per-task ceiling", not as "notify about everything"', async () => {
    // Otherwise a user who zeroed it out to silence a notification would instead
    // get one for every task, which is the opposite of what they asked for.
    for (const limit of [0, -1, Number.NaN]) {
      const notifications = await withTask('task-1', { maxCostPerTask: limit }, (o, agentId) => {
        o.trackCost(agentId, 'p/m', 9.99, 1000, MEASURED)
      })
      expect({ limit, notifications }).toEqual({ limit, notifications: [] })
    }
  })

  it('counts a charge that belongs to no task against no ceiling, and says nothing', async () => {
    // A charge whose agent is on no task is unattributable, and inventing an
    // attribution for it would be a guess in an accounting path.
    const notifications = await withTask('task-1', { maxCostPerTask: 0.01 }, (o) => {
      o.trackCost('an-agent-on-no-task', 'p/m', 50, 1000, MEASURED)
    })
    expect(notifications).toEqual([])
  })

  it('accumulates across a task\'s attempts rather than resetting per charge', async () => {
    // The escalation chain is what turns one runaway task into three bills, so a
    // per-task ceiling that reset on every charge would never fire on exactly
    // the case it exists for. Two charges, each under, sum over.
    const notifications = await withTask('task-1', { maxCostPerTask: 1.00 }, (o, agentId) => {
      o.trackCost(agentId, 'p/m', 0.60, 1000, MEASURED)
      o.trackCost(agentId, 'p/m', 0.60, 1000, MEASURED)
    })
    expect(notifications).toHaveLength(1)
  })
})

describe('the deleted keys are gone, and stay gone', () => {
  it('has no maxCostPerAgent on BudgetConstraint, and no other config block has grown one', async () => {
    const types = await readSourceFile('types')
    // The interface list is the authority, and it is read out of the source
    // rather than restated: a hand-typed expectation for a source-parsing test
    // is a test that can agree with a lie.
    expect(interfaceFieldNames(types, 'BudgetConstraint'))
      .toEqual(['maxTotalCost', 'maxCostPerTask', 'alertThreshold', 'hardLimit'])
  })

  it('keeps the deleted keys out of both config types, by name', async () => {
    // Scoped to the two interfaces rather than grepped file-wide, and the reason
    // is `RetryPolicy`: `src/types.ts` still declares a `backoffMultiplier` on
    // THAT interface, where it is a different field with a different owner, and a
    // file-wide grep would have to be weakened until it proved nothing. Reading
    // the field names out of the source is also stronger than a grep — it cannot
    // be satisfied by the key appearing in a comment.
    const types = await readSourceFile('types')
    const config = await readSourceFile('config')

    const nexusConfig = interfaceFieldNames(types, 'NexusConfig')
    for (const key of ['communication', 'security']) {
      expect({ key, inNexusConfig: nexusConfig.includes(key) }).toEqual({ key, inNexusConfig: false })
    }
    // And the two INLINE sub-blocks, which a flat field-name read cannot reach.
    // The body is sliced out of the source and scanned, rather than the file
    // being grepped: `RetryPolicy.backoffMultiplier` is a legitimate survivor
    // elsewhere in `types.ts`, so a file-wide check would have to be weakened
    // until it proved nothing.
    const body = interfaceBody(stripComments(types), 'NexusConfig')
    expect(body).toContain('retryDelay: number')
    expect(body).not.toContain('backoffMultiplier')
    expect(body).toContain('healthCheckInterval: number')
    expect(body).not.toContain('defaultRole')
    expect(body).not.toContain('spawnDelay')

    // `NexusFullConfig` is the FILE shape — the one users actually type. Its
    // `selfHealing` must be the same four fields the runtime block has, which is
    // the mismatch this change exists to close: it used to have three while
    // `NexusConfig` had five, and the field they disagreed about was the one
    // that was load-bearing.
    const fullBody = interfaceBody(stripComments(config), 'NexusFullConfig')
    expect(fullBody).toContain('retryDelay: number')
    expect(fullBody).toContain('maxCostPerTask: number')
    expect(fullBody).not.toContain('maxCostPerAgent')
  })

  it('writes no deleted key into the orchestrator defaults or the config panel', async () => {
    // The second half of the original defect: the keys were not only on the
    // type, they were in the defaults literal that populates it and in the page
    // that displays it. Comments are blanked first because most of these keys
    // are now NAMED in the comments explaining their removal, and a check that
    // cannot tell an explanation from a use has to be weakened into nothing.
    const global = ['maxCostPerAgent', 'sastEnabled', 'secretsScanning', 'scopeEnforcement', 'spawnDelay', 'defaultRole', 'maxQueueSize', 'messageTTL']
    for (const name of ['orchestrator', 'config', 'index']) {
      const code = stripComments(await readSourceFile(name))
      for (const key of global) {
        expect({ file: name, key, present: new RegExp(`\\b${key}\\b`).test(code) })
          .toEqual({ file: name, key, present: false })
      }
    }
    // `backoffMultiplier` is checked on the page but NOT on `types`, for the
    // `RetryPolicy` reason given above.
    const pageCode = stripComments(await readDashboardHtml())
    for (const key of [...global, 'backoffMultiplier']) {
      expect({ key, presentInPage: new RegExp(`\\b${key}\\b`).test(pageCode) })
        .toEqual({ key, presentInPage: false })
    }
  })

  it('carries no communication or security block in the merged config', () => {
    // A `NexusConfig` literal cannot carry them any more (the type says so), so
    // this asserts the RUNTIME shape: that nothing quietly reintroduces them
    // downstream, and that the blocks a user could once pass have no effect.
    const merged = new NexusOrchestrator()['config']
    expect(Object.keys(merged).sort()).toEqual([
      'agents', 'budget', 'dashboard', 'defaultTimeout', 'gitFlow',
      'learning', 'maxConcurrency', 'notifications', 'schedulerInterval', 'selfHealing',
    ])
    expect('communication' in merged).toBe(false)
    expect('security' in merged).toBe(false)
  })

  it('leaves healthCheckInterval in place, and takes the two dead agent fields with it', () => {
    // The negative assertion is only meaningful beside the positive one: a
    // block emptied wholesale would satisfy "no spawnDelay" too.
    const merged = new NexusOrchestrator()['config']
    expect(merged.agents).toEqual({ healthCheckInterval: 30000 })
  })

  it('keeps the selfHealing block at four fields, all of them read', () => {
    // The shape mismatch this change exists to close: `NexusConfig` had five,
    // `NexusFullConfig` three, and the one they disagreed about (`retryDelay`)
    // was the one that was actually load-bearing.
    const merged = new NexusOrchestrator()['config']
    expect(Object.keys(merged.selfHealing).sort())
      .toEqual(['contextTransfer', 'enabled', 'maxRetries', 'retryDelay'])
  })
})

describe('retryDelay is file-settable, and round-trips', () => {
  it('reads retryDelay out of nexus.jsonc, which it could not before', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-retry-'))
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'nexus.jsonc'), JSON.stringify({
      selfHealing: { enabled: true, maxRetries: 2, retryDelay: 4321, contextTransfer: false },
    }))

    const manager = new NexusConfigManager(
      { enabled: false, port: 4747, host: '127.0.0.1' },
      { enabled: false }, [], undefined,
    )
    await manager.loadFromPath(dir)
    expect(manager.getConfig().selfHealing.retryDelay).toBe(4321)
  })

  it('writes every remaining block back, so a TUI model save cannot delete one', async () => {
    // `saveProjectConfig` writes `getSaveableConfig()`'s return value as the
    // WHOLE file body, so a block missing here is a block erased from the
    // user's file. Asserted by round-tripping through a real file rather than
    // by reading the private method: the method is the thing under test and the
    // file is what it damages.
    const dir = mkdtempSync(join(tmpdir(), 'nexus-save-'))
    const manager = new NexusConfigManager(
      { enabled: true, port: 1234, host: '0.0.0.0' },
      { enabled: false }, [{ name: 'auditor', prompt: 'audit' }], undefined,
    )
    manager.saveProjectConfig(dir)

    // `saveProjectConfig` writes a two-line `//` header above the JSON, so the
    // file is JSONC and `JSON.parse` alone will not read it back. That is the
    // format the user's editor sees too.
    const raw = readFileSync(join(dir, '.opencode', 'nexus.jsonc'), 'utf-8')
    expect(raw.startsWith('// Nexus Configuration')).toBe(true)
    const written = JSON.parse(raw.replace(/^\/\/[^\n]*\n/gm, '')) as Record<string, unknown>
    // Every block `NexusFullConfig` models, and nothing invented. The names are
    // compared as SETS against the type's own keys read from the source, so
    // adding a block to the type without adding it here fails this test.
    //
    // `effort` is in this list because this test is the mechanism that put it
    // there: the block was added to `getSaveableConfig()` and this assertion
    // failed until the list named it, which is the whole reason the list is
    // written out in full instead of being derived.
    expect(Object.keys(written).sort()).toEqual([
      'budget', 'customRoles', 'dashboard', 'effort', 'gitFlow', 'models', 'notifications', 'selfHealing',
    ])

    // The custom role survived, and so did the settings a user would be most
    // annoyed to lose silently.
    expect(written.customRoles).toEqual([{ name: 'auditor', prompt: 'audit' }])
    expect(written.dashboard).toMatchObject({ port: 1234, host: '0.0.0.0', enabled: true })
    expect(written.notifications).toEqual({ enabled: false })

    // And `retryDelay` — the field whose file-settability is new — is present, so
    // a configured backoff base survives the save rather than resetting to 1000.
    expect((written.selfHealing as Record<string, unknown>).retryDelay).toBe(1000)
  })

  it('preserves a configured retryDelay through a session override that sets other fields', async () => {
    // `updateStorageConfig` REPLACES the storage block with a literal, so a
    // partial update that omitted `retryDelay` would have written a block with
    // no `retryDelay` in it and the merge would fall through to the DEFAULT
    // rather than to the project file. Driven through the public method.
    const dir = mkdtempSync(join(tmpdir(), 'nexus-stor-'))
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'nexus.jsonc'), JSON.stringify({
      selfHealing: { enabled: true, maxRetries: 2, retryDelay: 7777, contextTransfer: true },
    }))

    const manager = new NexusConfigManager(
      { enabled: false, port: 4747, host: '127.0.0.1' }, { enabled: false }, [], undefined,
    )
    await manager.loadFromPath(dir)
    manager.updateStorageConfig({ models: {} })
    expect(manager.getConfig().selfHealing.retryDelay).toBe(7777)
  })
})

describe('a file-set knob reaches the ORCHESTRATOR, not just the config manager', () => {
  /**
   * The layer that matters is the orchestrator's, because that is where the
   * knob is USED. Every assertion above this block reads
   * `configManager.getConfig()`, which is the layer that was already correct
   * when `retryDelay` was inert: the file parsed, round-tripped, displayed, and
   * the backoff still ran 1s/2s/4s. So these tests assert the field the RETRY
   * path and the BUDGET GATE actually read.
   *
   * `escalationPolicy.retryDelay` rather than a timed first retry: it is the
   * same field the backoff multiplies, so a wrong value here is a wrong value
   * there, and it costs no wall-clock. A timing test would additionally be
   * unrunnable under the load this suite is being developed against, which is
   * how a 4321 ms wait turns into a flake that gets "fixed" by raising a
   * timeout.
   */
  it('a file retryDelay reaches escalationPolicy, the base the backoff multiplies', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-eff-'))
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'nexus.jsonc'), JSON.stringify({
      selfHealing: { enabled: true, maxRetries: 2, retryDelay: 4321, contextTransfer: false },
    }))

    const orchestrator = new NexusOrchestrator()
    await orchestrator.initialize({ ...bareCtx(), location: { directory: dir } } as never)

    // The defect: this read the CONSTRUCTOR's value, and the constructor is
    // called with no argument at all by `src/index.ts`, so it was always 1000.
    expect(orchestrator['escalationPolicy'].retryDelay).toBe(4321)
    // `maxRetries` from the same block, to show the whole block moved and not
    // one key that happened to be mentioned in a comment.
    expect(orchestrator['escalationPolicy'].maxRetries).toBe(2)
    await orchestrator.shutdown()
  })

  it('a file retryDelay reaches escalationPolicy after a RELOAD, not only at boot', async () => {
    // The other half of the same defect: a user editing the file mid-session
    // must not need a restart. `reloadConfigFromDisk` refreshed the manager and
    // nothing else, so the file value appeared in `/nexus config` while the
    // retry ran the old base.
    const dir = mkdtempSync(join(tmpdir(), 'nexus-eff2-'))
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'nexus.jsonc'), JSON.stringify({
      selfHealing: { enabled: true, maxRetries: 2, retryDelay: 1000, contextTransfer: false },
    }))

    const orchestrator = new NexusOrchestrator()
    await orchestrator.initialize({ ...bareCtx(), location: { directory: dir } } as never)
    expect(orchestrator['escalationPolicy'].retryDelay).toBe(1000)

    writeFileSync(join(dir, '.opencode', 'nexus.jsonc'), JSON.stringify({
      selfHealing: { enabled: true, maxRetries: 4, retryDelay: 4321, contextTransfer: true },
    }))
    orchestrator.reloadConfigFromDisk()
    expect(orchestrator['escalationPolicy'].retryDelay).toBe(4321)
    expect(orchestrator['escalationPolicy'].maxRetries).toBe(4)
    expect(orchestrator['escalationPolicy'].enableRespawn).toBe(true)
    await orchestrator.shutdown()
  })

  it('a file budget reaches orchestrator.budget, which is what the panel and dashboard SHOW', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-bud-'))
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'nexus.jsonc'), JSON.stringify({
      budget: { maxTotalCost: 999, maxCostPerTask: 0.01, alertThreshold: 0.9 },
    }))

    const orchestrator = new NexusOrchestrator()
    await orchestrator.initialize({ ...bareCtx(), location: { directory: dir } } as never)

    // These three read `this.budget`, which is the value `getState()` puts in
    // the payload at `budget: this.budget` and the value the config panel
    // renders. Asserting the field IS asserting what is displayed: there is one
    // field, and every surface reads it. Asserting `getState()` as well would
    // be the same fact twice.
    expect(orchestrator.budget.maxTotalCost).toBe(999)
    expect(orchestrator.budget.maxCostPerTask).toBe(0.01)
    expect(orchestrator.budget.alertThreshold).toBe(0.9)
    await orchestrator.shutdown()
  })

  it('a file maxCostPerTask is the one the GATE fires on, not a display-only value', async () => {
    // The gate and the display must not be able to disagree. If this passes
    // while the notification threshold is a default, the defect is only
    // relocated, not fixed.
    const dir = mkdtempSync(join(tmpdir(), 'nexus-bud2-'))
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'nexus.jsonc'), JSON.stringify({
      budget: { maxTotalCost: 100, maxCostPerTask: 0.25, alertThreshold: 0.2 },
    }))

    const orchestrator = new NexusOrchestrator()
    await orchestrator.initialize({ ...bareCtx(), location: { directory: dir } } as never)
    const raised: Raised[] = []
    orchestrator.notifications = { notify: (o: Raised) => { raised.push(o); return Promise.resolve() } } as never
    orchestrator['tasks'].set('task-1', {
      id: 'task-1', name: 't', description: 'd', requiredRole: 'coder',
      assignedAgent: 'a1', files: { include: [] }, complexity: { score: 0.5 },
    } as never)

    // UNDER the file's $0.25. A gate still reading the $1.00 default would stay
    // quiet here, which is exactly the "looks set and does nothing" symptom.
    orchestrator.trackCost('a1', 'p/m', 0.10, 1000, MEASURED)
    expect(raised).toEqual([])
    // Over it.
    orchestrator.trackCost('a1', 'p/m', 0.20, 1000, MEASURED)
    expect(raised).toHaveLength(1)
    expect(raised[0]?.title).toBe('Nexus: Task Over Budget')
    expect(raised[0]?.body).toContain('$0.30')
    await orchestrator.shutdown()
  })

  it('a programmatic constructor budget is not thrown away by a file that omits it', async () => {
    // The precedence the shipped product depends on in reverse. `src/index.ts`
    // constructs the orchestrator with no argument, so a file is the only
    // source of a budget there — but an EMBEDDER passes one, and a reload must
    // not silently replace it with a default. A file that sets only
    // `maxCostPerTask` must not reset a programmatic `maxTotalCost`.
    const dir = mkdtempSync(join(tmpdir(), 'nexus-bud3-'))
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'nexus.jsonc'), JSON.stringify({
      budget: { maxCostPerTask: 0.5 },
    }))

    const orchestrator = new NexusOrchestrator({
      budget: { maxTotalCost: 42, maxCostPerTask: 1, alertThreshold: 0.2, hardLimit: false },
    })
    await orchestrator.initialize({ ...bareCtx(), location: { directory: dir } } as never)

    // File wins for the key it sets…
    expect(orchestrator.budget.maxCostPerTask).toBe(0.5)
    // …and the constructor still owns the keys the file is silent about. Before
    // the fix both came back as defaults (10 / 0.2), which is how a programmatic
    // embedder's ceiling evaporated at the first `initialize()`.
    expect(orchestrator.budget.maxTotalCost).toBe(42)
    expect(orchestrator.budget.alertThreshold).toBe(0.2)
    await orchestrator.shutdown()
  })

  it('a programmatic selfHealing block survives initialize, so retryDelay is a real level', async () => {
    // The same precedence claim for the other block. Before `selfHealingBase`
    // there was no level between the files and `DEFAULT_CONFIG.selfHealing`, so
    // a constructor-supplied backoff base could not be expressed at all.
    const dir = mkdtempSync(join(tmpdir(), 'nexus-bud4-'))
    const orchestrator = new NexusOrchestrator({
      selfHealing: { enabled: true, maxRetries: 7, retryDelay: 250, contextTransfer: false },
    })
    await orchestrator.initialize({ ...bareCtx(), location: { directory: dir } } as never)

    expect(orchestrator['escalationPolicy'].retryDelay).toBe(250)
    expect(orchestrator['escalationPolicy'].maxRetries).toBe(7)
    expect(orchestrator['escalationPolicy'].enableRespawn).toBe(false)
    await orchestrator.shutdown()
  })

  it('a session override that sets only `models` does not pin the file budget to the base', async () => {
    // The budget analogue of the `retryDelay` bug this suite already covers for
    // `selfHealing`. `updateStorageConfig` REPLACES the blocks it names and
    // `getConfig()` merges storage LAST, so a literal that fell back to
    // `DEFAULT_CONFIG` would make the file's budget invisible for the rest of
    // the session after any models-only save — the panel's own save path.
    const dir = mkdtempSync(join(tmpdir(), 'nexus-bud5-'))
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'nexus.jsonc'), JSON.stringify({
      budget: { maxTotalCost: 777, maxCostPerTask: 0.75, alertThreshold: 0.5 },
    }))

    const manager = new NexusConfigManager(
      { enabled: false, port: 4747, host: '127.0.0.1' }, { enabled: false }, [], undefined,
    )
    await manager.loadFromPath(dir)
    manager.updateStorageConfig({ models: {} })

    // All three, not one: the literal is written field by field, so a partial
    // fix would pass a single-key assertion.
    expect(manager.getConfig().budget).toEqual({
      maxTotalCost: 777, maxCostPerTask: 0.75, alertThreshold: 0.5,
    })
  })

  it('a session override that sets only `models` does not pin the file retryDelay to the base', async () => {
    // The same shape as the test above, for the other block, kept because the
    // two literals are written independently and a fix to one is not a fix to
    // the other.
    const dir = mkdtempSync(join(tmpdir(), 'nexus-bud6-'))
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'nexus.jsonc'), JSON.stringify({
      selfHealing: { enabled: false, maxRetries: 9, retryDelay: 4321, contextTransfer: false },
    }))

    const manager = new NexusConfigManager(
      { enabled: false, port: 4747, host: '127.0.0.1' }, { enabled: false }, [], undefined,
    )
    await manager.loadFromPath(dir)
    manager.updateStorageConfig({ models: {} })

    expect(manager.getConfig().selfHealing).toEqual({
      enabled: false, maxRetries: 9, retryDelay: 4321, contextTransfer: false,
    })
  })
  it('never writes `hardLimit` into the file, even when a constructor seeded one', async () => {
    // `hardLimit` is a real enforcement switch and it is constructor-only. The
    // manager takes a `Partial<BudgetConstraint>` so an embedder can seed it, and
    // the one thing that must not happen is that seed reaching `getConfig()`:
    // `getSaveableConfig()` writes `{ ...current.budget }` as the user's WHOLE
    // `nexus.jsonc`, so a leaked key would be written into every file on the
    // next TUI save and read back as authoritative on the next load — turning a
    // constructor-only switch into a file-settable one by accident, which is the
    // exact "looks set and does nothing" inverse.
    const dir = mkdtempSync(join(tmpdir(), 'nexus-hard-'))
    const manager = new NexusConfigManager(
      { enabled: false, port: 4747, host: '127.0.0.1' }, { enabled: false }, [], undefined, undefined,
      { maxTotalCost: 5, maxCostPerTask: 0.5, alertThreshold: 0.3, hardLimit: true },
    )

    // Not in the merged config…
    expect(manager.getConfig().budget).toEqual({
      maxTotalCost: 5, maxCostPerTask: 0.5, alertThreshold: 0.3,
    })
    // …and not in the file. Asserted on the FILE rather than on the private
    // saveable-config method, because the file is what the method damages.
    manager.saveProjectConfig(dir)
    const raw = readFileSync(join(dir, '.opencode', 'nexus.jsonc'), 'utf-8')
    const written = JSON.parse(raw.replace(/^\/\/[^\n]*\n/gm, '')) as Record<string, unknown>
    expect(Object.keys(written.budget as object).sort())
      .toEqual(['alertThreshold', 'maxCostPerTask', 'maxTotalCost'])
    expect(raw).not.toContain('hardLimit')
  })

  it('reads an OLD-format file, drops the keys it no longer has, and SAYS SO', async () => {
    // End to end, because the three halves can each be right while the pair is
    // wrong. `getConfig()` builds these blocks FIELD BY FIELD, so a key the type
    // dropped contributes nothing — and `getSaveableConfig()` then writes that
    // result as the user's WHOLE file, so the next TUI save deletes the key.
    // A setting that vanishes on save is the same defect as a setting that was
    // never read, so the load has to name it.
    const dir = mkdtempSync(join(tmpdir(), 'nexus-stale-'))
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'nexus.jsonc'), JSON.stringify({
      budget: { maxTotalCost: 25, maxCostPerAgent: 2 },
      selfHealing: { enabled: true, maxRetries: 3, retryDelay: 1000, backoffMultiplier: 3 },
    }))

    const warnings: string[] = []
    const realWarn = console.warn
    console.warn = (message: unknown) => { warnings.push(String(message)) }
    try {
      const manager = new NexusConfigManager(
        { enabled: false, port: 4747, host: '127.0.0.1' }, { enabled: false }, [], undefined,
      )
      await manager.loadFromPath(dir)
      const merged = manager.getConfig()

      // Dropped, not carried: the keys are absent from the merged config, which
      // is what makes them safe to write back.
      expect(merged.budget).toEqual({ maxTotalCost: 25, maxCostPerTask: 1, alertThreshold: 0.2 })
      expect(Object.keys(merged.selfHealing).sort())
        .toEqual(['contextTransfer', 'enabled', 'maxRetries', 'retryDelay'])

      // And named, both of them, on one line — a user upgrading fixes it in one
      // pass rather than one restart per key.
      const line = warnings.find(w => w.includes('does not read'))
      expect(line).toBeDefined()
      expect(line).toContain('budget.maxCostPerAgent')
      expect(line).toContain('selfHealing.backoffMultiplier')
      // The live keys are NOT named. A report that lists everything is noise.
      expect(line).not.toContain('budget.maxTotalCost')
      expect(line).not.toContain('selfHealing.retryDelay')
    } finally {
      console.warn = realWarn
    }
  })

  it('names a whole block it does not know about, rather than each key in it', async () => {
    // The fix for an unknown block is to delete the block. Listing its four
    // contents separately would read as four separate problems, and a user who
    // deleted three of them would still have a working-looking file.
    const dir = mkdtempSync(join(tmpdir(), 'nexus-stale2-'))
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(dir, '.opencode'), {recursive: true })
    writeFileSync(join(dir, '.opencode', 'nexus.jsonc'), JSON.stringify({
      legacyBlock: { alpha: 1, beta: 2 },
      budget: { maxTotalCost: 25 },
    }))

    const warnings: string[] = []
    const realWarn = console.warn
    console.warn = (message: unknown) => { warnings.push(String(message)) }
    try {
      const manager = new NexusConfigManager(
        { enabled: false, port: 4747, host: '127.0.0.1' }, { enabled: false }, [], undefined,
      )
      await manager.loadFromPath(dir)

      const line = warnings.find(w => w.includes('does not read'))
      expect(line).toContain('legacyBlock (whole block)')
      expect(line).not.toContain('legacyBlock.alpha')
      expect(line).not.toContain('legacyBlock.beta')
    } finally {
      console.warn = realWarn
    }
  })

  it('says nothing about the open-keyed blocks, or every user file is an error', async () => {
    // `models` and `customRoles` have no closed key set: a role name and a custom
    // role are the user's to invent. Reporting them would make the warning
    // meaningless on day one, and a warning that always fires is one nobody reads.
    const dir = mkdtempSync(join(tmpdir(), 'nexus-stale3-'))
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'nexus.jsonc'), JSON.stringify({
      models: { coder: 'anthropic/claude-sonnet-4-6', someNewRole: 'openai/gpt-5-mini' },
      customRoles: [{ name: 'auditor', prompt: 'audit' }],
    }))

    const warnings: string[] = []
    const realWarn = console.warn
    console.warn = (message: unknown) => { warnings.push(String(message)) }
    try {
      const manager = new NexusConfigManager(
        { enabled: false, port: 4747, host: '127.0.0.1' }, { enabled: false }, [], undefined,
      )
      await manager.loadFromPath(dir)
      expect(warnings.filter(w => w.includes('does not read'))).toEqual([])
    } finally {
      console.warn = realWarn
    }
  })

  it('declares exactly the keys `NexusFullConfig` declares, per block', async () => {
    // The panel intersects discovered keys against `declaredConfigLeaves()`,
    // which reads the `DEFAULT_CONFIG` literal. If the two ever disagree the
    // panel starts marking LIVE keys read-only — which is a worse failure than
    // the stale one it prevents, because it is silent and total. So the
    // authority is checked against the interfaces, which are themselves.
    const types = await readSourceFile('types')
    const config = await readSourceFile('config')
    const full = interfaceBody(config, 'NexusFullConfig')
    const leaves = declaredConfigLeaves()

    for (const [block, keys] of leaves) {
      if (keys === null) {
        // An open block. `models` and `customRoles` are the only two, and both
        // are open by DESIGN rather than by omission — a role name and a custom
        // role are the user's to invent. Named explicitly so adding a third
        // closed block to the map is a deliberate act.
        expect(['models', 'customRoles']).toContain(block)
        continue
      }
      expect({ block, keys }).toEqual({ block, keys: declaredBlockKeys(block, config, types) })
    }

    // And the closed blocks are exactly the ones whose leaves are flat, since
    // the panel's check is `path.length === 2`. A closed block that ever nested
    // deeper would have every descendant marked stale, so the assumption is
    // asserted rather than left in a comment.
    for (const [block, keys] of leaves) {
      if (keys === null) continue
      const nested = keys.filter(key => /[.[\]]/.test(key))
      expect({ block, nested }).toEqual({ block, nested: [] })
    }

    // `BudgetConstraint` is the shape the ENFORCEMENT reads and the one
    // `NexusFullConfig.budget` deliberately is not, so the difference is the
    // `hardLimit` decision and it is asserted here rather than only in prose.
    expect(interfaceFieldNames(types, 'BudgetConstraint').sort())
      .toEqual(['alertThreshold', 'hardLimit', 'maxCostPerTask', 'maxTotalCost'])
    // `hardLimit` is absent from `NexusFullConfig.budget` but present on
    // `BudgetConstraint`, and that difference IS the decision — so it is
    // asserted on the DECLARED KEYS rather than by scanning source text, which
    // could pass on a mention in a comment. `declaredBlockKeys` blanks comments
    // and brace-matches, so this reads the real block.
    expect(declaredBlockKeys('budget', config, types)).not.toContain('hardLimit')
    expect(interfaceFieldNames(types, 'BudgetConstraint')).toContain('hardLimit')
  })
})

describe('every preset still loads, and states a whole selfHealing block', () => {
  it('gives all four presets the three budget keys and all four selfHealing keys', () => {
    // The presets are the one place a block literal can be silently partial:
    // `Partial<NexusFullConfig>` makes a whole block optional, so a preset
    // missing `retryDelay` would typecheck and then resolve through the merge to
    // the default — indistinguishable, to a user, from a preset that chose it.
    const names = Object.keys(PRESETS).sort()
    expect(names).toEqual(['balanced', 'cost-optimized', 'enterprise', 'minimal'])
    for (const name of names) {
      const preset = PRESETS[name]
      expect({ name, budget: Object.keys(preset.config.budget ?? {}).sort() })
        .toEqual({ name, budget: ['alertThreshold', 'maxCostPerTask', 'maxTotalCost'] })
      expect({ name, selfHealing: Object.keys(preset.config.selfHealing ?? {}).sort() })
        .toEqual({ name, selfHealing: ['contextTransfer', 'enabled', 'maxRetries', 'retryDelay'] })
    }
  })

  it('applies a preset through the manager and keeps the values', () => {
    const manager = new NexusConfigManager(
      { enabled: false, port: 4747, host: '127.0.0.1' }, { enabled: false }, [], undefined,
    )
    manager.updateStorageConfig(PRESETS['cost-optimized'].config)
    const applied = manager.getConfig()
    expect(applied.budget.maxTotalCost).toBe(3.00)
    expect(applied.budget.maxCostPerTask).toBe(0.30)
    expect(applied.selfHealing.retryDelay).toBe(1000)
  })
})

describe('the dashboard no longer claims a ceiling that was never enforced', () => {
  it('draws the per-task key with the advisory label and omits the per-agent key', async () => {
    // The page is read as SOURCE here, not run: `test/dashboard-page-execution`
    // already runs it and pins the rendered absence. This is the cheap
    // half — that the strings are gone from the file at all.
    const code = stripComments(await readDashboardHtml())
    expect(code).toContain('maxCostPerTask')
    expect(code).not.toContain('maxCostPerAgent')
    // The old caption asserted a per-agent ceiling on every agent card. It is
    // now scaled by the one cap that is enforced, and the words say so.
    expect(code).not.toContain('per-agent ceiling')
    expect(code).toContain('total budget')
  })
})

describe('team.addMember no longer takes a model it never used', () => {
  it('stores no model on the member, and the tool schema does not ask for one', () => {
    const manager = new TeamManager()
    const team = manager.create('T', 'architect')
    const member = manager.addMember(team.id, 'coder')
    expect(member).not.toBeNull()
    // Runtime keys, not the type: a `model` that came back by any other route
    // still fails here.
    expect(Object.keys(member as object).sort()).toEqual(['id', 'role', 'status'])

    // And the tool's input schema, which used to REQUIRE `model` from the model
    // writing the call. Read out of the source because the tool is registered
    // through OpenCode's plugin API, which is not reachable from a unit test.
    const source = stripComments(readFileSync(join(import.meta.dir, '..', 'src', 'index.ts'), 'utf-8'))
    const block = source.slice(source.indexOf('name: "team.addMember"'))
    const schema = block.slice(0, block.indexOf('execute:'))
    expect(schema).not.toContain('"model"')
    expect(schema).toContain('required: ["teamId", "role"]')
  })
})

/**
 * The keys `NexusFullConfig` declares for one block, read out of the SOURCE.
 *
 * Two spellings, because `NexusFullConfig` uses both and a test that handled
 * only one would pass vacuously on the other four blocks: `budget` and
 * `selfHealing` are inline object types, while `dashboard`, `notifications`,
 * `gitFlow` and `effort` are REFERENCES to interfaces declared elsewhere (in
 * this file or in `types.ts`). Following the reference is the only way to get
 * the real answer for a block written the way a maintainer would write it.
 */
function declaredBlockKeys(block: string, configSource: string, typesSource: string): string[] {
  // Comments are blanked first, and that is load-bearing rather than tidiness:
  // these bodies are located by brace matching, and a comment containing a `{` —
  // `{ … }` in a doc block, or `{ "budget": … }` in an example — would be the
  // first brace found and would send the match into the wrong place entirely.
  const config = stripComments(configSource)
  const types = stripComments(typesSource)
  const full = interfaceBody(config, 'NexusFullConfig')
  const at = new RegExp(`^  ${block}:`, 'm').exec(full)
  if (!at) throw new Error(`NexusFullConfig has no block named ${block}`)

  const rest = full.slice(at.index + at[0].length).trimStart()
  if (rest.startsWith('{')) {
    // Inline: `budget: { … }`. Brace-matched, because the literal spans lines
    // and does not begin and end on one.
    return [...balanced(full.indexOf('{', at.index), full)]
      .flatMap(body => [...body.matchAll(/^\s{4}(\w+)[?:]/gm)].map(m => m[1]!)).sort()
  }

  // A reference: `dashboard: NexusDashboardConfig`. Following it is the only way
  // to get the real answer for a block written the way a maintainer would write
  // it, and the source it lives in differs per block. The name is the first
  // identifier on the line and NOT the text up to the next `{` — in a body where
  // every other block is also a reference, the next brace belongs to a
  // completely different block, several lines down.
  const named = /^\s*([A-Za-z0-9_]+)/.exec(rest)?.[1]
  if (!named) throw new Error(`block ${block} is neither an inline type nor a reference`)
  const source = config.includes(`interface ${named} {`) ? config : types
  return [...interfaceBody(source, named).matchAll(/^\s{2}(\w+)[?:]/gm)].map(m => m[1]!).sort()
}

/** The text between the brace at `open` and its match, exclusive of both. */
function balanced(open: number, source: string): string[] {
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return [source.slice(open + 1, i)]
  }
  throw new Error('unbalanced braces')
}

/** The balanced-brace body of `interface <name> { … }`, from already-blanked source. */
function interfaceBody(source: string, name: string): string {
  const at = source.indexOf(`interface ${name} {`)
  if (at < 0) throw new Error(`interface ${name} not found`)
  let depth = 0
  for (let i = source.indexOf('{', at); i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(at, i + 1)
  }
  throw new Error(`interface ${name} body is unbalanced`)
}

/**
 * Blank comments, keeping string literals.
 *
 * The helpers' own `blankNonCode(source, false)` rather than a hand-rolled
 * stripper, for two reasons: it is length-preserving (so a position taken from
 * the blanked text still indexes the original), and it is already the primitive
 * the rest of this suite's source-reading assertions are built on — a second,
 * subtly different comment stripper here would be a second thing to get wrong.
 * Comments are blanked because most of the deleted keys are now NAMED in the
 * comments explaining them, and a check that cannot tell an explanation from a
 * use is a check that has to be weakened into uselessness.
 */
function stripComments(source: string): string {
  return blankNonCode(source, false)
}
