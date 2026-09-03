import { describe, expect, it } from 'vitest'
import {
  assertRunBudget,
  assertRunSpend,
  BUDGET_DIMENSIONS,
  chargeRun,
  hasRemainingBudget,
  reserveChild,
  settleChild,
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
  it('takes the child allowance out of the parent and holds one slot', () => {
    const reservation = reserveChild(budget(), budget({ tokens: 400, wallMs: 10_000, costMicroUsd: 200_000, children: 1 }))

    expect(reservation).toEqual({
      reserved: true,
      child: { tokens: 400, wallMs: 10_000, costMicroUsd: 200_000, children: 1 },
      parent: { tokens: 600, wallMs: 50_000, costMicroUsd: 300_000, children: 1 },
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

  it('lets a child hold more grandchild slots than its parent has left', () => {
    // Grandchild concurrency is the child's own to spend; only the one slot
    // this child occupies comes out of the parent.
    const reservation = reserveChild(budget({ children: 1 }), budget({ tokens: 1, wallMs: 1, costMicroUsd: 1, children: 5 }))

    expect(reservation).toMatchObject({ reserved: true, child: { children: 5 }, parent: { children: 0 } })
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

describe('settleChild', () => {
  it('returns the unused remainder and the child slot', () => {
    const parent = budget({ tokens: 600, wallMs: 50_000, costMicroUsd: 300_000, children: 1 })
    const reserved = budget({ tokens: 400, wallMs: 10_000, costMicroUsd: 200_000, children: 1 })

    const settled = settleChild(parent, reserved, spend({ tokens: 100, wallMs: 4_000, costMicroUsd: 50_000 }))

    expect(settled).toEqual({ tokens: 900, wallMs: 56_000, costMicroUsd: 450_000, children: 2 })
  })

  it('returns nothing when the child spent its whole reservation', () => {
    const parent = budget({ tokens: 0, children: 0 })
    const reserved = budget({ tokens: 100, wallMs: 100, costMicroUsd: 100, children: 0 })

    const settled = settleChild(parent, reserved, { tokens: 100, wallMs: 100, costMicroUsd: 100 })

    expect(settled).toMatchObject({ tokens: 0, children: 1 })
  })

  it('credits no budget for an overspend', () => {
    const parent = budget({ tokens: 0, wallMs: 0, costMicroUsd: 0, children: 0 })
    const reserved = budget({ tokens: 100, wallMs: 100, costMicroUsd: 100, children: 0 })

    // The tenant has already paid for the overspend; inventing budget back
    // would let the parent spend money twice.
    const settled = settleChild(parent, reserved, { tokens: 250, wallMs: 250, costMicroUsd: 250 })

    expect(settled).toEqual({ tokens: 0, wallMs: 0, costMicroUsd: 0, children: 1 })
  })

  it('round-trips a child that spent nothing', () => {
    const parent = budget()
    const request = budget({ tokens: 400, wallMs: 10_000, costMicroUsd: 200_000, children: 0 })
    const reservation = reserveChild(parent, request)
    expect(reservation.reserved).toBe(true)
    if (!reservation.reserved) return

    expect(settleChild(reservation.parent, reservation.child, spend())).toEqual(parent)
  })

  it('refuses to return a budget outside the safe integer range', () => {
    expect(() => {
      settleChild(
        budget({ children: Number.MAX_SAFE_INTEGER }),
        budget({ tokens: 0, wallMs: 0, costMicroUsd: 0, children: 0 }),
        spend(),
      )
    }).toThrow(/settled\.children/)

    expect(() => {
      settleChild(
        budget({ tokens: Number.MAX_SAFE_INTEGER }),
        budget({ tokens: 1, wallMs: 0, costMicroUsd: 0, children: 0 }),
        spend(),
      )
    }).toThrow(/settled\.tokens/)
  })
})

describe('chargeRun', () => {
  it('deducts what the run consumed', () => {
    expect(chargeRun(budget(), spend({ tokens: 250, wallMs: 5_000, costMicroUsd: 100_000 }))).toEqual({
      charged: true,
      remaining: { tokens: 750, wallMs: 55_000, costMicroUsd: 400_000, children: 2 },
    })
  })

  it('leaves child slots alone', () => {
    const charged = chargeRun(budget({ children: 2 }), spend({ tokens: 1 }))

    expect(charged).toMatchObject({ charged: true, remaining: { children: 2 } })
  })

  it.each([
    ['tokens', { tokens: 1_001 }],
    ['wallMs', { wallMs: 60_001 }],
    ['costMicroUsd', { costMicroUsd: 500_001 }],
  ])('refuses a charge that would overdraw %s', (dimension, over) => {
    expect(chargeRun(budget(), spend(over))).toMatchObject({ charged: false, denial: { dimension } })
  })

  it('deducts nothing at all when it refuses', () => {
    const before = budget()

    const charged = chargeRun(before, spend({ tokens: 10, costMicroUsd: 900_000 }))

    // A caller that stops on a denial must not find its budget partly spent
    // by the charge it rejected.
    expect(charged.charged).toBe(false)
    expect(before).toEqual(budget())
  })

  it('allows a charge that exactly exhausts the budget', () => {
    expect(chargeRun(budget({ tokens: 5, wallMs: 5, costMicroUsd: 5 }), { tokens: 5, wallMs: 5, costMicroUsd: 5 }))
      .toMatchObject({ charged: true, remaining: { tokens: 0, wallMs: 0, costMicroUsd: 0 } })
  })

  it('reports the first insufficient dimension in a stable order', () => {
    const charged = chargeRun(budget({ tokens: 0, wallMs: 0 }), spend({ tokens: 1, wallMs: 1 }))

    expect(charged).toMatchObject({ denial: { dimension: 'tokens' } })
    expect(BUDGET_DIMENSIONS[0]).toBe('tokens')
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
    ['settleChild parent', () => settleChild(budget({ tokens: -1 }), budget(), spend())],
    ['settleChild reserved', () => settleChild(budget(), budget({ tokens: -1 }), spend())],
    ['settleChild spent', () => settleChild(budget(), budget(), spend({ tokens: -1 }))],
    ['chargeRun budget', () => chargeRun(budget({ tokens: -1 }), spend())],
    ['chargeRun spend', () => chargeRun(budget(), spend({ tokens: -1 }))],
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

  it('lets a settled child remainder fund the next one', () => {
    const root = budget({ tokens: 100, wallMs: 100, costMicroUsd: 100, children: 1 })
    const request = { tokens: 100, wallMs: 100, costMicroUsd: 100, children: 0 }

    const first = reserveChild(root, request)
    expect(first.reserved).toBe(true)
    if (!first.reserved) return
    // With everything delegated, a second child cannot start.
    expect(reserveChild(first.parent, request).reserved).toBe(false)

    const afterSettle = settleChild(first.parent, first.child, { tokens: 10, wallMs: 10, costMicroUsd: 10 })

    expect(reserveChild(afterSettle, { tokens: 90, wallMs: 90, costMicroUsd: 90, children: 0 }).reserved).toBe(true)
  })
})
