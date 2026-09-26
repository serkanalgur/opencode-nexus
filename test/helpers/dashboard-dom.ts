/**
 * A DOM small enough to run the dashboard page in, and large enough that the
 * page cannot tell.
 *
 * WHY THIS EXISTS
 *
 * `dashboard-page-contract.test.ts` proves the page's source says the right
 * things. It cannot prove the page RUNS, and that gap shipped a real bug:
 * `renderState` read `liveAgents.length` on the line above `var liveAgents`.
 * Every one of those 31 assertions still passed — the text was all there, the
 * `case` labels were all present, the budget keys were all spelled correctly —
 * and the page threw a `TypeError` on every state push and every 5s refresh,
 * which froze the entire dashboard below that line. A grep cannot see a
 * variable's declaration order. Nothing type-checks this file. So the only way
 * to catch that class is to execute the page.
 *
 * WHAT IS MODELLED, AND WHY THESE CHOICES
 *
 * Every element is a real object with real mutable fields, not a Proxy and not a
 * frozen shape, because the page assigns to `className`, `textContent`,
 * `innerHTML`, `value` and `style.*` freely and reads several of them back. Two
 * details are load-bearing rather than decorative:
 *
 *   - `classList` and `className` are the SAME storage. The page sets
 *     `className = 'cost-status hidden'` and then calls `classList.add(...)` and
 *     `classList.remove('hidden')` on the same element; if those were two
 *     independent fields the page would pass here and fail in a browser.
 *   - `textContent` and `innerHTML` are linked in the direction the page reads
 *     them. `escHtml()` sets `textContent` and reads `innerHTML` back, and
 *     `$dagNote.innerHTML += ...` reads `innerHTML` before writing it. Setting
 *     `innerHTML` therefore clears the text, as a real DOM does, and getting
 *     `innerHTML` off an element whose text was set returns ESCAPED text.
 *
 * `getElementById` returns `null` for an id the markup does not define, exactly
 * as a browser does, rather than inventing an element. That makes "the page
 * looks up an element that is not in the HTML" a loud failure here instead of a
 * silent one in production — the returned null is recorded so a test can assert
 * no unknown lookup ever happened.
 */

import { readDashboardHtml, extractInlineScript } from './dashboard-page'

/** The page's own wording for the two failure modes it reports separately. */
export const RENDER_FAILURE = 'Page failed to render'
export const PARSE_FAILURE = 'Non-JSON frame from server'

/** A stand-in for one DOM node. */
export class FakeElement {
  readonly tagName: string
  readonly id: string
  /** Set by the harness so `querySelector` can hand back a distinct node. */
  readonly ownerDocument: FakeDocument

  title = ''
  value = ''
  checked = false
  disabled = false
  type = ''
  readonly style: Record<string, string> = {}
  readonly dataset: Record<string, string> = {}
  readonly attributes = new Map<string, string>()
  readonly children: FakeElement[] = []
  parentNode: FakeElement | null = null

  // Layout. Zero by default, as an undisplayed node reports; the harness raises
  // these where a measurement changes which branch the page takes.
  offsetWidth = 0
  offsetHeight = 0
  offsetLeft = 0
  offsetTop = 0
  clientWidth = 0
  clientHeight = 0

  private classes = new Set<string>()
  private text = ''
  private html = ''
  private readonly listeners = new Map<string, Array<(evt: unknown) => void>>()

  constructor(tagName: string, ownerDocument: FakeDocument, id = '') {
    this.tagName = tagName.toUpperCase()
    this.id = id
    this.ownerDocument = ownerDocument
  }

  /**
   * `className` and `classList` over one set of names.
   *
   * Reading `className` re-joins the set, so the order the page wrote them in
   * is not preserved — nothing in the page depends on that, and a browser's own
   * `className` ordering is not contractual either.
   */
  get className(): string {
    return [...this.classes].join(' ')
  }

  set className(value: string) {
    this.classes = new Set(String(value).split(/\s+/).filter(Boolean))
  }

  readonly classList = {
    add: (...names: string[]): void => {
      for (const name of names) this.classes.add(name)
    },
    remove: (...names: string[]): void => {
      for (const name of names) this.classes.delete(name)
    },
    contains: (name: string): boolean => this.classes.has(name),
    toggle: (name: string, force?: boolean): boolean => {
      const on = force === undefined ? !this.classes.has(name) : force
      if (on) this.classes.add(name)
      else this.classes.delete(name)
      return on
    },
  }

  get textContent(): string {
    return this.text
  }

