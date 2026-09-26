import { describe, it, expect, afterEach, mock } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
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
const { DASHBOARD_START_DESCRIPTION, DASHBOARD_STOP_DESCRIPTION, runDashboardStart, runDashboardStop } =
  await import('../src/index')
const { handleWebDashboard, parseWebDashboardTarget, probeDashboard } = await import('../src/tui')

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
  })

  describe('TUI /nexus web', () => {
    interface Harness {
      toasts: Array<{ title: string; message: string; variant: string }>
      opened: string[]
    }

    function harness(
      enabled: boolean,
      fetchImpl: typeof fetch,
      port = 14992
    ): Harness & { deps: Parameters<typeof handleWebDashboard>[1] } {
      const toasts: Harness['toasts'] = []
      const opened: string[] = []
      return {
        toasts,
        opened,
        deps: {
          dashboard: { enabled, port, host: '127.0.0.1' },
          showToast: options => { toasts.push(options) },
          openBrowser: url => { opened.push(url) },
          fetchImpl,
        },
      }
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
      expect(h.toasts).toHaveLength(1)
      expect(h.toasts[0]?.variant).toBe('error')
      expect(h.toasts[0]?.message).toContain('dashboard.enabled')
      expect(h.toasts[0]?.message).toContain('no browser was opened')
    })

    it('opens the browser against a confirmed dashboard', async () => {
      const h = harness(true, (async () =>
        new Response(JSON.stringify({ ok: true, uptime: 12.5 }), {
          headers: { 'Content-Type': 'application/json' },
        })) as unknown as typeof fetch)

      await handleWebDashboard('14996', h.deps)

      expect(h.opened).toEqual(['http://127.0.0.1:14996'])
      expect(h.toasts[0]?.variant).toBe('success')
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
      expect(h.toasts[0]?.variant).toBe('error')
      expect(h.toasts[0]?.message).toContain('not a nexus dashboard')
      expect(h.toasts[0]?.message).toContain('No browser was opened')
    })

    it('opens nothing and routes through the one working call when nothing is listening', async () => {
      // 14992 is bound by nothing, so the probe must come back empty.
      const h = harness(true, fetch)
      await handleWebDashboard(undefined, h.deps)

      expect(h.opened).toEqual([])
      expect(h.toasts[0]?.variant).toBe('info')
      // The promise this command makes: name the call that works.
      expect(h.toasts[0]?.message).toContain('nexus.dashboard.start(port=14992, host="127.0.0.1")')
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
