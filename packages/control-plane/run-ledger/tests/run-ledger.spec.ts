import { RunId } from '@deepseek-ai/dsh-control-plane'
import type { RunBudget, RunSpend } from '@deepseek-ai/dsh-run-budget'
import { describe, expect, it } from 'vitest'
import { RunLedger } from '../src/index.ts'

const ROOT = RunId('run-root')
const CHILD = RunId('run-child')
const GRANDCHILD = RunId('run-grandchild')
const NOW = 1_800_000_000_000
const LEASE = NOW + 60_000

function budget(overrides: Partial<RunBudget> = {}): RunBudget {
  return { tokens: 1_000, wallMs: 60_000, costMicroUsd: 500_000, children: 2, ...overrides }
}

/** A child-sized allowance: small in every dimension so siblings fit beside it. */
function share(overrides: Partial<RunBudget> = {}): RunBudget {
  return { tokens: 100, wallMs: 1_000, costMicroUsd: 10_000, children: 0, ...overrides }
}

function spend(overrides: Partial<RunSpend> = {}): RunSpend {
  return { tokens: 0, wallMs: 0, costMicroUsd: 0, ...overrides }
}

/** A ledger holding one open root, which every case starts from. */
function rooted(overrides: Partial<RunBudget> = {}): RunLedger {
  const ledger = new RunLedger()
  const opened = ledger.openRoot(ROOT, budget(overrides), LEASE)
  if (!opened.ok) throw new Error('the fixture root did not open')
  return ledger
}

describe('opening a run', () => {
  it('holds the allowance admission granted and has spent nothing', () => {
    const ledger = rooted()

    expect(ledger.get(ROOT)).toEqual({
      runId: ROOT,
      parentRunId: undefined,
      reserved: budget(),
      spent: spend(),
      leaseExpiresAt: LEASE,
    })
    expect(ledger.remaining(ROOT)).toEqual(budget())
  })

  it('refuses to reopen a run that is already holding one', () => {
    const ledger = rooted()

    expect(ledger.openRoot(ROOT, budget(), LEASE))
      .toEqual({ ok: false, rejection: { reason: 'duplicate-run', runId: ROOT } })
  })

  it('holds a child allowance out of its parent before the child can spend', () => {
    const ledger = rooted()

    const child = ledger.openChild(ROOT, CHILD, share({ tokens: 400 }), LEASE)

    expect(child).toMatchObject({ ok: true, value: { parentRunId: ROOT, reserved: { tokens: 400 } } })
    // The hold is the enforcement: the parent cannot promise these tokens to a
    // second child while this one is open.
    expect(ledger.remaining(ROOT)).toMatchObject({ tokens: 600, children: 1 })
  })

  it('refuses a child its parent cannot fund and changes nothing', () => {
    const ledger = rooted({ tokens: 100 })

    const child = ledger.openChild(ROOT, CHILD, share({ tokens: 500 }), LEASE)

    expect(child).toMatchObject({ ok: false, rejection: { reason: 'parent-exhausted', denial: { dimension: 'tokens' } } })
    expect(ledger.remaining(ROOT)).toEqual(budget({ tokens: 100 }))
    expect(ledger.get(CHILD)).toBeUndefined()
  })

  it('refuses a child of a run this ledger does not hold', () => {
    const ledger = rooted()

    expect(ledger.openChild(RunId('run-absent'), CHILD, share(), LEASE))
      .toEqual({ ok: false, rejection: { reason: 'unknown-run', runId: RunId('run-absent') } })
  })

  it('refuses a child id already open, leaving the parent untouched', () => {
    const ledger = rooted()
    ledger.openChild(ROOT, CHILD, share({ tokens: 100 }), LEASE)
    const before = ledger.remaining(ROOT)

    expect(ledger.openChild(ROOT, CHILD, share({ tokens: 100 }), LEASE))
      .toEqual({ ok: false, rejection: { reason: 'duplicate-run', runId: CHILD } })
    expect(ledger.remaining(ROOT)).toEqual(before)
  })

  it('rejects a budget that is not made of non-negative safe integers', () => {
    expect(() => new RunLedger().openRoot(ROOT, budget({ tokens: -1 }), LEASE)).toThrow(RangeError)
    expect(() => rooted().openChild(ROOT, CHILD, share({ tokens: -1 }), LEASE)).toThrow(/request\.tokens/)
  })
})