  set textContent(value: string) {
    // As in a DOM: writing text replaces the element's children, so any HTML
    // previously assigned here is gone.
    this.text = value === null || value === undefined ? '' : String(value)
    this.html = ''
  }

  get innerHTML(): string {
    return this.html !== '' ? this.html : escapeHtml(this.text)
  }

  set innerHTML(value: string) {
    this.html = value === null || value === undefined ? '' : String(value)
    this.text = ''
  }

  get firstChild(): FakeElement | null {
    return this.children[0] ?? null
  }

  get lastChild(): FakeElement | null {
    return this.children[this.children.length - 1] ?? null
  }

  get childNodes(): FakeElement[] {
    return this.children
  }

  get nextSibling(): FakeElement | null {
    if (this.parentNode === null) return null
    const i = this.parentNode.children.indexOf(this)
    return this.parentNode.children[i + 1] ?? null
  }

  appendChild(child: FakeElement): FakeElement {
    child.parentNode?.removeChild(child)
    this.children.push(child)
    child.parentNode = this
    return child
  }

  insertBefore(child: FakeElement, reference: FakeElement | null): FakeElement {
    child.parentNode?.removeChild(child)
    const at = reference === null ? this.children.length : this.children.indexOf(reference)
    this.children.splice(at < 0 ? this.children.length : at, 0, child)
    child.parentNode = this
    return child
  }

  removeChild(child: FakeElement): FakeElement {
    const at = this.children.indexOf(child)
    if (at >= 0) this.children.splice(at, 1)
    child.parentNode = null
    return child
  }

  remove(): void {
    this.parentNode?.removeChild(this)
  }

  contains(other: FakeElement | null): boolean {
    if (other === this) return true
    return this.children.some((child) => child.contains(other))
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value))
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name)
  }

  addEventListener(type: string, handler: (evt: unknown) => void): void {
    const existing = this.listeners.get(type)
    if (existing === undefined) this.listeners.set(type, [handler])
    else existing.push(handler)
  }

  removeEventListener(type: string, handler: (evt: unknown) => void): void {
    const existing = this.listeners.get(type)
    if (existing === undefined) return
    const at = existing.indexOf(handler)
    if (at >= 0) existing.splice(at, 1)
  }

  /** Fire every listener registered for `type`, as a real dispatch would. */
  dispatch(type: string, evt: unknown = { type }): void {
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler(evt)
  }

  /** How many listeners `type` has — used to assert a control was wired up. */
  listenerCount(type: string): number {
    return this.listeners.get(type)?.length ?? 0
  }

  /**
   * A single synthetic match with a real box, or null.
   *
   * Returning a measurable node rather than null is deliberate for the DAG.
   * `drawDagEdges` bails out at `if (width === 0 || height === 0) return`, so a
   * stub that reported zero would leave the entire edge-drawing loop — and the
   * "N edges could not be drawn" accounting that is the whole point of that
   * function's undrawable-edge handling — untested. Handing back a node with a
   * non-zero box sends the page down that loop, where
   * `querySelectorAll('.dag-node-box')` returns [] and every edge is counted as
   * undrawable, which is a real branch the page takes whenever a node has not
   * been laid out.
   */
  querySelector(_selector: string): FakeElement | null {
    const found = new FakeElement('div', this.ownerDocument)
    found.offsetWidth = 800
    found.offsetHeight = 600
    return found
  }

  querySelectorAll(_selector: string): FakeElement[] {
    return []
  }

  getElementsByClassName(_className: string): FakeElement[] {
    return []
  }

  getBoundingClientRect(): {
    top: number; left: number; right: number; bottom: number; width: number; height: number
  } {
    return {
      top: this.offsetTop,
      left: this.offsetLeft,
      right: this.offsetLeft + this.offsetWidth,
      bottom: this.offsetTop + this.offsetHeight,
      width: this.offsetWidth,
      height: this.offsetHeight,
    }
  }

  focus(): void {}
  blur(): void {}
  click(): void {
    this.dispatch('click')
  }
  scrollIntoView(): void {}
}

/** The five characters a browser must escape when text becomes markup. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** `document`, with an id table built from the served markup. */
export class FakeDocument {
  readonly body: FakeElement
  readonly documentElement: FakeElement
  readyState = 'complete'
  /** Every id the page looked up that the markup does not define. */
  readonly unknownIdLookups: string[] = []
  private readonly byId = new Map<string, FakeElement>()

  constructor(markupIds: readonly string[]) {
    this.body = new FakeElement('body', this)
    this.documentElement = new FakeElement('html', this)
    for (const id of markupIds) {
      this.byId.set(id, new FakeElement('div', this, id))
    }
  }

