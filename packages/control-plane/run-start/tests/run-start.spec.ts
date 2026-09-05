import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  ConversationId,
  DeviceId,
  ProviderAccountId,
  RunId,
  UserId,
  WorkspaceGrantId,
} from '@deepseek-ai/dsh-control-plane'
import {
  CredentialKeyVersion,
  sealCredential,
  type CredentialKeyring,
} from '@deepseek-ai/dsh-credential-vault'
import { mintExecutionAssertion, type ExecutionAssertionClaims } from '@deepseek-ai/dsh-execution-assertion'
import type { RunAdmissionPolicy } from '@deepseek-ai/dsh-run-admission'
import type { RunBudget } from '@deepseek-ai/dsh-run-budget'
import { RunLedger } from '@deepseek-ai/dsh-run-ledger'
import { RunReplayStore } from '@deepseek-ai/dsh-run-replay'
import { runtimePoolRoot } from '@deepseek-ai/dsh-runtime-pool'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startRun } from '../src/index.ts'

const ASSERTION_SECRET = Buffer.alloc(32, 3)
const NOW = 1_800_000_000_000
const LIFETIME = 60_000
const LEASE = NOW + LIFETIME
const BUDGET: RunBudget = { tokens: 100_000, wallMs: 600_000, costMicroUsd: 2_500_000, children: 4 }
const KEY_VERSION = CredentialKeyVersion('2026-09-a')
const KEYRING: CredentialKeyring = { currentVersion: KEY_VERSION, keys: new Map([[KEY_VERSION, Buffer.alloc(32, 5)]]) }
const EXPECTATION = { issuer: 'candy-control-plane', audience: 'candy-runtime-debian-1', maxLifetimeMs: LIFETIME }

let base: string

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'dsh-run-start-'))
  await mkdir(join(base, 'pools'), { mode: 0o700 })
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

function claims(overrides: Partial<ExecutionAssertionClaims> = {}): ExecutionAssertionClaims {
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
    runId: RunId('run-root'),
    parentRunId: undefined,
    nonce: 'nonce-1',
    issuedAt: NOW,
    expiresAt: NOW + LIFETIME,
    ...overrides,
  }
}

function policy(overrides: Partial<RunAdmissionPolicy> = {}): RunAdmissionPolicy {
  const replay = new RunReplayStore()
  return {
    expectation: EXPECTATION,
    assertionSecret: ASSERTION_SECRET,
    keyring: KEYRING,
    poolBase: join(base, 'pools'),
    findBudget: () => Promise.resolve(BUDGET),
    spendNonce: subject => Promise.resolve(replay.spend(subject, NOW)),
    findSessionRun: () => Promise.resolve(undefined),
    findParentIdentity: () => Promise.resolve(undefined),
    findCredential: subject => Promise.resolve(sealCredential(
      Buffer.from('sk-ant-alice', 'utf8'),
      { userId: subject.userId, accountId: subject.accountId },
      KEYRING,
      NOW,
    ).envelope),
    ...overrides,
  }
}

function token(overrides: Partial<ExecutionAssertionClaims> = {}): string {
  return mintExecutionAssertion(claims(overrides), ASSERTION_SECRET)
}

/** A child-sized share, small in every dimension. */
const SHARE: RunBudget = { tokens: 100, wallMs: 1_000, costMicroUsd: 10_000, children: 0 }

function options(ledger: RunLedger, share?: RunBudget) {
  return { ledger, leaseExpiresAt: LEASE, share: share === undefined ? (run: { budget: RunBudget }) => run.budget : () => share }
}

describe('starting a run', () => {
  it('admits, funds, and places it in one call', async () => {
    const ledger = new RunLedger()

    const outcome = await startRun({ token: token() }, policy(), options(ledger), NOW)

    expect(outcome).toMatchObject({ started: true, value: { reserved: BUDGET } })
    if (!outcome.started) return
    const root = runtimePoolRoot(join(base, 'pools'), outcome.value.run.poolKey)
    expect((await stat(root)).mode & 0o777).toBe(0o700)
    expect(ledger.remaining(RunId('run-root'))).toEqual(BUDGET)
  })

  it('carries the vault record admission produced', async () => {
    const outcome = await startRun({ token: token() }, policy(), options(new RunLedger()), NOW)

    expect(outcome.audits).toMatchObject([{ action: 'open', outcome: 'ok' }])
  })

  it('takes a child hold out of its parent', async () => {
    const ledger = new RunLedger()
    ledger.openRoot(RunId('run-root'), BUDGET, LEASE)

    const outcome = await startRun(
      { token: token({ runId: RunId('run-child'), parentRunId: RunId('run-root') }) },
      policy(),
      options(ledger, SHARE),
      NOW,
    )

    expect(outcome).toMatchObject({ started: true, value: { reserved: SHARE } })
    expect(ledger.remaining(RunId('run-root'))).toMatchObject({ tokens: BUDGET.tokens - SHARE.tokens, children: 3 })
  })
})

describe('refusing to start', () => {
  it('reports the admission step that denied it, and funds nothing', async () => {
    const ledger = new RunLedger()

    const outcome = await startRun(
      { token: token() },
      policy({ findBudget: () => Promise.resolve(undefined) }),
      options(ledger),
      NOW,
    )

    expect(outcome).toMatchObject({
      started: false,
      rejection: { stage: 'admission', rejection: { stage: 'budget', reason: 'no-budget' } },
    })
    expect(ledger.open()).toEqual([])
  })

  it('reports a share the parent cannot fund', async () => {
    const ledger = new RunLedger()
    ledger.openRoot(RunId('run-root'), { ...BUDGET, tokens: 1 }, LEASE)

    const outcome = await startRun(
      { token: token({ runId: RunId('run-child'), parentRunId: RunId('run-root') }) },
      policy(),
      options(ledger, SHARE),
      NOW,
    )

    expect(outcome).toMatchObject({
      started: false,
      rejection: { stage: 'ledger', rejection: { reason: 'parent-exhausted', denial: { dimension: 'tokens' } } },
    })
  })

  it('gives a parent its hold back when the placement fails', async () => {
    // `openChild` subtracts the moment the child opens, so a sequence that
    // stops at a failed placement leaves the parent short of an allowance no
    // run is spending until the lease expires.
    const ledger = new RunLedger()
    ledger.openRoot(RunId('run-root'), BUDGET, LEASE)
    const before = ledger.remaining(RunId('run-root'))

    await expect(startRun(
      { token: token({ runId: RunId('run-child'), parentRunId: RunId('run-root') }) },
      policy({ poolBase: join(base, 'never-provisioned') }),
      options(ledger, SHARE),
      NOW,
    )).rejects.toThrow(/does not exist/)

    expect(ledger.remaining(RunId('run-root'))).toEqual(before)
    expect(ledger.open().map(record => record.runId)).toEqual([RunId('run-root')])
  })

  it('leaves no root record behind when the placement fails', async () => {
    const ledger = new RunLedger()

    await expect(startRun(
      { token: token() },
      policy({ poolBase: join(base, 'never-provisioned') }),
      options(ledger),
      NOW,
    )).rejects.toThrow(/does not exist/)

    expect(ledger.open()).toEqual([])
  })
})
