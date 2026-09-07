import { describe, expect, it } from 'vitest'
import {
  assertRunBudget,
  assertRunSpend,
  hasRemainingBudget,
  reserveChild,
  type RunBudget,
  type RunSpend,
} from '../src/index.ts'

function budget(overrides: Partial<RunBudget> = {}): RunBudget {
  return { tokens: 1_000, wallMs: 60_000, costMicroUsd: 500_000, children: 2, ...overrides }
}

function spend(overrides: Partial<RunSpend> = {}): RunSpend {
  return { tokens: 0, wallMs: 0, costMicroUsd: 0, ...overrides }
}

describe('reserveChild', () => {
  it('takes the child allowance out of the parent, its own slots included', () => {
    // The parent holds two slots and pays both: one for this child, one for
    // the grandchild the child may itself delegate.
    const reservation = reserveChild(budget(), budget({ tokens: 400, wallMs: 10_000, costMicroUsd: 200_000, children: 1 }))

    expect(reservation).toEqual({
      reserved: true,
      child: { tokens: 400, wallMs: 10_000, costMicroUsd: 200_000, children: 1 },
      parent: { tokens: 600, wallMs: 50_000, costMicroUsd: 300_000, children: 0 },
    })
  })

  it('stops a parent handing out the same tokens twice', () => {
    const first = reserveChild(budget({ tokens: 1_000 }), budget({ tokens: 700, children: 0 }))
    expect(first.reserved).toBe(true)
    if (!first.reserved) return

    const second = reserveChild(first.parent, budget({ tokens: 700, children: 0 }))

    expect(second).toEqual({
      reserved: false,
      denial: { dimension: 'tokens', requested: 700, available: 300 },
    })
  })

  it.each([
    ['tokens', { tokens: 2_000 }],
    ['wallMs', { wallMs: 90_000 }],
    ['costMicroUsd', { costMicroUsd: 900_000 }],
  ])('refuses a request that exceeds the parent in %s', (dimension, over) => {
    const reservation = reserveChild(budget(), budget({ ...over, children: 0 }))

    expect(reservation).toMatchObject({ reserved: false, denial: { dimension } })
  })

  it('refuses when the parent holds no child slot', () => {
    expect(reserveChild(budget({ children: 0 }), budget({ tokens: 1, wallMs: 1, costMicroUsd: 1, children: 0 })))
      .toEqual({ reserved: false, denial: { dimension: 'children', requested: 1, available: 0 } })
  })

  it('refuses a child that would hand down more slots than its parent holds', () => {
    // Charging only the slot this child occupies would leave concurrency
    // unbounded across a tree: every level would hand down authority no level
    // had paid for.
    const reservation = reserveChild(budget({ children: 1 }), budget({ tokens: 1, wallMs: 1, costMicroUsd: 1, children: 5 }))

    expect(reservation).toEqual({
      reserved: false,
      denial: { dimension: 'children', requested: 6, available: 1 },
    })
  })

  it('bounds a whole subtree by the slots its root was granted', () => {
    // Four slots buy four childless children, or one child that may run three
    // of its own, and no arrangement in between exceeds four live runs.
    const share = { tokens: 1, wallMs: 1, costMicroUsd: 1 }
    let parent = budget({ children: 4 })
    let admitted = 0
    for (;;) {
      const reservation = reserveChild(parent, { ...share, children: 0 })
      if (!reservation.reserved) break
      parent = reservation.parent
      admitted += 1
    }

    expect(admitted).toBe(4)
    expect(reserveChild(budget({ children: 4 }), { ...share, children: 3 }))
      .toMatchObject({ reserved: true, parent: { children: 0 } })
    expect(reserveChild(budget({ children: 4 }), { ...share, children: 4 }))
      .toMatchObject({ reserved: false, denial: { dimension: 'children', requested: 5, available: 4 } })
  })

  it('refuses rather than shrinking the request', () => {
    const reservation = reserveChild(budget({ tokens: 100 }), budget({ tokens: 500, children: 0 }))

    // A child quietly started on a fifth of what it asked for stops mid-task
    // for reasons nothing records.
    expect(reservation.reserved).toBe(false)
  })

  it('allows a child to take everything the parent has', () => {
    const parent = budget({ tokens: 10, wallMs: 10, costMicroUsd: 10, children: 1 })

    const reservation = reserveChild(parent, { tokens: 10, wallMs: 10, costMicroUsd: 10, children: 0 })

    expect(reservation).toMatchObject({
      reserved: true,
      parent: { tokens: 0, wallMs: 0, costMicroUsd: 0, children: 0 },
    })
  })
})

describe('hasRemainingBudget', () => {
  it('is true while every consumable dimension is above zero', () => {
    expect(hasRemainingBudget(budget())).toBe(true)
  })

  it.each([['tokens'], ['wallMs'], ['costMicroUsd']] as const)('is false once %s reaches zero', (dimension) => {
    expect(hasRemainingBudget(budget({ [dimension]: 0 }))).toBe(false)
  })

  it('ignores child slots, which cannot make a run progress', () => {
    expect(hasRemainingBudget(budget({ children: 0 }))).toBe(true)
  })
})

describe('a budget that is not made of non-negative safe integers', () => {
  it.each([['tokens'], ['wallMs'], ['costMicroUsd'], ['children']] as const)(
    'is rejected for a negative %s', (dimension) => {
      expect(() => { assertRunBudget(budget({ [dimension]: -1 })) }).toThrow(RangeError)
    },
  )

  it.each([
    ['a fraction', 1.5],
    ['beyond safe integer range', Number.MAX_SAFE_INTEGER + 2],
    ['not a number', Number.NaN],
  ])('is rejected for a token count that is %s', (_case, tokens) => {
    expect(() => { assertRunBudget(budget({ tokens })) }).toThrow(RangeError)
  })

  it('names the argument and field that was wrong', () => {
    expect(() => { assertRunBudget(budget({ costMicroUsd: -5 }), 'parent') })
      .toThrow(/parent\.costMicroUsd/)
  })

  it.each([['tokens'], ['wallMs'], ['costMicroUsd']] as const)('is rejected as a spend for a negative %s', (dimension) => {
    expect(() => { assertRunSpend(spend({ [dimension]: -1 })) }).toThrow(RangeError)
  })

  it.each([
    ['reserveChild parent', () => reserveChild(budget({ tokens: -1 }), budget())],
    ['reserveChild request', () => reserveChild(budget(), budget({ tokens: -1 }))],
    ['hasRemainingBudget', () => hasRemainingBudget(budget({ tokens: -1 }))],
  ])('reaches every operation through %s', (_case, call) => {
    expect(call).toThrow(RangeError)
  })
})

describe('a delegation tree', () => {
  it('cannot spend more than the run that started it held', () => {
    const root = budget({ tokens: 1_000, wallMs: 1_000, costMicroUsd: 1_000, children: 4 })
    let parent = root
    const children: RunBudget[] = []

    // Four children, each asking for a third of the root's tokens.
    for (let index = 0; index < 4; index += 1) {
      const reservation = reserveChild(parent, { tokens: 333, wallMs: 100, costMicroUsd: 100, children: 0 })
      if (!reservation.reserved) continue
      children.push(reservation.child)
      parent = reservation.parent
    }

    // The fourth is refused: three have already taken 999 of 1000 tokens.
    expect(children).toHaveLength(3)
    const delegated = children.reduce((total, child) => total + child.tokens, 0)
    expect(delegated + parent.tokens).toBe(root.tokens)
  })
})