describe('charging a run', () => {
  it('records what it consumed and leaves it free to continue', () => {
    const ledger = rooted()

    const charged = ledger.charge(ROOT, spend({ tokens: 250, costMicroUsd: 100_000 }))

    expect(charged).toMatchObject({ ok: true, value: { exhausted: [] } })
    expect(ledger.remaining(ROOT)).toMatchObject({ tokens: 750, costMicroUsd: 400_000 })
  })

  it('accumulates across charges', () => {
    const ledger = rooted()

    ledger.charge(ROOT, spend({ tokens: 100 }))
    ledger.charge(ROOT, spend({ tokens: 40 }))

    expect(ledger.get(ROOT)?.spent).toEqual(spend({ tokens: 140 }))
  })

  it('records a spend that overdraws rather than refusing it', () => {
    const ledger = rooted({ tokens: 100 })

    const charged = ledger.charge(ROOT, spend({ tokens: 250 }))

    // The provider billed 250 tokens whatever the ledger says. Declining to
    // record them would leave the run reporting allowance it has already used.
    expect(charged).toMatchObject({ ok: true, value: { record: { spent: { tokens: 250 } }, exhausted: ['tokens'] } })
    expect(ledger.remaining(ROOT)?.tokens).toBe(0)
  })

  it('names every dimension the run has used in full', () => {
    const ledger = rooted({ tokens: 10, wallMs: 10, costMicroUsd: 10 })

    const charged = ledger.charge(ROOT, { tokens: 10, wallMs: 5, costMicroUsd: 99 })

    expect(charged).toMatchObject({ ok: true, value: { exhausted: ['tokens', 'costMicroUsd'] } })
  })

  it('refuses to charge a run it does not hold', () => {
    expect(new RunLedger().charge(ROOT, spend({ tokens: 1 })))
      .toEqual({ ok: false, rejection: { reason: 'unknown-run', runId: ROOT } })
  })

  it('rejects a spend that is not made of non-negative safe integers', () => {
    expect(() => rooted().charge(ROOT, spend({ tokens: -1 }))).toThrow(RangeError)
  })
})

describe('closing a run', () => {
  it('releases the hold and charges the parent for what the child used', () => {
    const ledger = rooted()
    ledger.openChild(ROOT, CHILD, share({ tokens: 400, wallMs: 10_000, costMicroUsd: 200_000 }), LEASE)
    ledger.charge(CHILD, spend({ tokens: 100, wallMs: 4_000, costMicroUsd: 50_000 }))

    const settled = ledger.close(CHILD)

    expect(settled).toEqual({
      ok: true,
      value: {
        runId: CHILD,
        spent: { tokens: 100, wallMs: 4_000, costMicroUsd: 50_000 },
        closed: [],
        parentRemaining: { tokens: 900, wallMs: 56_000, costMicroUsd: 450_000, children: 2 },
      },
    })
    expect(ledger.get(CHILD)).toBeUndefined()
  })

  it('charges the parent only what it authorized when a child overdrew', () => {
    const ledger = rooted()
    ledger.openChild(ROOT, CHILD, share({ tokens: 100 }), LEASE)
    ledger.charge(CHILD, spend({ tokens: 250 }))

    const settled = ledger.close(CHILD)

    // The overspend is real and the settlement reports it; the parent absorbs
    // its reservation and no more, so a sibling's allowance is not taken by it.
    expect(settled).toMatchObject({ ok: true, value: { spent: { tokens: 250 } } })
    expect(ledger.remaining(ROOT)?.tokens).toBe(900)
  })

  it('reports a root run with no parent to credit', () => {
    const ledger = rooted()
    ledger.charge(ROOT, spend({ tokens: 10 }))

    expect(ledger.close(ROOT)).toMatchObject({
      ok: true,
      value: { spent: { tokens: 10 }, parentRemaining: undefined },
    })
    expect(ledger.open()).toEqual([])
  })

  it('closes descendants with it and reports the subtree total', () => {
    const ledger = rooted()
    ledger.openChild(ROOT, CHILD, share({ tokens: 400, children: 1 }), LEASE)
    ledger.openChild(CHILD, GRANDCHILD, share({ tokens: 200 }), LEASE)
    ledger.charge(GRANDCHILD, spend({ tokens: 30 }))
    ledger.charge(CHILD, spend({ tokens: 20 }))

    const settled = ledger.close(CHILD)

    // A hold left behind a closed run is a hold nothing will ever settle.
    expect(settled).toMatchObject({ ok: true, value: { spent: { tokens: 50 }, closed: [GRANDCHILD] } })
    expect(ledger.open().map(record => record.runId)).toEqual([ROOT])
    expect(ledger.remaining(ROOT)?.tokens).toBe(950)
  })

  it('refuses to close a run it does not hold', () => {
    expect(new RunLedger().close(ROOT))
      .toEqual({ ok: false, rejection: { reason: 'unknown-run', runId: ROOT } })
  })

  it('returns everything when a child spent nothing', () => {
    const ledger = rooted()
    const before = ledger.remaining(ROOT)
    ledger.openChild(ROOT, CHILD, share({ tokens: 400 }), LEASE)

    ledger.close(CHILD)

    expect(ledger.remaining(ROOT)).toEqual(before)
  })
})

