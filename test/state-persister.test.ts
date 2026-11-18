import { describe, it, expect } from 'bun:test'
import { createCoalescingWriter, toStorageJson } from '../src/state-persister'

/** A write whose completion the test controls, recording the state it read when it started. */
function controlledWriter(read: () => number) {
  const started: number[] = []
  const finishers: Array<() => void> = []
  const write = () => new Promise<void>((resolve) => {
    started.push(read())
    finishers.push(resolve)
  })
  return { write, started, finish: () => finishers.shift()?.() }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('createCoalescingWriter', () => {
  it('writes immediately when nothing is in flight', async () => {
    let value = 1
    const w = controlledWriter(() => value)
    const persist = createCoalescingWriter(w.write, () => {})
    const done = persist()
    expect(w.started).toEqual([1])
    w.finish()
    await done
  })

  it('coalesces requests made during a write into ONE follow-up carrying the latest state', async () => {
    let value = 1
    const w = controlledWriter(() => value)
    const persist = createCoalescingWriter(w.write, () => {})

    const first = persist()
    value = 2; const second = persist()
    value = 3; const third = persist()
    expect(second).toBe(third)
    expect(w.started).toEqual([1])

    w.finish(); await first; await tick()
    // One follow-up, and it read the state as of when it started: 3, not 2.
    expect(w.started).toEqual([1, 3])
    w.finish(); await third
    expect(w.started).toEqual([1, 3])
  })

  it('settles a request only after a write that started after it has finished', async () => {
    let value = 1
    const w = controlledWriter(() => value)
    const persist = createCoalescingWriter(w.write, () => {})
    void persist()
    value = 2
    let settled = false
    const later = persist().then(() => { settled = true })

    w.finish(); await tick(); await tick()
    expect(settled).toBe(false)
    w.finish(); await later
    expect(settled).toBe(true)
  })

  it('reports a failed write, does not reject, and keeps writing afterwards', async () => {
    const errors: unknown[] = []
    let calls = 0
    const persist = createCoalescingWriter(async () => {
      calls++
      if (calls === 1) throw new Error('storage is down')
    }, (e) => errors.push(e))

    await expect(persist()).resolves.toBeUndefined()
    expect((errors[0] as Error).message).toBe('storage is down')
    await persist()
    expect(calls).toBe(2)
    expect(errors).toHaveLength(1)
  })
})

describe('toStorageJson', () => {
  it('turns Dates into ISO strings and drops undefined, as the old call sites did', () => {
    expect(toStorageJson({ at: new Date('2026-01-02T03:04:05.000Z'), gone: undefined, n: 1 }))
      .toEqual({ at: '2026-01-02T03:04:05.000Z', n: 1 })
  })
})
