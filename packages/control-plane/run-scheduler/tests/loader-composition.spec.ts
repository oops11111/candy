/**
 * Real-composition guard: the storage stack, the control-plane store and the
 * scheduler boot from a test-only cordis.yml through the actual Loader, and a
 * minted assertion is admitted, funded and placed against a real database file
 * and a real pool directory. Nothing between the token and the pool root is
 * replaced.
 */

import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  ConversationId,
  DeviceId,
  ProviderAccountId,
  RunId,
  UserId,
  WorkspaceGrantId,
} from '@deepseek-ai/dsh-control-plane'
import ControlPlaneStore from '@deepseek-ai/dsh-control-plane-store'
import {
  CredentialKeyVersion,
  sealCredential,
  type CredentialKeyring,
} from '@deepseek-ai/dsh-credential-vault'
import { mintExecutionAssertion, type ExecutionAssertionClaims } from '@deepseek-ai/dsh-execution-assertion'
import type { RunBudget } from '@deepseek-ai/dsh-run-budget'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import RunScheduler from '../src/index.ts'

const SECRET = 'candy-assertion-secret-at-least-32-bytes'
const KEY = 'candy-credential-key-32-bytes!!!'
const KEY_VERSION = '2026-09-a'
const ISSUER = 'candy-control-plane'
const AUDIENCE = 'candy-runtime-debian-1'
const LIFETIME = 60_000
const ALICE = UserId('user-alice')
const ACCOUNT = ProviderAccountId('account-1')
const BUDGET: RunBudget = { tokens: 100_000, wallMs: 600_000, costMicroUsd: 2_500_000, children: 4 }
/** A share small enough that the tenant's grant still funds another run beside it. */
const SHARE: RunBudget = { tokens: 1_000, wallMs: 60_000, costMicroUsd: 10_000, children: 0 }
const KEYRING: CredentialKeyring = {
  currentVersion: CredentialKeyVersion(KEY_VERSION),
  keys: new Map([[CredentialKeyVersion(KEY_VERSION), Buffer.from(KEY, 'utf8')]]),
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllEnvs()
})