  /**
   * `null` for an unknown id, as a browser does.
   *
   * The alternative — minting an element for any string — would hide a renamed
   * or deleted id behind a silently-working stub, which is the same blindness
   * this harness exists to remove.
   */
  getElementById(id: string): FakeElement | null {
    const found = this.byId.get(id)
    if (found !== undefined) return found
    this.unknownIdLookups.push(id)
    return null
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this)
  }

  createTextNode(text: string): { textContent: string } {
    return { textContent: text }
  }

  querySelector(_selector: string): FakeElement | null {
    return null
  }

  querySelectorAll(_selector: string): FakeElement[] {
    return []
  }

  getElementsByTagName(_tagName: string): FakeElement[] {
    return []
  }

  addEventListener(_type: string, _handler: (evt: unknown) => void): void {}
  removeEventListener(_type: string, _handler: (evt: unknown) => void): void {}
}

/** A WebSocket the page can connect to and that records what it sent. */
export class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  /** Every socket the page constructed, newest last. */
  static readonly instances: FakeWebSocket[] = []

  readonly url: string
  readyState = FakeWebSocket.OPEN
  /** Raw frames the page wrote, so a test can assert on its requests. */
  readonly sent: string[] = []

  onopen: ((evt: unknown) => void) | null = null
  onmessage: ((evt: unknown) => void) | null = null
  onclose: ((evt: unknown) => void) | null = null
  onerror: ((evt: unknown) => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code: 1000, reason: 'closed by the harness' })
  }

  addEventListener(_type: string, _handler: (evt: unknown) => void): void {}
  removeEventListener(_type: string, _handler: (evt: unknown) => void): void {}
}

/** A body the page's `fetch` chain can consume. */
export type FetchRoutes = Record<string, unknown>

/**
 * `fetch`, resolving from a fixed route table.
 *
 * A route value of `'reject'` (or a missing route) rejects, which is how the
 * page's `.catch` branches — "Cost report unavailable", "Server uptime
 * unavailable" — get exercised. Anything else resolves 200 with that value as
 * the parsed JSON, so the page cannot tell it from the real endpoints.
 */
function makeFetch(routes: FetchRoutes): (url: string) => Promise<unknown> {
  return (url: string) => {
    const route = Object.hasOwn(routes, url) ? routes[url] : undefined
    if (route === 'reject' || route === undefined) {
      return Promise.reject(new Error(`harness has no route for ${url}`))
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(route),
      text: () => Promise.resolve(JSON.stringify(route)),
    })
  }
}

/** How a loaded page should be driven, and what it has already been given. */
export interface LoadOptions {
  /** Body per URL for the page's `fetch`. Defaults to both endpoints failing. */
  routes?: FetchRoutes
}

/** A page that has been loaded and can be driven. */
export interface LoadedPage {
  readonly document: FakeDocument
  readonly socket: FakeWebSocket
  /**
   * The element the page resolved by id.
   *
   * Throws rather than returning `undefined` for an id the markup lacks: every
   * caller wants a node, and a test that silently read `undefined?.textContent`
   * would assert nothing at all.
   */
  element(id: string): FakeElement
  /** `textContent` of the element the page resolved by id. */
  text(id: string): string
  /** `innerHTML` of the element the page resolved by id. */
  html(id: string): string
  /** The `value` property of the element the page resolved by id. */
  value(id: string): string
  /**
   * A rendered key/value panel as a map, for asserting on ONE row.
   *
   * The config panel is the one place the page renders a labelled key/value
   * table, and asserting on it by substring means either pinning the exact
   * markup (`config-val ">4`) or matching a value that appears somewhere else
   * too — `$1.00` is a substring of `$10.00`, so a substring probe for one
   * budget key is satisfied by another. Reading the rows as a map makes the
   * probe say what it means: the row whose key is `maxRetries` reads `4`.
   *
   * An element that is not a key/value panel yields an empty map, so a probe
   * against the wrong id fails on the missing key rather than passing.
   */
  configRows(id: string): Record<string, string>
  /** The page's activity log, as one string, in the order the page wrote it. */
  activityLog(): string
  /**
   * The activity log's message texts, newest first.
   *
   * `addLog` builds each entry as `<span class="log-time">…<span class="log-msg">…`,
   * so the message is recoverable from the entry's markup. Read as text rather
   * than as a property because these are exactly the lines a user diagnoses a
   * frozen dashboard from, and a test should assert on what they would read.
   */
  activityMessages(): string[]
  /** The page's technical log stream, as one string. */
  logStream(): string
  /** Simulate the socket opening: fires the page's `onopen` handler. */
  open(): void
  /** Deliver one frame to the page's own `ws.onmessage`. */
  deliver(frame: unknown): void
  /** Deliver a raw, possibly non-JSON, frame. */
  deliverRaw(data: string): void
  /** Let the page's `fetch().then().then().catch()` chains settle. */
  settle(): Promise<void>
}

