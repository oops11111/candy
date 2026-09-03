import { brandString } from '@deepseek-ai/dsh-brand'
import { ConversationId, DeviceId, ProviderAccountId, RunId, UserId, WorkspaceGrantId } from '@deepseek-ai/dsh-control-plane'
import {
  CredentialKeyVersion,
  sealCredential,
  type CredentialKeyring,
} from '@deepseek-ai/dsh-credential-vault'
import { mintExecutionAssertion, type ExecutionAssertionClaims } from '@deepseek-ai/dsh-execution-assertion'
import { admitRun, type AdmittedRun, type RunAdmissionPolicy } from '@deepseek-ai/dsh-run-admission'
import type { RunBudget } from '@deepseek-ai/dsh-run-budget'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { bindClaudeCliRun, type ClaudeCliDeployment } from '../src/index.ts'

const ASSERTION_SECRET = Buffer.alloc(32, 3)
const KEY_VERSION = CredentialKeyVersion('2026-09-a')
const NOW = 1_800_000_000_000
const LIFETIME = 60_000
const POOL_BASE = '/srv/candy/pools'
const BUDGET: RunBudget = { tokens: 100_000, wallMs: 600_000, costMicroUsd: 2_500_000, children: 4 }

const DEPLOYMENT: ClaudeCliDeployment = { executable: '/opt/candy/bin/claude', graceMs: 5_000 }

const EXPECTATION = {
  issuer: 'candy-control-plane',
  audience: 'candy-runtime-debian-1',
  maxLifetimeMs: LIFETIME,
} as const

const KEYRING: CredentialKeyring = {
  currentVersion: KEY_VERSION,
  keys: new Map([[KEY_VERSION, Buffer.alloc(32, 5)]]),
}

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
    runId: RunId('run-1'),
    parentRunId: undefined,
    nonce: `nonce-${String(overrides.userId ?? 'alice')}`,
    issuedAt: NOW,
    expiresAt: NOW + LIFETIME,
    ...overrides,
  }
}

/** Admit one run for real, so the binding is built from what admission produces. */
async function admitted(secret: Uint8Array, overrides: Partial<ExecutionAssertionClaims> = {}): Promise<AdmittedRun> {
  const subject = claims(overrides)
  const policy: RunAdmissionPolicy = {
    expectation: EXPECTATION,
    assertionSecret: ASSERTION_SECRET,
    keyring: KEYRING,
    poolBase: POOL_BASE,
    findBudget: () => Promise.resolve(BUDGET),
    spendNonce: () => Promise.resolve(true),
    findCredential: () => Promise.resolve(
      sealCredential(secret, { userId: subject.userId, accountId: subject.accountId }, KEYRING, NOW).envelope,
    ),
  }
  const admission = await admitRun({ token: mintExecutionAssertion(subject, ASSERTION_SECRET) }, policy, NOW)
  if (!admission.admitted) throw new Error(`the fixture run was denied at ${admission.rejection.stage}`)
  return admission.run
}

const KEY = Buffer.from('sk-ant-alice', 'utf8')

describe('binding an admitted run to a Claude CLI launch', () => {
  it('takes every tenant-varying value from the admission', async () => {
    const run = await admitted(KEY)

    const result = bindClaudeCliRun(run, DEPLOYMENT)

    expect(result).toEqual({
      bound: true,
      binding: {
        executable: '/opt/candy/bin/claude',
        cwd: run.poolRoot,
        isolation: { home: run.poolRoot, apiKey: 'sk-ant-alice' },
        graceMs: 5_000,
        maxBudgetUsd: 2.5,
        requireCredentialIsolation: true,
      },
    })
  })

  it('gives two tenants different homes and different keys', async () => {
    const alice = await admitted(Buffer.from('sk-ant-alice', 'utf8'))
    const bob = await admitted(Buffer.from('sk-ant-bob', 'utf8'), { userId: UserId('user-bob') })

    const first = bindClaudeCliRun(alice, DEPLOYMENT)
    const second = bindClaudeCliRun(bob, DEPLOYMENT)

    if (!first.bound || !second.bound) throw new Error('both fixture runs are admitted')
    expect(first.binding.isolation.home).not.toBe(second.binding.isolation.home)
    expect(first.binding.isolation.apiKey).not.toBe(second.binding.isolation.apiKey)
  })

  it('puts the process under the pool root the admission resolved, not the deployment base', async () => {
    const run = await admitted(KEY)

    const result = bindClaudeCliRun(run, DEPLOYMENT)

    if (!result.bound) throw new Error('the fixture run is admitted')
    // Confinement is the point: a home left at the shared base would put every
    // tenant's CLI state in one directory.
    expect(result.binding.isolation.home.startsWith(`${POOL_BASE}/`)).toBe(true)
    expect(result.binding.isolation.home).not.toBe(POOL_BASE)
    expect(result.binding.cwd).toBe(result.binding.isolation.home)
  })

  it('derives the spend ceiling from the admitted budget', async () => {
    const run = await admitted(KEY)

    const result = bindClaudeCliRun({ ...run, budget: { ...run.budget, costMicroUsd: 1_234_567 } }, DEPLOYMENT)

    if (!result.bound) throw new Error('the fixture run is admitted')
    expect(result.binding.maxBudgetUsd).toBe(1.234567)
  })

  it('never leaves credential isolation to the deployment', async () => {
    const run = await admitted(KEY)

    const result = bindClaudeCliRun(run, DEPLOYMENT)

    // A run that authenticated with some other credential is billing a tenant
    // that did not authorize it, so no configuration may turn this off.
    if (!result.bound) throw new Error('the fixture run is admitted')
    expect(result.binding.requireCredentialIsolation).toBe(true)
  })

  it('passes the deployment facts through unchanged', async () => {
    const run = await admitted(KEY)

    const result = bindClaudeCliRun(run, { executable: '/usr/local/bin/claude', graceMs: 250 })

    if (!result.bound) throw new Error('the fixture run is admitted')
    expect(result.binding.executable).toBe('/usr/local/bin/claude')
    expect(result.binding.graceMs).toBe(250)
  })
})

describe('a credential that cannot become an environment variable', () => {
  it.each([
    ['empty', new Uint8Array(0), 'empty'],
    ['invalid UTF-8', Uint8Array.from([0x73, 0x6b, 0xff, 0xfe]), 'not-utf8'],
    ['a NUL byte', Buffer.from('sk-ant\0-alice', 'utf8'), 'control-characters'],
    ['a newline', Buffer.from('sk-ant\nALSO=1', 'utf8'), 'control-characters'],
    ['a carriage return', Buffer.from('sk-ant\rALSO=1', 'utf8'), 'control-characters'],
  ])('refuses %s rather than repairing it', async (_case, secret, rejection) => {
    const run = await admitted(KEY)

    const result = bindClaudeCliRun({ ...run, secret }, DEPLOYMENT)

    expect(result).toEqual({ bound: false, rejection })
  })

  it('produces no launch at all when it refuses', async () => {
    const run = await admitted(KEY)

    const result = bindClaudeCliRun({ ...run, secret: new Uint8Array(0) }, DEPLOYMENT)

    // A partial launch would run the CLI under the tenant's home with whatever
    // credential the ambient environment happened to hold.
    expect('binding' in result).toBe(false)
  })
})
