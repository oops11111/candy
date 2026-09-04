/**
 * The one path a run takes from a token to a scheduled invocation.
 *
 * {@link admitRun} verifies the execution assertion, spends its nonce, opens
 * the provider credential the assertion names, and resolves the runtime pool
 * that credential may run in. It composes `dsh-execution-assertion`,
 * `dsh-credential-vault`, and `dsh-runtime-pool` so a scheduler has one call
 * to make instead of an order to remember.
 *
 * Identity is taken from the verified claims at every step. {@link RunRequest}
 * carries a token and nothing else — no tenant, account, provider, or pool —
 * so there is no parameter through which a caller could pair a valid assertion
 * with another tenant's credential or another pool's directory. The
 * confused-deputy rule
 * ([Candy Runtime Boundaries](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/candy-runtime-boundaries.md))
 * therefore holds across the composition, not only inside each part.
 *
 * @module @deepseek-ai/dsh-run-admission
 */

import {
  admitExecutionAssertion,
  type ExecutionAssertionClaims,
  type ExecutionAssertionExpectation,
  type ExecutionAssertionRejection,
} from '@deepseek-ai/dsh-execution-assertion'
import {
  openCredential,
  type CredentialAuditEvent,
  type CredentialEnvelope,
  type CredentialKeyring,
  type CredentialRejection,
} from '@deepseek-ai/dsh-credential-vault'
import {
  hasRemainingBudget,
  type RunBudget,
} from '@deepseek-ai/dsh-run-budget'
import {
  runtimePoolKey,
  runtimePoolRoot,
  type RuntimePoolKey,
} from '@deepseek-ai/dsh-runtime-pool'

/** One scheduling attempt: a token, and deliberately nothing else. */
export interface RunRequest {
  /** The execution assertion exactly as received. */
  readonly token: string
}

/**
 * The stores and keys a runtime brings to admission.
 *
 * Each function is a port the deployment satisfies. None of them exists in
 * this repository yet, which is why they are parameters rather than services:
 * naming them here forces a caller to have answered replay and credential
 * lookup before a run can start.
 */
export interface RunAdmissionPolicy {
  /** Issuer, audience, and maximum lifetime this runtime admits. */
  readonly expectation: ExecutionAssertionExpectation
  /** HMAC key the minting control plane shares with this runtime. */
  readonly assertionSecret: Uint8Array
  /** Keys the credential vault seals and opens with. */
  readonly keyring: CredentialKeyring
  /** Absolute directory holding every runtime pool's root. */
  readonly poolBase: string
  /**
   * Look up the allowance this run will be started against.
   *
   * For a root run that is the tenant's remaining allowance. For a child run —
   * one whose claims carry a `parentRunId` — it is the PARENT's remaining
   * allowance, which a deployment reads from its `dsh-run-ledger`. Answering
   * the tenant's budget for a child would make this check meaningless: a tenant
   * with plenty left can have an exhausted parent, and the child would then be
   * refused only when its allowance is reserved — one step after its
   * single-use nonce was spent and its credential opened.
   *
   * The check is "has this run anything at all to spend", not a promise that a
   * particular child request will fit. A parent with one token left admits a
   * child that `RunLedger.openChild` then refuses, which is the residue of
   * checking an allowance before its size is known.
   *
   * Returning `undefined` denies the run: a tenant the budget store does not
   * know is not a tenant with unlimited budget. A deployment that means
   * "unmetered" says so with an explicit large allowance rather than by
   * omitting the record.
   */
  readonly findBudget: (claims: ExecutionAssertionClaims) => Promise<RunBudget | undefined>
  /**
   * Record one assertion's nonce as spent.
   *
   * Returns true when this nonce had not been seen, and false when it had —
   * which denies the run. This module never retries a spent nonce, so the
   * store is the whole of replay protection: it decides in one indivisible
   * step, holds a record while its assertion stays admissible, and partitions
   * by tenant. `dsh-run-replay` satisfies all three for one process; a
   * deployment running more than one needs a durable store that still does.
   */
  readonly spendNonce: (claims: ExecutionAssertionClaims) => Promise<boolean>
  /** Look up the sealed credential for the tenant and account the assertion names. */
  readonly findCredential: (claims: ExecutionAssertionClaims) => Promise<CredentialEnvelope | undefined>
}

/** Everything a provider invocation needs, and nothing a caller chose. */
export interface AdmittedRun {
  /** The verified assertion claims; the source of every identity below. */
  readonly claims: ExecutionAssertionClaims
  /** The opened provider credential. The caller owns its lifetime. */
  readonly secret: Uint8Array
  /** The pool this run's provider process belongs to. */
  readonly poolKey: RuntimePoolKey
  /** The one directory that pool owns. */
  readonly poolRoot: string
  /**
   * The allowance this run was admitted against, exactly as `findBudget`
   * answered it.
   *
   * For a root run it is what the run may spend, and a caller opens it in a
   * ledger with this. For a child run it is the parent's remaining allowance —
   * the ceiling on what could be delegated, not what the child gets, which the
   * caller decides when it reserves the child's own share.
   *
   * Nothing here decrements it: admission is one read, and a spend needs the
   * durable write this module does not own.
   */
  readonly budget: RunBudget
}

