import { describe, expect, it } from 'vitest'
import type { RunBudget, RunSpend } from '@deepseek-ai/dsh-run-budget'
import {
  assertTenantAllowance,
  consumeAllowance,
  openAllowance,
  remainingAllowance,
  type TenantAllowance,
} from '../src/index.ts'

function grant(overrides: Partial<RunBudget> = {}): RunBudget {
  return { tokens: 1_000, wallMs: 60_000, costMicroUsd: 500_000, children: 4, ...overrides }
}

function spend(overrides: Partial<RunSpend> = {}): RunSpend {
  return { tokens: 0, wallMs: 0, costMicroUsd: 0, ...overrides }
}

describe('openAllowance', () => {
  it('opens a grant with nothing consumed against it', () => {
    expect(openAllowance(grant())).toEqual({ grant: grant(), consumed: spend() })
  })

  it('refuses a grant that is not made of non-negative safe integers', () => {
    expect(() => openAllowance(grant({ tokens: -1 }))).toThrow(/grant\.tokens/)
  })
})

describe('assertTenantAllowance', () => {
  it.each([
    ['grant', { grant: grant({ wallMs: 1.5 }), consumed: spend() }, /allowance\.grant\.wallMs/],
    ['consumed', { grant: grant(), consumed: spend({ tokens: -5 }) }, /allowance\.consumed\.tokens/],
  ])('names the half of the record that is unusable: %s', (_half, allowance: TenantAllowance, message) => {
    expect(() => { assertTenantAllowance(allowance) }).toThrow(message)
  })

  it('labels the argument when the caller names it', () => {
    expect(() => { assertTenantAllowance({ grant: grant({ tokens: -1 }), consumed: spend() }, 'stored') })
      .toThrow(/stored\.grant\.tokens/)
  })
})

describe('remainingAllowance', () => {
  it('answers the whole grant while nothing is consumed or held', () => {
    expect(remainingAllowance(openAllowance(grant()), [])).toEqual(grant())
  })

  it('takes what settled runs consumed out of the grant', () => {
    const allowance = consumeAllowance(openAllowance(grant()), spend({ tokens: 400, wallMs: 10_000, costMicroUsd: 200_000 }))

    expect(remainingAllowance(allowance, [])).toEqual({
      tokens: 600,
      wallMs: 50_000,
      costMicroUsd: 300_000,
      children: 4,
    })
  })

  it('stops one grant funding a second run of the same size', () => {
    // The defect this module exists to close: a grant read straight from a
    // store bounds one run, so the same million tokens funded every run the
    // tenant ever started.
    const allowance = consumeAllowance(openAllowance(grant()), spend({ tokens: 1_000 }))

    expect(remainingAllowance(allowance, []).tokens).toBe(0)
  })

  it('holds an open run out of what a second run may start against', () => {
    const held: RunBudget = { tokens: 700, wallMs: 20_000, costMicroUsd: 100_000, children: 0 }

    expect(remainingAllowance(openAllowance(grant()), [held])).toEqual({
      tokens: 300,
      wallMs: 40_000,
      costMicroUsd: 400_000,
      children: 3,
    })
  })

  it('charges a held run for the slots it may hand down as well as its own', () => {
    // The same arithmetic `reserveChild` performs one level lower: a tenant
    // granted four concurrent runs cannot open two that each delegate two.
    const held: RunBudget = { tokens: 0, wallMs: 0, costMicroUsd: 0, children: 2 }

    expect(remainingAllowance(openAllowance(grant()), [held, held]).children).toBe(0)
  })

  it('subtracts every open run, not only the first', () => {
    const held: RunBudget = { tokens: 300, wallMs: 0, costMicroUsd: 0, children: 0 }

    expect(remainingAllowance(openAllowance(grant()), [held, held, held]).tokens).toBe(100)
  })

  it('reads as zero for a tenant that overdrew, rather than as a negative allowance', () => {
    const allowance = consumeAllowance(openAllowance(grant()), spend({ tokens: 4_000, wallMs: 90_000, costMicroUsd: 900_000 }))

    expect(remainingAllowance(allowance, [])).toEqual({ tokens: 0, wallMs: 0, costMicroUsd: 0, children: 4 })
    expect(allowance.consumed.tokens).toBe(4_000)
  })

  it('reads as zero slots when more runs are open than the grant allows', () => {
    const held: RunBudget = { tokens: 0, wallMs: 0, costMicroUsd: 0, children: 0 }

    expect(remainingAllowance(openAllowance(grant({ children: 1 })), [held, held, held]).children).toBe(0)
  })

  it('refuses a stored allowance that is not made of non-negative safe integers', () => {
    expect(() => remainingAllowance({ grant: grant(), consumed: spend({ wallMs: Number.NaN }) }, []))
      .toThrow(/allowance\.consumed\.wallMs/)
  })

  it('refuses a held reservation that is not made of non-negative safe integers', () => {
    expect(() => remainingAllowance(openAllowance(grant()), [grant({ children: -1 })]))
      .toThrow(/held\.children/)
  })
})

describe('consumeAllowance', () => {
  it('adds one settlement to what the tenant has consumed and leaves the grant alone', () => {
    const first = consumeAllowance(openAllowance(grant()), spend({ tokens: 100, wallMs: 5_000, costMicroUsd: 1 }))
    const second = consumeAllowance(first, spend({ tokens: 250, wallMs: 1_000, costMicroUsd: 2 }))

    expect(second).toEqual({
      grant: grant(),
      consumed: { tokens: 350, wallMs: 6_000, costMicroUsd: 3 },
    })
  })

  it('records a settlement that exceeds the grant rather than capping it', () => {
    const allowance = consumeAllowance(openAllowance(grant({ tokens: 10 })), spend({ tokens: 900 }))

    expect(allowance.consumed.tokens).toBe(900)
  })

  it('refuses a settlement that is not made of non-negative safe integers', () => {
    expect(() => consumeAllowance(openAllowance(grant()), spend({ costMicroUsd: -1 })))
      .toThrow(/spent\.costMicroUsd/)
  })

  it('refuses to add to a stored allowance that is already unusable', () => {
    expect(() => consumeAllowance({ grant: grant({ tokens: 0.5 }), consumed: spend() }, spend()))
      .toThrow(/allowance\.grant\.tokens/)
  })
})
