import { describe, it, expect, afterEach, mock } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import * as realOs from 'node:os'

// The config manager reads a GLOBAL `~/.config/opencode/nexus.jsonc` as well as
// the project one, and the developer's real global file is allowed to set
// `dashboard` — which would decide the outcome of these tests. `homedir()` is
// mocked rather than `process.env.HOME`, because under `bun test` the env var
// does not reach `os.homedir()`. Same approach, and same reason, as
// `test/config-reload.test.ts`.
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'nexus-dashboard-home-'))
mock.module('node:os', () => ({ ...realOs, default: realOs, homedir: () => SANDBOX_HOME }))

const { NexusOrchestrator } = await import('../src/orchestrator')
const { NexusConfigManager } = await import('../src/config')
const { parseDashboardTarget } = await import('../src/dashboard')
const { DASHBOARD_START_DESCRIPTION, DASHBOARD_STOP_DESCRIPTION, runDashboardStart, runDashboardStop } =
  await import('../src/index')
const { handleWebDashboard, parseWebDashboardTarget, parseDashboardSubcommand, probeDashboard } =
  await import('../src/tui')

// Everything a plugin-hosted orchestrator needs to initialise, and nothing it
// does not. `location.directory` is read by `initialize` to locate the config
// files, so these tests point it at a temp dir rather than the repo — otherwise
// a developer's own `.opencode/nexus.jsonc` would decide the outcome.
const mockCtx = (directory: string) => ({
  location: { directory },
  session: {
    create: mock(() => Promise.resolve({ id: 'session-mock-123' })),
    prompt: mock(() => Promise.resolve()),
    wait: mock(() => Promise.resolve()),
    context: mock(() => Promise.resolve([])),
  },
  storage: { get: mock(() => Promise.resolve(null)), set: mock(() => Promise.resolve()) },
  tool: { list: mock(() => Promise.resolve([])) },
})

/**
 * A project dir with a `nexus.jsonc` writing the given `dashboard` block.
 * `null` writes a config file with no `dashboard` block at all.
 */
function projectWithDashboard(dashboard: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-dashboard-'))
  mkdirSync(join(dir, '.opencode'), { recursive: true })
  writeFileSync(
    join(dir, '.opencode', 'nexus.jsonc'),
    `// test\n{\n${dashboard === null ? '' : `  "dashboard": ${JSON.stringify(dashboard)},\n`}  "budget": { "maxTotalCost": 10 }\n}\n`,
    'utf-8',
  )
  return dir
}

/** An empty project dir — no config file, so every level resolves to defaults. */
function emptyProject(): string {
  return mkdtempSync(join(tmpdir(), 'nexus-dashboard-'))
}

type DashboardBlock = { enabled: boolean; port: number; host: string }

function makeOrchestrator(directory: string, dashboard?: DashboardBlock) {
  const orchestrator = new NexusOrchestrator(dashboard ? { dashboard } : undefined)
  void orchestrator.initialize(mockCtx(directory) as never)
  return orchestrator
}