/**
 * Why a run was not admitted, tagged by the step that denied it.
 *
 * The stage is for operator diagnostics; every value denies the run, and a
 * caller cannot retry into a weaker check.
 *
 * Every stage past `assertion` carries the verified claims, because a denial
 * a caller cannot attribute is not a record of anything: a replayed nonce is
 * this module's clearest attack signal, and reporting only that some token was
 * replayed leaves the tenant, account, and run out of the caller's log. The
 * claims travel on the stage rather than beside it so that reading them is
 * possible exactly where they exist. The `assertion` stage carries none: it
 * denied the token before any claim was verified, and the unverified payload
 * is the caller-supplied identity this control plane refuses to repeat.
 */
export type RunRejection =
  | { readonly stage: 'assertion'; readonly reason: ExecutionAssertionRejection }
  | {
    readonly stage: 'budget'
    readonly reason: 'no-budget' | 'exhausted'
    readonly claims: ExecutionAssertionClaims
  }
  | {
    readonly stage: 'replay'
    readonly reason: 'nonce-already-spent'
    readonly claims: ExecutionAssertionClaims
  }
  | {
    readonly stage: 'credential'
    readonly reason: 'not-found' | CredentialRejection
    readonly claims: ExecutionAssertionClaims
  }

/**
 * The outcome of one scheduling attempt.
 *
 * Both branches carry `audits`, and that is the point: a credential the vault
 * refused to open for this tenant is what an operator needs afterwards, so no
 * path here discards a record the vault produced. `openCredential` returns an
 * audit on its failing branch as well as its succeeding one; dropping the
 * failing one would lose exactly the cross-tenant access attempt the vault
 * detected.
 *
 * `audits` holds vault records only, so it is empty for a denial that never
 * reached the vault. Those denials are not unrecorded: a refused token, an
 * exhausted budget, and a replayed nonce are reported through `rejection`,
 * which carries the verified claims for every stage that has them.
 */
export type RunAdmission =
  | { readonly admitted: true; readonly run: AdmittedRun; readonly audits: readonly CredentialAuditEvent[] }
  | {
    readonly admitted: false
    readonly rejection: RunRejection
    /** Every vault record the attempt produced; empty when it was refused before the vault was reached. */
    readonly audits: readonly CredentialAuditEvent[]
  }

/**
 * Admit one run, or say which step denied it.
 *
 * Steps run in this order, and the order is the contract. The assertion is
 * verified first, so nothing downstream sees an unauthenticated claim. The
 * budget is read second: it is the one denial a caller can fix and retry, so
 * it must not burn the nonce, and it touches no secret. The nonce is spent
 * third, serializing concurrent duplicates so two copies of one token cannot
 * both reach the credential. The credential is opened fourth, under the
 * binding the claims carry. The pool is resolved last, because it needs no
 * secret.
 *
 * @param request - the scheduling attempt, carrying only a token.
 * @param policy - the runtime's expectation, keys, pool base, and stores.
 * @param now - epoch milliseconds from the caller's clock.
 * @returns the admitted run or the first rejection that denied it, either way
 * with every audit record the attempt produced.
 * @throws RangeError when the assertion secret, a keyring key, or the pool
 * base is unusable, since each is a deployment error rather than a denied run.
 */
export async function admitRun(
  request: RunRequest,
  policy: RunAdmissionPolicy,
  now: number,
): Promise<RunAdmission> {
  const assertion = admitExecutionAssertion(request.token, policy.assertionSecret, policy.expectation, now)
  if (!assertion.admitted) {
    return { admitted: false, rejection: { stage: 'assertion', reason: assertion.rejection }, audits: [] }
  }
  const { claims } = assertion

  // Budget is checked before the nonce is spent, and the order is deliberate.
  // An exhausted budget is the one denial here a caller can fix and retry —
  // topping up and presenting the same still-valid assertion — so burning its
  // single-use token would turn a recoverable refusal into a round trip to the
  // control plane. It is also a cheap read that touches no secret.
  const budget = await policy.findBudget(claims)
  if (budget === undefined) {
    return { admitted: false, rejection: { stage: 'budget', reason: 'no-budget', claims }, audits: [] }
  }
  if (!hasRemainingBudget(budget)) {
    return { admitted: false, rejection: { stage: 'budget', reason: 'exhausted', claims }, audits: [] }
  }

  // The nonce is spent next rather than last: it serializes concurrent
  // duplicates, so two copies of one token cannot both reach the credential.
  if (!await policy.spendNonce(claims)) {
    return { admitted: false, rejection: { stage: 'replay', reason: 'nonce-already-spent', claims }, audits: [] }
  }

  const envelope = await policy.findCredential(claims)
  if (envelope === undefined) {
    return { admitted: false, rejection: { stage: 'credential', reason: 'not-found', claims }, audits: [] }
  }
  const binding = { userId: claims.userId, accountId: claims.accountId }
  const opened = openCredential(envelope, binding, policy.keyring, now)
  if (!opened.opened) {
    // The vault recorded this refusal; a binding mismatch here is a tenant
    // reaching for another tenant's credential, which must not go unlogged.
    return {
      admitted: false,
      rejection: { stage: 'credential', reason: opened.rejection, claims },
      audits: [opened.audit],
    }
  }

  const poolKey = runtimePoolKey({
    userId: claims.userId,
    provider: claims.provider,
    accountId: claims.accountId,
  })
  return {
    admitted: true,
    audits: [opened.audit],
    run: {
      claims,
      secret: opened.secret,
      poolKey,
      poolRoot: runtimePoolRoot(policy.poolBase, poolKey),
      budget,
    },
  }
}
