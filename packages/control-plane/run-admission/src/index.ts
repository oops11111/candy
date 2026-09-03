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
   * Record one assertion's nonce as spent.
   *
   * Returns true when this nonce had not been seen, and false when it had —
   * which denies the run. The store is tenant-partitioned and durable in a
   * real deployment; this module never retries a spent nonce.
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
}

/**
 * Why a run was not admitted, tagged by the step that denied it.
 *
 * The stage is for operator diagnostics; every value denies the run, and a
 * caller cannot retry into a weaker check.
 */
export type RunRejection =
  | { readonly stage: 'assertion'; readonly reason: ExecutionAssertionRejection }
  | { readonly stage: 'replay'; readonly reason: 'nonce-already-spent' }
  | { readonly stage: 'credential'; readonly reason: 'not-found' | CredentialRejection }

/**
 * The outcome of one scheduling attempt.
 *
 * Both branches carry `audits`, and that is the point: a denied run is the
 * event an audit trail exists to record. A refused token, a replayed nonce,
 * and above all a credential the vault refused to open for this tenant are
 * what an operator needs afterwards, so no path here discards a record the
 * vault produced. `openCredential` returns an audit on its failing branch as
 * well as its succeeding one; dropping the failing one would lose exactly the
 * cross-tenant access attempt the vault detected.
 */
export type RunAdmission =
  | { readonly admitted: true; readonly run: AdmittedRun; readonly audits: readonly CredentialAuditEvent[] }
  | {
    readonly admitted: false
    readonly rejection: RunRejection
    /** Every audit record the attempt produced; empty when it was refused before the vault was reached. */
    readonly audits: readonly CredentialAuditEvent[]
  }

/**
 * Admit one run, or say which step denied it.
 *
 * Steps run in this order, and the order is the contract. The assertion is
 * verified first, so nothing downstream sees an unauthenticated claim. The
 * nonce is spent second, so a replayed token cannot drive repeated credential
 * reads even though it would fail later anyway. The credential is opened
 * third, under the binding the claims carry. The pool is resolved last,
 * because it needs no secret.
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

  if (!await policy.spendNonce(claims)) {
    return { admitted: false, rejection: { stage: 'replay', reason: 'nonce-already-spent' }, audits: [] }
  }

  const envelope = await policy.findCredential(claims)
  if (envelope === undefined) {
    return { admitted: false, rejection: { stage: 'credential', reason: 'not-found' }, audits: [] }
  }
  const binding = { userId: claims.userId, accountId: claims.accountId }
  const opened = openCredential(envelope, binding, policy.keyring, now)
  if (!opened.opened) {
    // The vault recorded this refusal; a binding mismatch here is a tenant
    // reaching for another tenant's credential, which must not go unlogged.
    return { admitted: false, rejection: { stage: 'credential', reason: opened.rejection }, audits: [opened.audit] }
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
    },
  }
}