describe('dashboard entry points', () => {
  const cleanups: Array<() => void> = []

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.()
  })

  describe('config.dashboard.enabled is honoured', () => {
    it('refuses to start and names the config key (constructor)', () => {
      // No project block, so the constructor seed is the only thing that can
      // be answering — which is the point: a programmatic
      // `new NexusOrchestrator({dashboard})` has to be honoured too, or the
      // fix would only work for people who edit a file.
      const dir = emptyProject()
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
      const orchestrator = makeOrchestrator(dir, { enabled: false, port: 4747, host: '127.0.0.1' })

      expect(() => orchestrator.startDashboard()).toThrow(/dashboard\.enabled/)
      expect(() => orchestrator.startDashboard()).toThrow(/nexus\.jsonc/)
      expect(orchestrator.dashboard).toBeNull()
      orchestrator.shutdown()
    })

    it('refuses to start from a `dashboard.enabled: false` in nexus.jsonc', () => {
      // The case that made the field a dead knob: the user writes the switch
      // into the file, and before this change nothing in `src/` read it.
      const dir = projectWithDashboard({ enabled: false, port: 4747, host: '127.0.0.1' })
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
      const orchestrator = makeOrchestrator(dir)

      expect(orchestrator.configManager.getConfig().dashboard.enabled).toBe(false)
      expect(() => orchestrator.startDashboard()).toThrow(/dashboard\.enabled/)
      expect(orchestrator.dashboard).toBeNull()
      orchestrator.shutdown()
    })

    it('honours a file-level `port`/`host` when no argument is given', async () => {
      const dir = projectWithDashboard({ enabled: true, port: 14999, host: '127.0.0.1' })
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
      const orchestrator = makeOrchestrator(dir)
      try {
        orchestrator.startDashboard()
        // Nothing is listening on the built-in default, so a 200 here can only
        // have come from the address in the file.
        const response = await fetch('http://127.0.0.1:14999/api/health')
        expect(response.ok).toBe(true)
      } finally {
        orchestrator.stopDashboard()
        orchestrator.shutdown()
      }
    })

    it('a file setting only `enabled` does not blank out the port and host', () => {
      // The reason the merge is field-by-field: a spread over a level that
      // omits `port` would resolve `port` to undefined and hand `Bun.serve` one.
      const dir = projectWithDashboard({ enabled: false })
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
      const config = new NexusConfigManager()
      config.loadFromPath(dir)
      const dashboard = config.getConfig().dashboard
      expect(dashboard).toEqual({ enabled: false, port: 4747, host: '127.0.0.1' })
    })

    it('keeps the block through a save, so a TUI write cannot silently re-enable it', () => {
      // `saveProjectConfig` writes the returned object as the WHOLE file, so a
      // block left out of `getSaveableConfig` is a block deleted on the first
      // model change made in the TUI.
      const dir = projectWithDashboard({ enabled: false, port: 4747, host: '127.0.0.1' })
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
      const config = new NexusConfigManager()
      config.loadFromPath(dir)
      config.saveProjectConfig(dir)

      const reloaded = new NexusConfigManager()
      reloaded.loadFromPath(dir)
      expect(reloaded.getConfig().dashboard.enabled).toBe(false)
    })
  })

  describe('dashboard.start on an occupied port', () => {
    it('fails with a useful message, leaves no half-built module, opens no browser', async () => {
      const dir = projectWithDashboard({ enabled: true })
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
      const orchestrator = makeOrchestrator(dir)

      // A real listener that is NOT a dashboard: the shape the "port in use"
      // message exists for.
      const squatter = Bun.serve({ port: 14998, hostname: '127.0.0.1', fetch: () => new Response('nope') })
      cleanups.push(() => squatter.stop(true))

      let content = ''
      expect(() => {
        content = runDashboardStart(orchestrator, 14998, '127.0.0.1')
      }).not.toThrow()

      expect(content).toContain('Dashboard NOT started')
      expect(content).toContain('14998')
      expect(content).toContain('no browser was opened')
      // The single most important property: no URL is offered for a server
      // that is not running.
      expect(content).not.toContain('Dashboard started at')
      // And nothing half-built is reachable, so a later `stopDashboard` has no
      // phantom server to act on.
      expect(orchestrator.dashboard).toBeNull()

      orchestrator.shutdown()
    })

    it('reports a disabled start the same way, with no URL', () => {
      const dir = projectWithDashboard({ enabled: false })
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
      const orchestrator = makeOrchestrator(dir)

      const content = runDashboardStart(orchestrator)
      expect(content).toContain('Dashboard NOT started')
      expect(content).toContain('dashboard.enabled')
      expect(content).not.toContain('Dashboard started at')
      orchestrator.shutdown()
    })
  })

  describe('handleCommand("/nexus dashboard") — the server-side start', () => {
    // This is the surface the TUI's `/nexus-dashboard` reaches: it submits this
    // text to the server process, and the server's prompt hook calls
    // `handleCommand`. So "does this start anything" is a public-ish behaviour,
    // not an internal detail of a tool.
    it('starts a server and prints the address it bound', async () => {
      const dir = projectWithDashboard({ enabled: true, port: 14991, host: '127.0.0.1' })
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
      const orchestrator = makeOrchestrator(dir)

      try {
        const result = orchestrator.handleCommand('/nexus dashboard')

        expect(result).toContain('Dashboard started at http://127.0.0.1:14991')
        expect(orchestrator.dashboard?.isRunning()).toBe(true)
        // Started means serving, not merely constructed: this is the same
        // property the TUI waits on before it opens a browser.
        expect((await probeDashboard('127.0.0.1', 14991, fetch)).isNexusDashboard).toBe(true)
      } finally {
        orchestrator.shutdown()
      }
    })

    it('takes an explicit port and host', async () => {
      const dir = projectWithDashboard({ enabled: true, port: 14990, host: '127.0.0.1' })
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
      const orchestrator = makeOrchestrator(dir)

      try {
        const result = orchestrator.handleCommand('/nexus dashboard 14989 127.0.0.1')
        expect(result).toContain('http://127.0.0.1:14989')
        expect(orchestrator.dashboard?.getAddress()?.port).toBe(14989)
      } finally {
        orchestrator.shutdown()
      }
    })

    it('says a second start did not start a second server', async () => {
      const dir = projectWithDashboard({ enabled: true, port: 14988, host: '127.0.0.1' })
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
      const orchestrator = makeOrchestrator(dir)

      try {
        orchestrator.handleCommand('/nexus dashboard')
        const first = orchestrator.dashboard
        const again = orchestrator.handleCommand('/nexus dashboard')

        expect(again).toContain('already running at http://127.0.0.1:14988')
        expect(again).toContain('nothing was started a second time')
        // Not a port-conflict error: the port is in use by us.
        expect(again).not.toContain('NOT started')
        expect(orchestrator.dashboard).toBe(first)
      } finally {
        orchestrator.shutdown()
      }
    })

    it('reports a bind failure with no URL and no claim of a browser', () => {
      const dir = projectWithDashboard({ enabled: true, port: 14987, host: '127.0.0.1' })
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
      const orchestrator = makeOrchestrator(dir)

      const squatter = Bun.serve({ port: 14987, hostname: '127.0.0.1', fetch: () => new Response('nope') })
      cleanups.push(() => squatter.stop(true))

      const result = orchestrator.handleCommand('/nexus dashboard 14987 127.0.0.1')

      expect(result).toContain('Dashboard NOT started')
      expect(result).toContain('14987')
      expect(result).toContain('no browser was opened')
      expect(result).not.toContain('http://')
      expect(orchestrator.dashboard).toBeNull()

      orchestrator.shutdown()
    })

    it('reports a config-disabled start as the config refusal it is', () => {
      const dir = projectWithDashboard({ enabled: false, port: 14986, host: '127.0.0.1' })
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
      const orchestrator = makeOrchestrator(dir)

      const result = orchestrator.handleCommand('/nexus dashboard')

      expect(result).toContain('Dashboard NOT started')
      expect(result).toContain('dashboard.enabled')
      expect(result).not.toContain('http://')
      expect(orchestrator.dashboard).toBeNull()

      orchestrator.shutdown()
    })

    it('rejects an unparseable port without starting anything', () => {
      const dir = projectWithDashboard({ enabled: true, port: 14985, host: '127.0.0.1' })
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
      const orchestrator = makeOrchestrator(dir)

      const result = orchestrator.handleCommand('/nexus dashboard 4747abc')

      expect(result).toContain('is not a port number')
      expect(orchestrator.dashboard).toBeNull()

      orchestrator.shutdown()
    })

    it('keeps the state dump, under a name that says what it is', () => {
      const dir = projectWithDashboard({ enabled: true, port: 14984, host: '127.0.0.1' })
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
      const orchestrator = makeOrchestrator(dir)

      try {
        const state = orchestrator.handleCommand('/nexus dashboard state')
        expect(state).toContain('running')
        expect(state).toContain('agents')
        // A state dump starts nothing, and says nothing about a dashboard.
        expect(orchestrator.dashboard).toBeNull()
      } finally {
        orchestrator.shutdown()
      }
    })

    it('stops a running dashboard, and says so when there was none', () => {
      const dir = projectWithDashboard({ enabled: true, port: 14983, host: '127.0.0.1' })
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
      const orchestrator = makeOrchestrator(dir)

      try {
        expect(orchestrator.handleCommand('/nexus dashboard stop')).toContain('No dashboard was running')
        orchestrator.handleCommand('/nexus dashboard')
        expect(orchestrator.handleCommand('/nexus dashboard stop')).toContain('Dashboard stopped')
        expect(orchestrator.dashboard).toBeNull()
      } finally {
        orchestrator.shutdown()
      }
    })

    it('lists the subcommands it actually answers to', () => {
      const dir = projectWithDashboard({ enabled: true, port: 14982, host: '127.0.0.1' })
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
      const orchestrator = makeOrchestrator(dir)

      const result = orchestrator.handleCommand('/nexus nonsense')
      expect(result).toContain('dashboard [port] [host]')
      expect(result).toContain('dashboard stop')
      expect(result).toContain('dashboard state')

      orchestrator.shutdown()
    })

    it('never throws, for a command the prompt hook runs on any prompt', async () => {
      // The prompt hook wraps this call, but the contract is worth having here:
      // every outcome is text, including the ones with no address to report.
      const dir = projectWithDashboard({ enabled: true, port: 14981, host: '127.0.0.1' })
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
      const orchestrator = makeOrchestrator(dir)

      try {
        for (const text of [
          '/nexus dashboard',
          '/nexus dashboard stop',
          '/nexus dashboard state',
          '/nexus dashboard 0',
          '/nexus dashboard 14981',
        ]) {
          expect(typeof orchestrator.handleCommand(text)).toBe('string')
        }
      } finally {
        orchestrator.shutdown()
      }
    })
  })

  describe('dashboard.start / dashboard.stop tool text', () => {
    it('states the port must be free, the defaults, the config gate and the URL', () => {
      // A model decides whether to call this from the description and nothing
      // else, so the four facts below are the contract.
      expect(DASHBOARD_START_DESCRIPTION).toContain('must be FREE')
      expect(DASHBOARD_START_DESCRIPTION).toContain('4747')
      expect(DASHBOARD_START_DESCRIPTION).toContain('127.0.0.1')
      expect(DASHBOARD_START_DESCRIPTION).toContain('enabled: false')
      expect(DASHBOARD_START_DESCRIPTION).toContain('the URL is printed')
    })

    it('states that stop is a no-op when nothing is running', () => {
      expect(DASHBOARD_STOP_DESCRIPTION).toContain('no-op if no dashboard is running')
    })

    it('stop reports honestly when there was nothing to stop', () => {
      const dir = projectWithDashboard({ enabled: true })
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
      const orchestrator = makeOrchestrator(dir)

      expect(runDashboardStop(orchestrator)).toContain('No dashboard was running')

      orchestrator.startDashboard(14997, '127.0.0.1')
      expect(runDashboardStop(orchestrator)).toContain('Dashboard stopped')
      expect(runDashboardStop(orchestrator)).toContain('No dashboard was running')

      orchestrator.shutdown()
    })

    it('a second start is not reported as a port conflict', () => {
      // The bind would fail — against ourselves. "already running" is the only
      // true description, and it is what the caller needs to decide not to
      // retry on another port.
      const dir = projectWithDashboard({ enabled: true })
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
      const orchestrator = makeOrchestrator(dir)

      try {
        expect(runDashboardStart(orchestrator, 14997, '127.0.0.1')).toContain('Dashboard started at')
        const again = runDashboardStart(orchestrator, 14997, '127.0.0.1')
        expect(again).toContain('already running at http://127.0.0.1:14997')
        expect(again).not.toContain('NOT started')
      } finally {
        orchestrator.shutdown()
      }
    })
  })

  describe('TUI /nexus dashboard', () => {
    interface Harness {
      toasts: Array<{ title: string; message: string; variant: string }>
      opened: string[]
      submitted: string[]
    }

    function harness(
      enabled: boolean,
      fetchImpl: typeof fetch,
      port = 14992,
      submitCommand?: (text: string) => Promise<void> | void
    ): Harness & { deps: Parameters<typeof handleWebDashboard>[1] } {
      const toasts: Harness['toasts'] = []
      const opened: string[] = []
      const submitted: string[] = []
      return {
        toasts,
        opened,
        submitted,
        deps: {
          dashboard: { enabled, port, host: '127.0.0.1' },
          showToast: options => { toasts.push(options) },
          openBrowser: url => { opened.push(url) },
          submitCommand: submitCommand ?? (text => { submitted.push(text) }),
          fetchImpl,
          // No real waiting: the loop's correctness is what is under test, and
          // 15 real 200ms sleeps would cost three seconds per case.
          waitImpl: async () => {},
        },
      }
    }

    /** Answers `/api/health` only from the `n`-th call onwards. */
    function healthFromCall(n: number): typeof fetch {
      let calls = 0
      return (async () => {
        calls += 1
        if (calls < n) throw new Error('fetch failed')
        return new Response(JSON.stringify({ ok: true, uptime: 1 }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }) as unknown as typeof fetch
    }

    it('says why and opens nothing when the dashboard is disabled by config', async () => {
      const calls: string[] = []
      const h = harness(false, (async (url: string) => {
        calls.push(url)
        return new Response('{}')
      }) as unknown as typeof fetch)

      await handleWebDashboard(undefined, h.deps)

      expect(h.opened).toEqual([])
      // Not even a probe: the user has switched the thing off, so a request to
      // a port that is guaranteed to refuse is noise, not diagnosis.
      expect(calls).toEqual([])
      // And no command submitted: the server would refuse it with the same
      // message, having spent a prompt to say so.
      expect(h.submitted).toEqual([])
      expect(h.toasts).toHaveLength(1)
      expect(h.toasts[0]?.variant).toBe('error')
      expect(h.toasts[0]?.message).toContain('dashboard.enabled')
      expect(h.toasts[0]?.message).toContain('no browser was opened')
    })

    it('opens the browser against a confirmed dashboard, and starts nothing', async () => {
      const h = harness(true, (async () =>
        new Response(JSON.stringify({ ok: true, uptime: 12.5 }), {
          headers: { 'Content-Type': 'application/json' },
        })) as unknown as typeof fetch)

      await handleWebDashboard('14996', h.deps)

      expect(h.opened).toEqual(['http://127.0.0.1:14996'])
      // A second `/nexus dashboard` on a live dashboard must not ask the server
      // for another one: it would be refused as a port conflict, by us.
      expect(h.submitted).toEqual([])
      expect(h.toasts[0]?.variant).toBe('success')
      expect(h.toasts[0]?.message).toContain('already running')
    })

    it('opens nothing and says so when a DIFFERENT process holds the port', async () => {
      // The old code shelled out to `open` unconditionally, so a stale
      // dashboard or an unrelated dev server got the user's browser.
      const squatter = Bun.serve({
        port: 14995,
        hostname: '127.0.0.1',
        fetch: () => new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } }),
      })
      cleanups.push(() => squatter.stop(true))

      const h = harness(true, fetch)
      await handleWebDashboard('14995', h.deps)

      expect(h.opened).toEqual([])
      // No start is even attempted: the bind cannot succeed, and asking anyway
      // would report a failure the user could have been told up front.
      expect(h.submitted).toEqual([])
      expect(h.toasts[0]?.variant).toBe('error')
      expect(h.toasts[0]?.message).toContain('not a nexus dashboard')
      expect(h.toasts[0]?.message).toContain('No browser was opened')
    })

    it('starts it through the server command and opens the browser once the listen is confirmed', async () => {
      // The first probe finds nothing, the server starts the dashboard on the
      // submitted command, and the loop's second probe finds it.
      const h = harness(true, healthFromCall(2))

      await handleWebDashboard(undefined, h.deps)

      // ONE action, and it is the command the server's prompt hook routes to
      // `handleCommand` — not a description of how the user might start it.
      expect(h.submitted).toEqual(['/nexus dashboard 14992 127.0.0.1'])
      expect(h.opened).toEqual(['http://127.0.0.1:14992'])
      expect(h.toasts[0]?.variant).toBe('success')
      expect(h.toasts[0]?.message).toContain('Started and opened http://127.0.0.1:14992')
    })

    it('opens nothing and claims nothing when the start never confirmed a listen', async () => {
      // The bind-failure shape: the command ran, the server refused, and the
      // only honest thing the TUI can say is that nothing is serving.
      const h = harness(true, fetch)

      await handleWebDashboard(undefined, h.deps)

      expect(h.submitted).toEqual(['/nexus dashboard 14992 127.0.0.1'])
      expect(h.opened).toEqual([])
      expect(h.toasts[0]?.variant).toBe('error')
      expect(h.toasts[0]?.message).toContain('no browser was opened')
      // A URL in a failure message is indistinguishable from a working one.
      expect(h.toasts[0]?.message).not.toContain('http://')
    })

    it('gives up after a bounded number of attempts rather than polling forever', async () => {
      let probes = 0
      const h = harness(true, (async () => {
        probes += 1
        throw new Error('fetch failed')
      }) as unknown as typeof fetch)
      h.deps.confirmAttempts = 3

      await handleWebDashboard(undefined, h.deps)

      // One probe to decide, then three confirm attempts — and no more.
      expect(probes).toBe(4)
      expect(h.opened).toEqual([])
    })

    it('does not promise a reply it may never get when the start is not confirmed', async () => {
      // The message names where the reason is, and that was stated too strongly:
      // "its result is in this session as the reply to …" is only true when a
      // Nexus plugin is registered in the server process, because that hook is
      // what routes the command to `handleCommand`. With no plugin there the
      // command is never handled, the confirm poll times out, and the one reply
      // in the session is the model's own unprompted answer — which is exactly
      // the confusing case this toast exists for, and pointing at it is worse
      // than saying nothing. Asserted on the conditional phrasing so it cannot
      // quietly go back to being a promise.
      const h = harness(true, (async () => {
        throw new Error('fetch failed')
      }) as unknown as typeof fetch)
      h.deps.confirmAttempts = 2

      await handleWebDashboard(undefined, h.deps)

      const message = h.toasts[0]?.message ?? ''
      expect(h.toasts[0]?.variant).toBe('error')
      expect(message).toContain('If a Nexus plugin is active in that process')
      expect(message).toContain('was never handled at all')
      // Still actionable, and still offering the other thing to try.
      expect(message).toContain('/nexus web 4748')
      expect(h.opened).toEqual([])
    })

    it('reports a command that never reached the server, and opens nothing', async () => {
      const h = harness(true, fetch, 14992, () => {
        throw new Error('no session is open to run the command in')
      })

      await handleWebDashboard(undefined, h.deps)

      expect(h.opened).toEqual([])
      expect(h.toasts[0]?.variant).toBe('error')
      expect(h.toasts[0]?.message).toContain('never reached the OpenCode server')
      expect(h.toasts[0]?.message).toContain('no browser was opened')
    })

    it('rejects a non-numeric port before submitting anything', async () => {
      const h = harness(true, fetch)

      await handleWebDashboard('not-a-port', h.deps)

      expect(h.submitted).toEqual([])
      expect(h.opened).toEqual([])
      expect(h.toasts[0]?.variant).toBe('error')
    })
  })

  /**
   * `/nexus dashboard stop` from the TUI.
   *
   * The bug: the TUI intercepted `dashboard` and ran its OWN port parser over
   * the argument, so `stop` came back as `"stop" is not a port number` and the
   * server — which has implemented `stop` and `state` since the TUI was written
   * — was never asked. The fix forwards the subcommand and returns before any
   * start path.
   *
   * Every assertion below is on a RECORDED CALL, not on rendered text. A test
   * that asserted only "a toast appeared" would pass against the broken code if
   * the broken code's toast changed, and would pass against a fix that
   * submitted the wrong text — which is the same bug wearing a different hat.
   * So each case pins the exact command string, and the no-start cases pin
   * `opened` and `submitted` together, because the start path is exactly the
   * thing that must not happen.
   */
  describe('TUI /nexus dashboard stop and state', () => {
    interface Harness {
      toasts: Array<{ title: string; message: string; variant: string }>
      opened: string[]
      submitted: string[]
      /** Probes, so a subcommand is shown not to have touched the network. */
      probes: string[]
    }

    function harness(enabled = true, submitCommand?: (text: string) => Promise<void> | void): Harness & {
      deps: Parameters<typeof handleWebDashboard>[1]
    } {
      const h: Harness = { toasts: [], opened: [], submitted: [], probes: [] }
      return {
        ...h,
        get toasts() { return h.toasts },
        get opened() { return h.opened },
        get submitted() { return h.submitted },
        get probes() { return h.probes },
        deps: {
          dashboard: { enabled, port: 14992, host: '127.0.0.1' },
          showToast: options => { h.toasts.push(options) },
          openBrowser: url => { h.opened.push(url) },
          submitCommand: submitCommand ?? (text => { h.submitted.push(text) }),
          fetchImpl: (async (url: string) => {
            h.probes.push(url)
            return new Response(JSON.stringify({ ok: true, uptime: 1 }), {
              headers: { 'Content-Type': 'application/json' },
            })
          }) as unknown as typeof fetch,
          waitImpl: async () => {},
        },
      }
    }

    for (const sub of ['stop', 'state'] as const) {
      it(`sends \`${sub}\` to the server as \`/nexus dashboard ${sub}\`, and parses nothing`, async () => {
        const h = harness()

        await handleWebDashboard(sub, h.deps)

        // The exact text, not "something was submitted": the server routes on
        // the first token after `dashboard`, so `/nexus dashboard stops` or
        // `/nexus dashboard dashboard stop` would be a different command.
        expect(h.submitted).toEqual([`/nexus dashboard ${sub}`])
        // EXACTLY ONE toast. Dropping the early return that ends the
        // subcommand path leaves the argument to fall through to the port
        // parser, so the user gets "stop sent" and then `"stop" is not a port
        // number` — the original bug, arriving after a success. Counting the
        // toasts is what catches that; asserting the first one is not enough.
        expect(h.toasts).toHaveLength(1)
        expect(h.toasts[0]?.variant).toBe('info')
      })

      it(`\`${sub}\` opens no browser and claims nothing was started`, async () => {
        const h = harness()

        await handleWebDashboard(sub, h.deps)

        expect(h.opened).toEqual([])
        // The start path's two tells, absent. "Started" is the word the
        // success toast at the end of `handleWebDashboard` leads with, so a
        // subcommand that reached it would carry it.
        expect(h.toasts.map(t => t.message).join('\n')).not.toContain('Started and opened')
        expect(h.toasts.map(t => t.message).join('\n')).toContain('no browser was opened')
      })
    }

    it('a `stop` never reaches the probe, the start command, or the confirm loop', async () => {
      // The stronger claim than "no browser": the start path's FIRST act is a
      // probe, and its second is a `/nexus dashboard <port> <host>` submit. A
      // stop that did either would be a stop that started something.
      const h = harness()

      await handleWebDashboard('stop', h.deps)

      expect(h.probes).toEqual([])
      // Exactly one command, and it is the subcommand: a second entry here
      // would be a start issued on the way past.
      expect(h.submitted).toEqual(['/nexus dashboard stop'])
      expect(h.opened).toEqual([])
      // And one toast, for the same reason: a fall-through adds a second.
      expect(h.toasts).toHaveLength(1)
    })

    it('forwards a `stop` even when the dashboard is disabled by config', async () => {
      // The server answers `stop` before its own config gate and says plainly
      // that nothing was running. A TUI that refused here would invent a rule
      // the server does not have, and would refuse the one command whose whole
      // job is to clean up.
      const h = harness(false)

      await handleWebDashboard('stop', h.deps)

      expect(h.submitted).toEqual(['/nexus dashboard stop'])
      expect(h.opened).toEqual([])
      expect(h.toasts[0]?.variant).toBe('info')
    })

    it('does not claim a result the TUI never received', async () => {
      // `submitCommand` returns `void`: the TUI submits and does not get the
      // answer back. A toast quoting a stop that did not happen is the same
      // class of lie the confirm loop exists to avoid, so the toast points at
      // the session reply instead of asserting an outcome.
      const h = harness()

      await handleWebDashboard('stop', h.deps)

      const message = h.toasts[0]?.message ?? ''
      expect(message).toContain("this session's reply")
      expect(message).not.toContain('Dashboard stopped')
    })

    it('reports a subcommand that never reached the server, and starts nothing', async () => {
      const h = harness(true, () => { throw new Error('server unreachable') })

      await handleWebDashboard('stop', h.deps)

      expect(h.opened).toEqual([])
      expect(h.toasts[0]?.variant).toBe('error')
      // The title, too: a failure titled "stop sent" tells the user the
      // opposite of what happened, and a variant check alone would not see it.
      expect(h.toasts[0]?.title).toContain('not sent')
      expect(h.toasts[0]?.message).toContain('server unreachable')
    })

    it('matches the server on case: Stop and STOP are the same command', async () => {
      // `handleDashboardCommand` lowercases before comparing, so these work
      // there. Matching it is the point: a case-sensitive TUI would reject
      // what the server accepts.
      for (const input of ['Stop', 'STOP', 'sToP', '  stop  ']) {
        const h = harness()
        await handleWebDashboard(input, h.deps)
        expect(h.submitted).toEqual([`/nexus dashboard ${input.trim()}`])
        expect(h.opened).toEqual([])
      }
    })

    it('forwards the whole tail, and lets the server ignore it as the server does', async () => {
      // `handleDashboardCommand` takes token [0] and discards the rest, so
      // `stop 4747` stops the dashboard. The TUI passes the argument through
      // rather than rebuilding or second-guessing it.
      const h = harness()

      await handleWebDashboard('stop 4747 127.0.0.1', h.deps)

      expect(h.submitted).toEqual(['/nexus dashboard stop 4747 127.0.0.1'])
      expect(h.opened).toEqual([])
      expect(h.probes).toEqual([])
    })

    it('a misspelled subcommand names the subcommands and does not read as a port', async () => {
      const h = harness()

      await handleWebDashboard('sto', h.deps)

      expect(h.submitted).toEqual([])
      expect(h.opened).toEqual([])
      expect(h.toasts[0]?.variant).toBe('error')
      const message = h.toasts[0]?.message ?? ''
      expect(message).toContain('subcommand')
      expect(message).toContain('stop')
      expect(message).toContain('state')
    })

    it('a genuinely bad port still says it is a bad port', async () => {
      // The hint is one edit wide, so it cannot reach these. If it ever did,
      // a user who typed a host name would be told they misspelled a
      // subcommand — the confusion the brief asks to rule out.
      //
      // `st` is the load-bearing one: it is exactly TWO edits from `stop`, so
      // it is the input that pins the boundary at one rather than merely
      // sitting far away from it. Every other entry here is three or more
      // edits out, and a window widened to two would pass them all.
      for (const input of ['0', '70000', 'abc', '4747abc', 'not-a-port', '-1', 'localhost', 'st']) {
        const h = harness()
        await handleWebDashboard(input, h.deps)
        const message = h.toasts[0]?.message ?? ''
        expect(message).toContain('is not a port number')
        expect(message).not.toContain('subcommand')
        expect(h.submitted).toEqual([])
      }
    })

    it('still starts the dashboard for a valid port, and for a port with a host', async () => {
      // The regression the fix must not cause: treating every argument as a
      // subcommand. Both of these submit the START command, not themselves.
      const h = harness()
      const healthFromCall = (n: number) => {
        let calls = 0
        return (async () => {
          calls += 1
          if (calls < n) throw new Error('fetch failed')
          return new Response(JSON.stringify({ ok: true, uptime: 1 }), {
            headers: { 'Content-Type': 'application/json' },
          })
        }) as unknown as typeof fetch
      }

      // Bare port: first probe finds nothing, so a start is attempted.
      const bare = harness()
      bare.deps.fetchImpl = healthFromCall(2)
      await handleWebDashboard('14996', bare.deps)
      expect(bare.submitted).toEqual(['/nexus dashboard 14996 127.0.0.1'])
      expect(bare.opened).toEqual(['http://127.0.0.1:14996'])

      // Port and host together, and the submitted text carries the host.
      const pair = harness()
      pair.deps.fetchImpl = healthFromCall(2)
      await handleWebDashboard('14996 0.0.0.0', pair.deps)
      expect(pair.submitted).toEqual(['/nexus dashboard 14996 0.0.0.0'])
      expect(pair.opened).toEqual(['http://0.0.0.0:14996'])
    })

    it('no argument still starts the configured default, untouched by the subcommand path', async () => {
      const h = harness()
      let calls = 0
      h.deps.fetchImpl = (async () => {
        calls += 1
        if (calls < 2) throw new Error('fetch failed')
        return new Response(JSON.stringify({ ok: true, uptime: 1 }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }) as unknown as typeof fetch

      await handleWebDashboard(undefined, h.deps)

      expect(h.submitted).toEqual(['/nexus dashboard 14992 127.0.0.1'])
      expect(h.opened).toEqual(['http://127.0.0.1:14992'])
    })
  })

  describe('parseDashboardSubcommand', () => {
    it('names only the two the server implements, case-insensitively', () => {
      expect(parseDashboardSubcommand('stop')).toBe('stop')
      expect(parseDashboardSubcommand('STOP')).toBe('stop')
      expect(parseDashboardSubcommand('state')).toBe('state')
      expect(parseDashboardSubcommand('  State ')).toBe('state')
      // Everything else is an address, or a typo, and belongs to the parser.
      for (const input of [undefined, '', '  ', '4748', '4748 0.0.0.0', 'abc', 'sto', 'st', 'stateful']) {
        expect(parseDashboardSubcommand(input)).toBeUndefined()
      }
    })

    it('agrees with the server about which arguments are subcommands', () => {
      // The TUI cannot import the server's private `handleDashboardCommand`, so
      // the contract is restated here against the same rule it implements:
      // first token, lowercased, compared for equality. `stateful` is the
      // case that matters — a `startsWith` implementation would claim it.
      const serverSays = (argument: string): 'stop' | 'state' | undefined => {
        const sub = argument.trim().split(/\s+/).filter(Boolean)[0]?.toLowerCase()
        return sub === 'state' || sub === 'stop' ? sub : undefined
      }
      for (const input of ['stop', 'state', 'Stop', 'STATE', 'stop 4747', 'sto', 'stateful', '  stop  ', '4748', '']) {
        expect(parseDashboardSubcommand(input)).toBe(serverSays(input))
      }
    })

    it('is not a port parser: it leaves the port arguments to the port parser', () => {
      // The subcommand check and the port check are separate, and a port is
      // not a subcommand. The two functions together cover the argument, and
      // each is pinned by its own test.
      const fallback = { port: 4747, host: '127.0.0.1' }
      for (const input of ['4748', '4748 0.0.0.0']) {
        expect(parseDashboardSubcommand(input)).toBeUndefined()
        expect(parseWebDashboardTarget(input, fallback)).toEqual({ target: { port: 4748, host: input.includes(' ') ? '0.0.0.0' : '127.0.0.1' } })
      }
    })
  })

  describe('parseWebDashboardTarget', () => {
    const fallback = { port: 4747, host: '127.0.0.1' }

    it('uses the configured defaults for empty input', () => {
      expect(parseWebDashboardTarget(undefined, fallback)).toEqual({ target: fallback })
      expect(parseWebDashboardTarget('  ', fallback)).toEqual({ target: fallback })
    })

    it('reads a bare port, and a port with a host', () => {
      expect(parseWebDashboardTarget('4748', fallback)).toEqual({ target: { port: 4748, host: '127.0.0.1' } })
      expect(parseWebDashboardTarget('4748 0.0.0.0', fallback)).toEqual({ target: { port: 4748, host: '0.0.0.0' } })
    })
    it('rejects a non-numeric port instead of coercing it to NaN', () => {
      // `parseInt("abc")` is NaN, and NaN used to reach a URL as the literal
      // text "NaN" — a connection failure whose cause was invisible.
      expect(parseWebDashboardTarget('abc', fallback)).toEqual({ error: expect.stringContaining('"abc"') })
      expect(parseWebDashboardTarget('0', fallback)).toHaveProperty('error')
      expect(parseWebDashboardTarget('70000', fallback)).toHaveProperty('error')
      // `parseInt` would have accepted this as 4747.
      expect(parseWebDashboardTarget('4747abc', fallback)).toHaveProperty('error')
    })

    it('agrees with the server-side parser about every input', () => {
      // The TUI cannot import `parseDashboardTarget` from `src/dashboard.ts`
      // without inlining 150 KB of page markup into `dist/tui.js`, so the two
      // are separate functions resolving the same argument. They disagree, the
      // TUI asks the server to start a port the server then refuses — which
      // looks exactly like a bind failure, so the divergence has to be a
      // failing test rather than something a user finds out.
      for (const input of [undefined, '', '  ', '4748', '4748 0.0.0.0', 'abc', '0', '70000', '4747abc', '-1', '4748.5']) {
        expect(parseWebDashboardTarget(input, fallback)).toEqual(parseDashboardTarget(input, fallback))
      }
    })
  })

  // The parser test above keeps the two functions in agreement. It cannot
  // keep them in separate BUNDLES, which is the constraint that made them two
  // functions in the first place: `src/dashboard.ts:11` inlines
  // `dashboard/index.html` with a text import, so importing that module from
  // `src/tui.tsx` would pull ~170 KB of page markup into `dist/tui.js`, which
  // serves no dashboard and reads none of it. The comments at both sites say
  // so, and a comment is not a test — the next reader who sees the duplication
  // merges them, and the cost lands at build time where nothing fails.
  describe('the built bundles keep the dashboard markup in one of them', () => {
    // Strings taken from `dashboard/index.html`. Short and specific enough that
    // a coincidence in application code is not the reason a bundle matches,
    // and from the head of the file so a later edit to the body cannot quietly
    // make this pass for the wrong reason.
    const MARKUP = ['--surface-hover', '0d1117', '161b22', '30363d'] as const

    const dist = (file: string): string | null => {
      const path = join(import.meta.dir, '..', 'dist', file)
      return existsSync(path) ? readFileSync(path, 'utf-8') : null
    }

    it('inlines the dashboard page into the server bundle, which serves it', () => {
      const server = dist('index.js')
      if (server === null) return // a source checkout with no build; see below
      for (const mark of MARKUP) expect(server).toContain(mark)
    })

    it('keeps every byte of that markup out of the TUI bundle', () => {
      const tui = dist('tui.js')
      if (tui === null) return
      for (const mark of MARKUP) {
        expect(tui).not.toContain(mark)
      }
    })

    it('and the TUI bundle is nowhere near large enough to be carrying it', () => {
      // The size claim is what makes the two tests above a real assertion
      // rather than a coincidence about four strings. `dist/tui.js` is ~72 KB
      // and the page is ~170 KB, so a bundle that had inlined the markup
      // would be roughly 240 KB. The bar is set at the sum, not below it, so
      // the current bundle keeps a wide margin and a regression is not one
      // that has to be timed to notice.
      const tui = dist('tui.js')
      if (tui === null) return
      const page = join(import.meta.dir, '..', 'dashboard', 'index.html')
      const pageBytes = existsSync(page) ? statSync(page).size : 0
      expect(pageBytes).toBeGreaterThan(0)
      expect(Buffer.byteLength(tui)).toBeLessThan(pageBytes)
    })
  })

  describe('probeDashboard', () => {
    it('distinguishes a dashboard, a squatter and a closed port', async () => {
      const squatter = Bun.serve({ port: 14994, hostname: '127.0.0.1', fetch: () => new Response('<html>') })
      cleanups.push(() => squatter.stop(true))

      const onSquatter = await probeDashboard('127.0.0.1', 14994, fetch)
      expect(onSquatter.listening).toBe(true)
      expect(onSquatter.isNexusDashboard).toBe(false)

      // 14993 is bound by nothing.
      const onNothing = await probeDashboard('127.0.0.1', 14993, fetch)
      expect(onNothing.listening).toBe(false)
      expect(onNothing.isNexusDashboard).toBe(false)

      const dir = projectWithDashboard({ enabled: true, port: 14993, host: '127.0.0.1' })
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
      const orchestrator = makeOrchestrator(dir)
      orchestrator.startDashboard()
      try {
        const onDashboard = await probeDashboard('127.0.0.1', 14993, fetch)
        expect(onDashboard.isNexusDashboard).toBe(true)
      } finally {
        orchestrator.stopDashboard()
        orchestrator.shutdown()
      }
    })
  })
})
