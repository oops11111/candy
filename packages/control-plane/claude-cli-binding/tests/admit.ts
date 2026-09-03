/**
 * One admitted run, produced by `admitRun` rather than fabricated.
 *
 * Every spec here builds on a real admission: a binding assembled from a
 * hand-written `AdmittedRun` would prove only that the fields line up, not that
 * the values admission actually produces do.
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import { ConversationId, DeviceId, ProviderAccountId, RunId, UserId, WorkspaceGrantId } from '@deepseek-ai/dsh-control-plane'
import { CredentialKeyVersion, sealCredential, type CredentialKeyring } from '@deepseek-ai/dsh-credential-vault'
import { mintExecutionAssertion, type ExecutionAssertionClaims } from '@deepseek-ai/dsh-execution-assertion'
import { admitRun, type AdmittedRun, type RunAdmission, type RunAdmissionPolicy } from '@deepseek-ai/dsh-run-admission'
import type { RunBudget } from '@deepseek-ai/dsh-run-budget'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** The runtime's assertion secret; every fixture token is minted with it. */
export const ASSERTION_SECRET = Buffer.alloc(32, 3)

/** A fixed clock, so a fixture assertion is neither expired nor future-dated. */
export const NOW = 1_800_000_000_000

/** How long a fixture assertion is valid for. */
export const LIFETIME = 60_000

/** The allowance the fixture budget store answers with. */
export const BUDGET: RunBudget = { tokens: 100_000, wallMs: 600_000, costMicroUsd: 2_500_000, children: 4 }

/** What this runtime admits. */
export const EXPECTATION = {
  issuer: 'candy-control-plane',
  audience: 'candy-runtime-debian-1',
  maxLifetimeMs: LIFETIME,
} as const

const KEY_VERSION = CredentialKeyVersion('2026-09-a')

/** The vault keyring the fixture credential is sealed under. */
export const KEYRING: CredentialKeyring = {
  currentVersion: KEY_VERSION,
  keys: new Map([[KEY_VERSION, Buffer.alloc(32, 5)]]),
}

/**
 * One tenant's claims.
 * @param overrides - fields a case varies, most often the tenant.
 * @returns claims this runtime admits.
 */
export function claims(overrides: Partial<ExecutionAssertionClaims> = {}): ExecutionAssertionClaims {
  return {
    issuer: EXPECTATION.issuer,
    audience: EXPECTATION.audience,
    userId: UserId('user-alice'),
    deviceId: DeviceId('device-1'),
    accountId: ProviderAccountId('account-1'),
    provider: 'claude-cli',
    workspaceGrantId: WorkspaceGrantId('grant-1'),
    conversationId: ConversationId('conversation-1'),
    sessionId: brandString<SessionId>('session-1'),
    runId: RunId('run-1'),
    parentRunId: undefined,
    nonce: `nonce-${String(overrides.userId ?? 'alice')}`,
    issuedAt: NOW,
    expiresAt: NOW + LIFETIME,
    ...overrides,
  }
}

/**
 * Admit one run for real against a caller-chosen pool base.
 * @param secret - the provider credential the vault will hold for this tenant.
 * @param poolBase - the absolute directory every pool root sits under.
 * @param overrides - claims fields this case varies.
 * @returns the admitted run.
 * @throws when the fixture is denied, which is a defect in the fixture rather
 *   than an outcome a case wants to assert here.
 */
export async function admitFor(
  secret: Uint8Array,
  poolBase: string,
  overrides: Partial<ExecutionAssertionClaims> = {},
): Promise<AdmittedRun> {
  const admission = await admissionFor(secret, poolBase, overrides)
  if (!admission.admitted) throw new Error(`the fixture run was denied at ${admission.rejection.stage}`)
  return admission.run
}

/**
 * Admit one run and hand back the outcome, denials included.
 * @param secret - the provider credential the vault will hold for this tenant.
 * @param poolBase - the absolute directory every pool root sits under.
 * @param overrides - claims fields this case varies.
 * @param findBudget - what the deployment answers for this run's allowance;
 *   the fixture budget unless a case supplies a store of its own.
 * @param spendNonce - whether this run's nonce was unseen, and the hook a case
 *   uses to observe whether admission reached the replay store at all.
 * @returns the admission outcome.
 */
export async function admissionFor(
  secret: Uint8Array,
  poolBase: string,
  overrides: Partial<ExecutionAssertionClaims> = {},
  findBudget: RunAdmissionPolicy['findBudget'] = () => Promise.resolve(BUDGET),
  spendNonce: RunAdmissionPolicy['spendNonce'] = () => Promise.resolve(true),
): Promise<RunAdmission> {
  const subject = claims(overrides)
  const policy: RunAdmissionPolicy = {
    expectation: EXPECTATION,
    assertionSecret: ASSERTION_SECRET,
    keyring: KEYRING,
    poolBase,
    findBudget,
    spendNonce,
    findCredential: () => Promise.resolve(
      sealCredential(secret, { userId: subject.userId, accountId: subject.accountId }, KEYRING, NOW).envelope,
    ),
  }
  return admitRun({ token: mintExecutionAssertion(subject, ASSERTION_SECRET) }, policy, NOW)
}