describe('a lease that runs out', () => {
  it('settles the run exactly, because every charge went through the ledger', () => {
    const ledger = rooted()
    ledger.openChild(ROOT, CHILD, share({ tokens: 400 }), NOW + 1_000)
    ledger.charge(CHILD, spend({ tokens: 120 }))

    const expired = ledger.expire(NOW + 1_001)

    // Nothing is estimated: the ledger knows what the lost run consumed.
    expect(expired).toMatchObject([{ runId: CHILD, spent: { tokens: 120 } }])
    expect(ledger.remaining(ROOT)?.tokens).toBe(880)
  })

  it('leaves a run whose lease has not elapsed', () => {
    const ledger = rooted()
    ledger.openChild(ROOT, CHILD, share({ tokens: 400 }), NOW + 1_000)

    expect(ledger.expire(NOW + 999)).toEqual([])
    expect(ledger.get(CHILD)).toBeDefined()
  })

  it('settles the earliest lease first', () => {
    const ledger = rooted()
    ledger.openChild(ROOT, CHILD, share({ tokens: 100 }), NOW + 2_000)
    ledger.openChild(ROOT, GRANDCHILD, share({ tokens: 100 }), NOW + 1_000)

    expect(ledger.expire(NOW + 3_000).map(settlement => settlement.runId)).toEqual([GRANDCHILD, CHILD])
  })

  it('settles an expired run once, with its descendants, not again on its own', () => {
    const ledger = rooted()
    ledger.openChild(ROOT, CHILD, share({ tokens: 400, children: 1 }), NOW + 1_000)
    ledger.openChild(CHILD, GRANDCHILD, share({ tokens: 200 }), NOW + 1_000)

    const expired = ledger.expire(NOW + 2_000)

    expect(expired).toHaveLength(1)
    expect(expired[0]).toMatchObject({ runId: CHILD, closed: [GRANDCHILD] })
    expect(ledger.open().map(record => record.runId)).toEqual([ROOT])
  })

  it('is renewed by a run that is still working', () => {
    const ledger = rooted()
    ledger.openChild(ROOT, CHILD, share({ tokens: 400 }), NOW + 1_000)

    expect(ledger.renew(CHILD, NOW + 5_000)).toMatchObject({ ok: true, value: { leaseExpiresAt: NOW + 5_000 } })
    expect(ledger.expire(NOW + 2_000)).toEqual([])
  })

  it('refuses to renew a run it does not hold', () => {
    expect(new RunLedger().renew(ROOT, LEASE))
      .toEqual({ ok: false, rejection: { reason: 'unknown-run', runId: ROOT } })
  })

  it('expires a root, which has nothing to credit', () => {
    const ledger = new RunLedger()
    ledger.openRoot(ROOT, budget(), NOW)

    expect(ledger.expire(NOW)).toMatchObject([{ runId: ROOT, parentRemaining: undefined }])
  })
})

describe('a tree that loses a run', () => {
  it('cannot outspend the run that started it, even when a child is dropped', () => {
    const ledger = rooted({ tokens: 1_000, children: 3 })
    ledger.openChild(ROOT, CHILD, share({ tokens: 400 }), NOW + 1_000)
    ledger.charge(CHILD, spend({ tokens: 400 }))
    // The child is lost here: it never closes, and its lease is what returns
    // the slot the parent needs for another child.
    ledger.expire(NOW + 1_001)

    const next = ledger.openChild(ROOT, GRANDCHILD, share({ tokens: 600 }), LEASE)

    expect(next.ok).toBe(true)
    // 400 spent by the lost child plus 600 delegated is the whole allowance;
    // nothing was invented by the expiry.
    expect(ledger.remaining(ROOT)?.tokens).toBe(0)
  })

  it('has no remaining allowance to report for a run it does not hold', () => {
    expect(new RunLedger().remaining(ROOT)).toBeUndefined()
  })
})
