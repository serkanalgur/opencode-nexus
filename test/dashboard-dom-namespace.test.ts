import { describe, expect, it } from 'bun:test'
import {
  FakeDocument,
  HTML_NAMESPACE,
  markupElementsIn,
  SVG_NAMESPACE,
  type MarkupElement,
} from './helpers/dashboard-dom'
import { readDashboardHtml } from './helpers/dashboard-page'

/**
 * The DOM shim's SVG model, tested directly.
 *
 * WHY THIS FILE IS SEPARATE FROM THE PAGE'S OWN TESTS
 *
 * Every other fix for the dashboard-breaking `className` bug lives in the page
 * or in the page-execution tests. Those tests only ever prove that the page
 * does not crash. They cannot prove that the HARNESS is capable of crashing it
 * — a shim that quietly stopped throwing would leave all of them green, and
 * that is precisely the failure this file exists to rule out: a stricter shim
 * with nothing asserting the strictness is decoration.
 *
 * So the shim is the subject here, and the page is the fixture. Every
 * assertion is about the shim's behaviour under a namespace, and the one
 * that matters most is the first: a `className` write on an SVG element throws
 * a real `TypeError`, with a browser's own wording, so that a page which
 * reintroduces the bug is reported the way a user would see it rather than as
 * a bespoke harness error some test could mistake for an expected failure.
 */

/** A shim document over a hand-built markup sample, for the mechanism tests. */
function documentOver(html: string): FakeDocument {
  return new FakeDocument(markupElementsIn(html))
}

function element(id: string, namespaceURI: typeof HTML_NAMESPACE | typeof SVG_NAMESPACE) {
  const described: MarkupElement = { id, tagName: 'X', namespaceURI }
  return new FakeDocument(new Map([[id, described]])).getElementById(id)
}

describe('the shim refuses a className write on an SVG element', () => {
  it('throws a TypeError carrying the browser’s own wording', () => {
    const circle = element('a-circle', SVG_NAMESPACE)
    if (circle === null) throw new Error('shim did not build the element it was asked for')
    // The shape a page actually writes: a plain assignment through a variable
    // holding the element, exactly as the dashboard's own `$gaugeFill.className`
    // was. Optional chaining is not a legal assignment target, so the element
    // is unwrapped first — which is also what the page does.
    expect(() => {
      circle.className = 'fill'
    }).toThrow(TypeError)
    expect(() => {
      circle.className = 'fill'
    }).toThrow('Cannot set property className of #<SVGElement> which has only a getter')
  })

  it('still allows a className write on an HTML element', () => {
    // The counterpart, because a shim that threw everywhere would be useless
    // rather than strict: it would fail the page for a reason no browser has.
    const div = element('a-div', HTML_NAMESPACE)
    if (div === null) throw new Error('shim did not build the element it was asked for')
    div.className = 'gauge-ring'
    expect(div.className).toBe('gauge-ring')
  })

  it('leaves the class untouched when the SVG write is refused', () => {
    // A refused write that still mutated state would be a worse shim than one
    // that throws: a test asserting on the class after catching the TypeError
    // would read a value no browser could produce.
    const circle = element('a-circle', SVG_NAMESPACE)
    if (circle === null) throw new Error('shim did not build the element it was asked for')
    circle.setAttribute('class', 'fill')
    expect(() => {
      circle.className = 'danger'
    }).toThrow(TypeError)
    expect(circle.className).toBe('fill')
  })

  it('allows setAttribute and classList on an SVG element, as a browser does', () => {
    // The two namespace-safe writes, both of which the page now relies on. If
    // either of these threw, the page's fix would be a crash of a different
    // shape and the page tests would say so — but the shim's own contract is
    // worth stating where it is enforced.
    const circle = element('a-circle', SVG_NAMESPACE)
    if (circle === null) throw new Error('shim did not build the element it was asked for')
    circle.setAttribute('class', 'fill')
    expect(circle.className).toBe('fill')
    expect(circle.classList.contains('fill')).toBe(true)
    circle.classList.add('danger')
    expect(circle.className).toBe('fill danger')
  })

  it('treats an element built with createElementNS as SVG', () => {
    // The page does not call this today, so this asserts the shim would still
    // catch the bug if a future edit started building its own SVG. Without it,
    // a shim that only derived namespaces from static markup would be one
    // refactor away from blind again, with nothing to say so.
    const doc = new FakeDocument(new Map())
    const circle = doc.createElementNS(SVG_NAMESPACE, 'circle')
    expect(() => {
      circle.className = 'fill'
    }).toThrow(TypeError)
    const div = doc.createElement('div')
    expect(() => {
      div.className = 'log-entry'
    }).not.toThrow()
  })

  it('still shares one class storage between setAttribute and classList', () => {
    // The property the shim has always had, and the reason the page could
    // standardise on setAttribute without the shim losing track of classes:
    // in a browser these are one value, and two storages would let the page
    // pass here and fail there.
    const div = element('a-div', HTML_NAMESPACE)
    if (div === null) throw new Error('shim did not build the element it was asked for')
    div.setAttribute('class', 'cost-status hidden')
    expect(div.classList.contains('hidden')).toBe(true)
    div.classList.remove('hidden')
    expect(div.className).toBe('cost-status')
  })
})

