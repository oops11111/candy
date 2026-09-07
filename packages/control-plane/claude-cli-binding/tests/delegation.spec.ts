/**
 * A child run through the whole chain: admitted against its parent's remaining
 * allowance, then reserved out of it.
 *
 * The two halves are separately correct and only compose one way. `admitRun`
 * asks a deployment for "the allowance this run is started against" and spends
 * a single-use nonce right after; `RunLedger.openChild` holds the child's share
 * against the parent's record. Wiring the ledger into that port is what makes
 * an exhausted parent a denial before the nonce instead of after it.
 */

import { RunId } from '@deepseek-ai/dsh-control-plane'
import { RunLedger } from '@deepseek-ai/dsh-run-ledger'
import { describe, expect, it } from 'vitest'
import { admissionFor, BUDGET, NOW } from './admit.ts'

const POOL_BASE = '/srv/candy/pools'
const PARENT = RunId('run-1')
const CHILD = RunId('run-child')
const LEASE = NOW + 60_000
const KEY = Buffer.from('sk-ant-alice', 'utf8')

/** The child's own share, small enough to sit inside the fixture budget. */
const SHARE = { tokens: 1_000, wallMs: 10_000, costMicroUsd: 100_000, children: 0 }

/** A ledger holding the parent run this tenant already started. */
function withParent(): RunLedger {
  const ledger = new RunLedger()
  const opened = ledger.openRoot(PARENT, BUDGET, LEASE)
  if (!opened.ok) throw new Error('the fixture parent did not open')
  return ledger
}

/** Admit one child, answering its allowance from the ledger as a deployment would. */
async function admitChild(ledger: RunLedger, spent: () => void = () => {}) {
  return admissionFor(
    KEY,
    POOL_BASE,
    { runId: CHILD, parentRunId: PARENT, nonce: 'nonce-child' },
    claims => Promise.resolve(
      claims.parentRunId === undefined ? BUDGET : ledger.remaining(claims.parentRunId),
    ),
    () => {
      spent()
      return Promise.resolve(true)
    },
  )
}

describe('a child run admitted against its parent', () => {
  it('is admitted against what the parent has left, not what the tenant has', async () => {
    const ledger = withParent()
    ledger.charge(PARENT, { tokens: 90_000, wallMs: 0, costMicroUsd: 0 })

    const admission = await admitChild(ledger)

    expect(admission.admitted).toBe(true)
    if (!admission.admitted) return
    // The tenant's own budget is untouched; this is the parent's remainder.
    expect(admission.run.budget.tokens).toBe(BUDGET.tokens - 90_000)
  })

  it('reserves the child out of the parent once it is admitted', async () => {
    const ledger = withParent()
    const admission = await admitChild(ledger)
    if (!admission.admitted) throw new Error('the fixture child is admitted')

    const opened = ledger.openChild(PARENT, admission.run.claims.runId, SHARE, LEASE)

    expect(opened).toMatchObject({ ok: true, value: { parentRunId: PARENT, reserved: SHARE } })
    expect(ledger.remaining(PARENT)).toMatchObject({ tokens: BUDGET.tokens - SHARE.tokens, children: 3 })
  })

  it('is denied before its nonce is spent when the parent is exhausted', async () => {
    const ledger = withParent()
    ledger.charge(PARENT, { tokens: BUDGET.tokens, wallMs: 0, costMicroUsd: 0 })
    let reachedNonce = false

    const admission = await admitChild(ledger, () => { reachedNonce = true })

    // This is the whole point of answering the parent's allowance here: the
    // assertion stays valid, so topping the parent up and presenting it again
    // is a retry rather than a round trip for a fresh token.
    expect(admission).toMatchObject({ admitted: false, rejection: { stage: 'budget', reason: 'exhausted' } })
    expect(reachedNonce).toBe(false)
  })

  it('is denied when the parent is not open at all', async () => {
    const admission = await admitChild(new RunLedger())

    // A ledger that has never heard of the parent answers nothing, which is a
    // denial rather than a permission for the same reason an unknown tenant is.
    expect(admission).toMatchObject({ admitted: false, rejection: { stage: 'budget', reason: 'no-budget' } })
  })

  it('can still be refused its share after admission, which admission cannot promise', async () => {
    const ledger = withParent()
    ledger.charge(PARENT, { tokens: BUDGET.tokens - 1, wallMs: 0, costMicroUsd: 0 })

    const admission = await admitChild(ledger)
    if (!admission.admitted) throw new Error('a parent with one token left still admits a child')
    const opened = ledger.openChild(PARENT, CHILD, SHARE, LEASE)

    // Admission asks whether the run has anything at all to spend, before the
    // size of its request is known; the reservation is where that is settled.
    expect(opened).toMatchObject({ ok: false, rejection: { reason: 'parent-exhausted', denial: { dimension: 'tokens' } } })
  })
})