const INERT_TIMER = 0

/**
 * Read the page, build a DOM for it, and run it.
 *
 * The script is handed its globals as PARAMETERS rather than assigned onto
 * `globalThis`, so the page runs in a scope nothing else can reach into and one
 * test's DOM cannot leak into another's. The script is a single IIFE, so
 * evaluating the function body runs the page exactly as a browser evaluating the
 * inline `<script>` would — including the `'use strict'` it opts into, and
 * including `var` hoisting, which is the whole point.
 *
 * Timers are inert on purpose. The page arms a 1s `setInterval` and a 5s
 * auto-refresh `setInterval`; running them would make the test nondeterministic
 * and time-dependent for no gain, since every code path they reach is reachable
 * by delivering a frame directly. `setTimeout` still returns a truthy token,
 * because the page's reconnect guard tests the token for truthiness.
 */
export async function loadDashboardPage(options: LoadOptions = {}): Promise<LoadedPage> {
  const html = await readDashboardHtml()
  const script = extractInlineScript(html)

  // Ids come from the markup, not from the page's own `getElementById` calls:
  // deriving the table from the page would make every lookup succeed by
  // construction and the whole exercise vacuous.
  const markupIds = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1] as string)
  const document = new FakeDocument(markupIds)

  const run = new Function(
    'document',
    'WebSocket',
    'fetch',
    'location',
    'localStorage',
    'setInterval',
    'clearInterval',
    'setTimeout',
    'clearTimeout',
    script,
  )

  const fetchStub = makeFetch(options.routes ?? {})

  run(
    document,
    FakeWebSocket,
    fetchStub,
    { hostname: '127.0.0.1', port: '8080', protocol: 'http:', href: 'http://127.0.0.1:8080/' },
    {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
      clear: () => undefined,
    },
    () => INERT_TIMER,
    () => undefined,
    () => INERT_TIMER + 1,
    () => undefined,
  )

  const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]
  if (socket === undefined) {
    throw new Error('the page did not construct a WebSocket; connect() never ran')
  }

  const element = (id: string): FakeElement => {
    const found = document.getElementById(id)
    if (found === null) {
      throw new Error(
        `no element with id "${id}" in dashboard/index.html — a test asked for one the page does not define`,
      )
    }
    return found
  }

  /** Children of a container, oldest first, as one searchable string. */
  const contentsOf = (id: string): string =>
    element(id)
      .children.map((child) => child.innerHTML)
      .join('\n')

  /**
   * The page's key/value rows, as a map.
   *
   * Reads the markup the page actually built rather than a structure it was
   * never told about, so it is the rendered output that is under test — which is
   * the whole subject here. The class names are quoted in the pattern so a
   * value containing markup cannot terminate the match early.
   */
  const configRows = (id: string): Record<string, string> => {
    const rows: Record<string, string> = {}
    // `config-val` with an OPTIONAL class: the page emits `config-val unreported`,
    // `config-val disabled` and a bare `config-val ` for the neutral case, and a
    // pattern that required the separator would silently match none of the last
    // two — which is how a probe against the right row would fail for a reason
    // that has nothing to do with the field under test.
    const pattern =
      /<span class="config-key">([\s\S]*?)<\/span><span class="config-val[^"]*">([\s\S]*?)<\/span>/g
    for (const row of element(id).innerHTML.matchAll(pattern)) {
      rows[row[1] as string] = row[2] as string
    }
    return rows
  }

  return {
    document,
    socket,
    element,
    text: (id) => element(id).textContent,
    html: (id) => element(id).innerHTML,
    value: (id) => element(id).value,
    configRows,
    activityLog: () => contentsOf('log-container'),
    activityMessages: () =>
      element('log-container')
        .children.map((child) => /class="log-msg">([\s\S]*?)<\/span>/.exec(child.innerHTML)?.[1] ?? '')
        .filter((message) => message !== ''),
    logStream: () => contentsOf('log-stream-container'),
    open: () => socket.onopen?.({ type: 'open' }),
    deliver: (frame) => socket.onmessage?.({ data: JSON.stringify(frame) }),
    deliverRaw: (data) => socket.onmessage?.({ data }),
    settle: () => new Promise<void>((resolve) => setImmediate(resolve)),
  }
}