describe('the shim reads namespaces out of the real markup', () => {
  it('finds the SVG elements by id, and the HTML ones that look like them', async () => {
    // This is the assertion that the DERIVATION works, rather than trusting it.
    // A shim that concluded "nothing on this page is SVG" would be exactly as
    // blind as one that never tried, and every page test would still be green.
    const html = await readDashboardHtml()
    const doc = new FakeDocument(markupElementsIn(html))

    // `#gauge-fill` is the `<circle>` the page writes to; `#gauge-ring` is the
    // `<div>` wrapping its `<svg>`, which the CSS at `.gauge-ring svg` matches
    // on. The two are one line apart in the markup and opposite in namespace.
    expect(doc.resolve('gauge-fill')).toEqual({
      tagName: 'CIRCLE',
      namespaceURI: SVG_NAMESPACE,
    })
    expect(doc.resolve('gauge-ring')).toEqual({
      tagName: 'DIV',
      namespaceURI: HTML_NAMESPACE,
    })
  })

  it('agrees with the page about the whole SVG subtree, not just one id', async () => {
    // One hand-picked id proves the scan works once. This proves it has not
    // quietly stopped: every id the scan places inside the `<svg>` must really
    // be inside it in the source, and `#gauge-fill` must be among them. A scan
    // that returned an empty set would fail on the second half alone.
    const html = await readDashboardHtml()
    const found = markupElementsIn(html)
    const svgIds = [...found.values()].filter((e) => e.namespaceURI === SVG_NAMESPACE)

    expect(svgIds.length).toBeGreaterThan(0)
    expect(svgIds.map((e) => e.id)).toContain('gauge-fill')

    for (const entry of svgIds) {
      const at = html.indexOf(`id="${entry.id}"`)
      expect(at).toBeGreaterThan(-1)
      // Between the `<svg>` that opens the subtree and this id there must be no
      // `</svg>`, or the element is HTML and the scan is wrong.
      const opened = html.lastIndexOf('<svg', at)
      const closed = html.lastIndexOf('</svg>', at)
      expect(opened).toBeGreaterThan(closed)
    }
  })

  it('classifies the real gauge fill as unwritable and the real gauge ring as writable', async () => {
    // The end-to-end consequence on the page's own elements, stated as a fact
    // about them rather than about a sample. This is the pair a regression test
    // would otherwise only reach indirectly, through a render that may or may
    // not take the gauge branch.
    const html = await readDashboardHtml()
    const doc = new FakeDocument(markupElementsIn(html))
    const fill = doc.getElementById('gauge-fill')
    const ring = doc.getElementById('gauge-ring')
    if (fill === null || ring === null) {
      throw new Error('the page no longer defines both gauge elements; this shim model is stale')
    }
    expect(() => {
      fill.className = 'fill'
    }).toThrow(TypeError)
    expect(() => {
      ring.className = 'gauge-ring'
    }).not.toThrow()
  })
})

describe('the markup scanner itself', () => {
  it('handles a nested svg and a self-closing tag without losing depth', () => {
    // Depth bookkeeping is the only part of the scanner with state in it, and
    // an off-by-one there silently reclassifies every later id. `<svg/>` is
    // the case that exposes it: a self-closing root must not open a subtree
    // that never closes.
    const doc = documentOver(
      '<div id="before"></div><svg id="root"/><div id="after"></div><svg id="open"><circle id="in"/></svg><div id="last"></div>',
    )
    expect(doc.resolve('root')?.namespaceURI).toBe(SVG_NAMESPACE)
    expect(doc.resolve('in')?.namespaceURI).toBe(SVG_NAMESPACE)
    expect(doc.resolve('before')?.namespaceURI).toBe(HTML_NAMESPACE)
    expect(doc.resolve('after')?.namespaceURI).toBe(HTML_NAMESPACE)
    expect(doc.resolve('last')?.namespaceURI).toBe(HTML_NAMESPACE)
  })

  it('reports the true tag name, not a stand-in', () => {
    // The shim used to mint every id-bearing element as a `<div>`, which is
    // what let a `<circle>` be written to as if it were a `<div>`. Reporting
    // the real tag is what makes a wrong classification visible to a test.
    const doc = documentOver('<span id="a"></span><svg><circle id="b"/></svg>')
    expect(doc.resolve('a')?.tagName).toBe('SPAN')
    expect(doc.resolve('b')?.tagName).toBe('CIRCLE')
  })

  it('returns null for an id the markup does not define', () => {
    // Kept because a scanner that invented elements would make every
    // namespace assertion above pass for the wrong reason.
    const doc = documentOver('<div id="real"></div>')
    expect(doc.resolve('imaginary')).toBeNull()
  })
})