async function boot(at: string): Promise<Context> {
  vi.stubEnv('CANDY_ASSERTION_SECRET', SECRET)
  vi.stubEnv('CANDY_CREDENTIAL_KEY', KEY)
  await mkdir(join(at, 'pools'), { mode: 0o700, recursive: true })
  const configPath = join(at, 'cordis.yml')
  await writeFile(configPath, [
    '- id: timer',
    "  name: '@deepseek-ai/cordis-plugin-timer'",
    '- id: storage',
    "  name: '@deepseek-ai/dsh-storage'",
    '- id: storage-sqlite',
    "  name: '@deepseek-ai/dsh-storage-sqlite'",
    '  config:',
    `    path: ${JSON.stringify(join(at, 'candy.db'))}`,
    '- id: storage-domain',
    "  name: '@deepseek-ai/dsh-storage-domain'",
    '  config:',
    '    backend: sqlite',
    '- id: control-plane-store',
    "  name: '@deepseek-ai/dsh-control-plane-store'",
    '- id: run-scheduler',
    "  name: '@deepseek-ai/dsh-run-scheduler'",
    '  config:',
    `    issuer: ${JSON.stringify(ISSUER)}`,
    `    audience: ${JSON.stringify(AUDIENCE)}`,
    `    credentialKeyVersion: ${JSON.stringify(KEY_VERSION)}`,
    `    poolBase: ${JSON.stringify(join(at, 'pools'))}`,
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = `${pathToFileURL(at).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/cordis-plugin-timer', Timer],
    ['@deepseek-ai/dsh-storage', Storage],
    ['@deepseek-ai/dsh-storage-sqlite', StorageSqlite],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain],
    ['@deepseek-ai/dsh-control-plane-store', ControlPlaneStore],
    ['@deepseek-ai/dsh-run-scheduler', RunScheduler],
  ])
  await Promise.all([...modules.keys()].map(async (packageName) => {
    const packageDir = join(at, 'node_modules', ...packageName.split('/'))
    await mkdir(packageDir, { recursive: true })
    await writeFile(join(packageDir, 'package.json'), `${JSON.stringify({
      name: packageName, version: '0.1.0', type: 'module',
    })}\n`)
  }))
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

function claims(now: number, overrides: Partial<ExecutionAssertionClaims> = {}): ExecutionAssertionClaims {
  return {
    issuer: ISSUER,
    audience: AUDIENCE,
    userId: ALICE,
    deviceId: DeviceId('device-1'),
    accountId: ACCOUNT,
    provider: 'claude-cli',
    workspaceGrantId: WorkspaceGrantId('grant-1'),
    conversationId: ConversationId('conversation-1'),
    sessionId: brandString<SessionId>('session-1'),
    runId: RunId('run-root'),
    parentRunId: undefined,
    nonce: 'nonce-1',
    issuedAt: now,
    expiresAt: now + LIFETIME,
    ...overrides,
  }
}

/** Give the tenant an allowance and a sealed credential, as a control plane would. */
async function provision(ctx: Context, now: number): Promise<void> {
  await ctx.controlPlaneStore.setTenantGrant(ALICE, BUDGET)
  await ctx.controlPlaneStore.save({
    record: {
      id: ACCOUNT,
      userId: ALICE,
      provider: 'claude-cli',
      label: 'work',
      createdAt: now,
      updatedAt: now,
      validatedAt: undefined,
      revokedAt: undefined,
      deletedAt: undefined,
      isDefault: true,
    },
    credential: sealCredential(Buffer.from('sk-ant-alice', 'utf8'), { userId: ALICE, accountId: ACCOUNT }, KEYRING, now).envelope,
  })
}

describe('a booted Candy scheduler', () => {
  it('starts a run from a minted assertion, against the real store and pool base', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)

    const outcome = await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)

    expect(outcome.started).toBe(true)
    if (!outcome.started) return
    expect(outcome.value.reserved).toEqual(BUDGET)
    expect((await stat(outcome.value.run.poolRoot)).mode & 0o777).toBe(0o700)
    expect(Buffer.from(outcome.value.run.secret).toString('utf8')).toBe('sk-ant-alice')
  })

  it('denies the same assertion a second time', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    const token = mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8'))

    // A share rather than the whole remainder, so the tenant's allowance is not
    // what denies the second attempt.
    await ctx.runScheduler.start(token, () => SHARE, now)
    const replayed = await ctx.runScheduler.start(token, () => SHARE, now)

    expect(replayed).toMatchObject({
      started: false,
      rejection: { stage: 'admission', rejection: { stage: 'replay', reason: 'nonce-already-spent' } },
    })
  })

  it('denies a tenant the store has no allowance for', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()

    const outcome = await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)

    expect(outcome).toMatchObject({
      started: false,
      rejection: { stage: 'admission', rejection: { stage: 'budget', reason: 'no-budget' } },
    })
  })

  it('charges a run and closes it for what it spent', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)

    ctx.runScheduler.charge(RunId('run-root'), { tokens: 120, wallMs: 900, costMicroUsd: 4_000 })
    const settled = await ctx.runScheduler.close(RunId('run-root'))

    expect(settled).toMatchObject({ ok: true, value: { spent: { tokens: 120, costMicroUsd: 4_000 } } })
    expect(ctx.runScheduler.ledger.open()).toEqual([])
  })

  it('admits a child against its parent\'s remainder, not the tenant\'s allowance', async () => {
    // A tenant with plenty left can have an exhausted parent; answering a
    // child from the tenant's own budget would defeat the check.
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    const share = { tokens: 100, wallMs: 1_000, costMicroUsd: 10_000, children: 0 }
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)

    const child = await ctx.runScheduler.start(
      mintExecutionAssertion(
        claims(now, { runId: RunId('run-child'), parentRunId: RunId('run-root'), nonce: 'nonce-2' }),
        Buffer.from(SECRET, 'utf8'),
      ),
      () => share,
      now,
    )

    expect(child).toMatchObject({ started: true, value: { reserved: share } })
    expect(ctx.runScheduler.ledger.remaining(RunId('run-root')))
      .toMatchObject({ tokens: BUDGET.tokens - share.tokens, children: 3 })
  })

  it('does not fund a second run of the same size once the first has settled', async () => {
    // The defect the tenant allowance closes: the grant was read straight from
    // the store, so the same 100_000 tokens funded every run the tenant ever
    // started.
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
    ctx.runScheduler.charge(RunId('run-root'), { tokens: BUDGET.tokens, wallMs: 1, costMicroUsd: 1 })
    await ctx.runScheduler.close(RunId('run-root'))

    const second = await ctx.runScheduler.start(
      mintExecutionAssertion(claims(now, { runId: RunId('run-2'), nonce: 'nonce-2' }), Buffer.from(SECRET, 'utf8')),
      undefined,
      now,
    )

    expect(await ctx.controlPlaneStore.tenantAllowance(ALICE))
      .toMatchObject({ consumed: { tokens: BUDGET.tokens } })
    expect(second).toMatchObject({
      started: false,
      rejection: { stage: 'admission', rejection: { stage: 'budget', reason: 'exhausted' } },
    })
  })

  it('holds an open run out of what the tenant\'s next run starts against', async () => {
    // Two live trees would otherwise each be admitted against the whole grant
    // and could together spend it twice.
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), () => SHARE, now)

    const second = await ctx.runScheduler.start(
      mintExecutionAssertion(claims(now, { runId: RunId('run-2'), nonce: 'nonce-2' }), Buffer.from(SECRET, 'utf8')),
      undefined,
      now,
    )

    expect(second).toMatchObject({
      started: true,
      value: { run: { budget: { tokens: BUDGET.tokens - SHARE.tokens, children: BUDGET.children - 1 } } },
    })
  })

  it('charges a tenant once for a whole tree, when its root closes', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
    await ctx.runScheduler.start(
      mintExecutionAssertion(
        claims(now, { runId: RunId('run-child'), parentRunId: RunId('run-root'), nonce: 'nonce-2' }),
        Buffer.from(SECRET, 'utf8'),
      ),
      () => SHARE,
      now,
    )
    ctx.runScheduler.charge(RunId('run-child'), { tokens: 30, wallMs: 5, costMicroUsd: 6 })
    ctx.runScheduler.charge(RunId('run-root'), { tokens: 12, wallMs: 2, costMicroUsd: 1 })

    // A child settles into its parent's record, never into the tenant's.
    await ctx.runScheduler.close(RunId('run-child'))
    expect(await ctx.controlPlaneStore.tenantAllowance(ALICE)).toMatchObject({ consumed: { tokens: 0 } })

    await ctx.runScheduler.close(RunId('run-root'))

    expect(await ctx.controlPlaneStore.tenantAllowance(ALICE))
      .toMatchObject({ consumed: { tokens: 42, wallMs: 7, costMicroUsd: 7 } })
  })

  it('charges nothing for a run it never opened', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)

    expect(await ctx.runScheduler.close(RunId('run-nobody-opened')))
      .toEqual({ ok: false, rejection: { reason: 'unknown-run', runId: RunId('run-nobody-opened') } })
    expect(await ctx.controlPlaneStore.tenantAllowance(ALICE)).toMatchObject({ consumed: { tokens: 0 } })
  })

  it('charges the tenant for a run its lease released', async () => {
    // An abandoned run consumed what it consumed; releasing its hold without
    // charging would return the tokens it actually spent.
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
    ctx.runScheduler.charge(RunId('run-root'), { tokens: 55, wallMs: 3, costMicroUsd: 2 })

    await ctx.runScheduler.sweep(now + 300_001)

    expect(await ctx.controlPlaneStore.tenantAllowance(ALICE))
      .toMatchObject({ consumed: { tokens: 55, wallMs: 3, costMicroUsd: 2 } })
  })

  it('keeps sweeping after a settlement write fails', async () => {
    // The holds a failed sweep could not charge are already released, and a
    // rejected write must not take the runtime down with it.
    vi.useFakeTimers({ now: 1_800_000_000_000 })
    onTestFinished(() => {
      vi.useRealTimers()
    })
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
    vi.spyOn(ctx.controlPlaneStore, 'consumeTenantAllowance').mockRejectedValue(new Error('medium is gone'))

    await vi.advanceTimersByTimeAsync(300_001)

    expect(ctx.runScheduler.ledger.open()).toEqual([])
  })

  it('refuses to boot without the assertion secret', async () => {
    const at = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    root = at
    await mkdir(join(at, 'pools'), { mode: 0o700, recursive: true })
    vi.stubEnv('CANDY_ASSERTION_SECRET', '')
    vi.stubEnv('CANDY_CREDENTIAL_KEY', KEY)

    expect(() => new RunScheduler(new Context(), {
      issuer: ISSUER, audience: AUDIENCE, credentialKeyVersion: KEY_VERSION, poolBase: join(at, 'pools'),
    })).toThrow(/CANDY_ASSERTION_SECRET is not set/)
  })

  it('refuses a credential key that is not 32 bytes', async () => {
    const at = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    root = at
    await mkdir(join(at, 'pools'), { mode: 0o700, recursive: true })
    vi.stubEnv('CANDY_ASSERTION_SECRET', SECRET)
    vi.stubEnv('CANDY_CREDENTIAL_KEY', 'too-short')

    expect(() => new RunScheduler(new Context(), {
      issuer: ISSUER, audience: AUDIENCE, credentialKeyVersion: KEY_VERSION, poolBase: join(at, 'pools'),
    })).toThrow(/must be 32 bytes, got 9/)
  })

  it('sweeps on its own clock, without a caller asking', async () => {
    // The clock is the point: `RunLedger.expire` was a call nothing made.
    vi.useFakeTimers({ now: 1_800_000_000_000 })
    onTestFinished(() => {
      vi.useRealTimers()
    })
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
    expect(ctx.runScheduler.ledger.open()).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(300_001)

    expect(ctx.runScheduler.ledger.open()).toEqual([])
  })

  it('releases a hold whose lease has passed', async () => {
    // Nothing drove `RunLedger.expire` before this service owned a clock: an
    // abandoned run held its allowance until someone thought to reclaim it.
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)

    const released = await ctx.runScheduler.sweep(now + 300_001)

    expect(released.map(settlement => settlement.runId)).toEqual([RunId('run-root')])
    expect(ctx.runScheduler.ledger.open()).toEqual([])
  })
})
