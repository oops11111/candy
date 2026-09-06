/**
 * Real-composition guard: the storage stack, the control-plane store and the
 * scheduler boot from a test-only cordis.yml through the actual Loader, and a
 * minted assertion is admitted, funded and placed against a real database file
 * and a real pool directory. Nothing between the token and the pool root is
 * replaced.
 */

import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { inspect } from 'node:util'
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
  revokeCredential,
  sealCredential,
  type CredentialKeyring,
} from '@deepseek-ai/dsh-credential-vault'
import { mintExecutionAssertion, type ExecutionAssertionClaims } from '@deepseek-ai/dsh-execution-assertion'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { revokeProviderAccount } from '@deepseek-ai/dsh-provider-accounts'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { RunBudget } from '@deepseek-ai/dsh-run-budget'
import { runtimePoolKey, runtimePoolRoot } from '@deepseek-ai/dsh-runtime-pool'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import Llm, { LlmAdapter, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import RunScheduler from '../src/index.ts'

/** A provider that reports one usage figure and stops. */
class FakeAdapter extends LlmAdapter {
  async *stream(): AsyncIterable<StreamChunk> {
    yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 12, costMicroUsd: 900 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Drain one stream to its terminal chunk. */
async function collectChunks(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const seen: StreamChunk[] = []
  for await (const chunk of stream) seen.push(chunk)
  return seen
}

/** Whether a pid is still addressable by this process. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    // ESRCH: no such process. This test's own descendant cannot raise EPERM.
    return false
  }
}

const REAP_DEADLINE_MS = 5_000
const REAP_POLL_MS = 10

/** Wait until a pid is no longer addressable, or give up so the assertion reports it. */
async function reaped(pid: number): Promise<boolean> {
  const deadline = Date.now() + REAP_DEADLINE_MS
  while (Date.now() < deadline) {
    if (!alive(pid)) return true
    await new Promise(resolve => setTimeout(resolve, REAP_POLL_MS))
  }
  return false
}

/** One assembled request, as the loop stamps it for a session. */
function request(sessionId: SessionId | undefined): GenerateOptions {
  return {
    provider: 'fake',
    model: 'fake-1',
    messages: [],
    ...sessionId === undefined ? {} : { sessionId },
  }
}

const SECRET = 'candy-assertion-secret-at-least-32-bytes'
const KEY = 'candy-credential-key-32-bytes!!!'
const KEY_VERSION = '2026-09-a'
const ISSUER = 'candy-control-plane'
const AUDIENCE = 'candy-runtime-debian-1'
const LIFETIME = 60_000
const ALICE = UserId('user-alice')
const SESSION = brandString<SessionId>('session-1')
const SECOND_SESSION = brandString<SessionId>('session-2')
const CHILD_SESSION = brandString<SessionId>('session-child')
const BOBBY = UserId('user-bobby')
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

/** The composition entry for the scheduler, as a deployment writes it. */
function schedulerEntry(at: string, overrides: Readonly<Record<string, unknown>>): readonly string[] {
  const config: Record<string, unknown> = {
    issuer: ISSUER,
    audience: AUDIENCE,
    credentialKeyVersion: KEY_VERSION,
    poolBase: join(at, 'pools'),
    ...overrides,
  }
  return [
    '- id: run-scheduler',
    "  name: '@deepseek-ai/dsh-run-scheduler'",
    '  config:',
    // JSON is a YAML subset, so one line per field carries any value shape.
    ...Object.entries(config).map(([key, value]) => `    ${key}: ${JSON.stringify(value)}`),
  ]
}

async function boot(
  at: string,
  overrides: Readonly<Record<string, unknown>> = {},
  mountScheduler = true,
): Promise<Context> {
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
    // A test that owns the scheduler's own fiber mounts it directly instead.
    ...mountScheduler ? schedulerEntry(at, overrides) : [],
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
    sessionId: SESSION,
    runId: RunId('run-root'),
    parentRunId: undefined,
    nonce: 'nonce-1',
    issuedAt: now,
    expiresAt: now + LIFETIME,
    ...overrides,
  }
}

/** Give a second tenant an allowance and a sealed credential of its own. */
async function provisionBobby(ctx: Context, now: number): Promise<void> {
  await ctx.controlPlaneStore.setTenantGrant(BOBBY, BUDGET)
  await ctx.controlPlaneStore.save({
    record: {
      id: ProviderAccountId('account-2'), userId: BOBBY, provider: 'claude-cli', label: 'work',
      createdAt: now, updatedAt: now, validatedAt: undefined, revokedAt: undefined, deletedAt: undefined, isDefault: true,
    },
    credential: sealCredential(
      Buffer.from('sk-ant-bobby', 'utf8'),
      { userId: BOBBY, accountId: ProviderAccountId('account-2') },
      KEYRING,
      now,
    ).envelope,
  })
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

    // The run is closed first so neither the tenant's allowance nor its session
    // is what denies the second attempt: the nonce is.
    await ctx.runScheduler.start(token, () => SHARE, now)
    await ctx.runScheduler.close(RunId('run-root'))
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

    await ctx.runScheduler.charge(RunId('run-root'), { tokens: 120, wallMs: 900, costMicroUsd: 4_000 })
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
        claims(now, { runId: RunId('run-child'), parentRunId: RunId('run-root'), nonce: 'nonce-2', sessionId: CHILD_SESSION }),
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
    await ctx.runScheduler.charge(RunId('run-root'), { tokens: BUDGET.tokens, wallMs: 1, costMicroUsd: 1 })
    await ctx.runScheduler.close(RunId('run-root'))

    const second = await ctx.runScheduler.start(
      mintExecutionAssertion(claims(now, { runId: RunId('run-2'), nonce: 'nonce-2', sessionId: SECOND_SESSION }), Buffer.from(SECRET, 'utf8')),
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
      mintExecutionAssertion(claims(now, { runId: RunId('run-2'), nonce: 'nonce-2', sessionId: SECOND_SESSION }), Buffer.from(SECRET, 'utf8')),
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
        claims(now, { runId: RunId('run-child'), parentRunId: RunId('run-root'), nonce: 'nonce-2', sessionId: CHILD_SESSION }),
        Buffer.from(SECRET, 'utf8'),
      ),
      () => SHARE,
      now,
    )
    await ctx.runScheduler.charge(RunId('run-child'), { tokens: 30, wallMs: 5, costMicroUsd: 6 })
    await ctx.runScheduler.charge(RunId('run-root'), { tokens: 12, wallMs: 2, costMicroUsd: 1 })

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
    await ctx.runScheduler.charge(RunId('run-root'), { tokens: 55, wallMs: 3, costMicroUsd: 2 })

    await ctx.runScheduler.sweep(now + 300_001)

    expect(await ctx.controlPlaneStore.tenantAllowance(ALICE))
      .toMatchObject({ consumed: { tokens: 55, wallMs: 3, costMicroUsd: 2 } })
  })

  it('leaves a run open when its settlement cannot be written, and survives', async () => {
    // Settling first and writing after would lose the charge the write was
    // carrying. Writing first means a rejected write costs nothing: the run
    // stays open and its lease brings the next sweep back to try again.
    vi.useFakeTimers({ now: 1_800_000_000_000 })
    onTestFinished(() => {
      vi.useRealTimers()
    })
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
    await ctx.runScheduler.charge(RunId('run-root'), { tokens: 60, wallMs: 1, costMicroUsd: 1 })
    const charge = vi.spyOn(ctx.controlPlaneStore, 'consumeTenantAllowance')
      .mockRejectedValue(new Error('medium is gone'))

    await vi.advanceTimersByTimeAsync(300_001)

    expect(ctx.runScheduler.ledger.open()).toHaveLength(1)
    expect(await ctx.controlPlaneStore.tenantAllowance(ALICE)).toMatchObject({ consumed: { tokens: 0 } })

    charge.mockRestore()
    await vi.advanceTimersByTimeAsync(30_001)

    expect(ctx.runScheduler.ledger.open()).toEqual([])
    expect(await ctx.controlPlaneStore.tenantAllowance(ALICE)).toMatchObject({ consumed: { tokens: 60 } })
  })

  it('charges a tenant for a run its runtime restarted out from under', async () => {
    // The record survives the process that opened it. Before it did, a restart
    // handed the tenant back the whole allowance whatever was running.
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const first = await boot(root)
    const now = Date.now()
    await provision(first, now)
    await first.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
    await first.runScheduler.charge(RunId('run-root'), { tokens: 250, wallMs: 9, costMicroUsd: 3 })
    await first.fiber.dispose()
    context = undefined

    const second = await boot(root)

    expect(second.runScheduler.ledger.open()).toEqual([])
    expect(await second.controlPlaneStore.tenantAllowance(ALICE))
      .toMatchObject({ consumed: { tokens: 250, wallMs: 9, costMicroUsd: 3 } })
  })

  it('charges a restarted tree once, for everything under its root', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const first = await boot(root)
    const now = Date.now()
    await provision(first, now)
    await first.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
    await first.runScheduler.start(
      mintExecutionAssertion(
        claims(now, { runId: RunId('run-child'), parentRunId: RunId('run-root'), nonce: 'nonce-2', sessionId: CHILD_SESSION }),
        Buffer.from(SECRET, 'utf8'),
      ),
      () => SHARE,
      now,
    )
    await first.runScheduler.charge(RunId('run-child'), { tokens: 30, wallMs: 2, costMicroUsd: 1 })
    await first.runScheduler.charge(RunId('run-root'), { tokens: 12, wallMs: 1, costMicroUsd: 1 })
    await first.fiber.dispose()
    context = undefined

    const second = await boot(root)

    expect(await second.controlPlaneStore.tenantAllowance(ALICE))
      .toMatchObject({ consumed: { tokens: 42, wallMs: 3, costMicroUsd: 2 } })
    expect(await second.controlPlaneStore.runsOf(AUDIENCE)).toEqual([])
  })

  it('finishes a settlement its runtime was interrupted part-way through', async () => {
    // A record carrying a settled figure is a run whose charge was written down
    // and may or may not have been applied; recovery re-drives exactly that.
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const first = await boot(root)
    const now = Date.now()
    await provision(first, now)
    await first.controlPlaneStore.openRun({
      record: {
        runId: RunId('run-interrupted'), parentRunId: undefined,
        reserved: SHARE, spent: { tokens: 70, wallMs: 4, costMicroUsd: 5 }, leaseExpiresAt: now + 300_000,
      },
      userId: ALICE,
      sessionId: SESSION,
      accountId: ACCOUNT,
      runtime: AUDIENCE,
      settledSpent: { tokens: 70, wallMs: 4, costMicroUsd: 5 },
      absorbed: undefined,
    })
    await first.fiber.dispose()
    context = undefined

    const second = await boot(root)

    expect(await second.controlPlaneStore.tenantAllowance(ALICE))
      .toMatchObject({ consumed: { tokens: 70, wallMs: 4, costMicroUsd: 5 } })
    expect(await second.controlPlaneStore.runsOf(AUDIENCE)).toEqual([])
  })

  it('does not charge again for a settlement whose charge already landed', async () => {
    // The crash window the marker exists for: the tenant was charged and the
    // record was not yet deleted.
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const first = await boot(root)
    const now = Date.now()
    await provision(first, now)
    const spent = { tokens: 70, wallMs: 4, costMicroUsd: 5 }
    await first.controlPlaneStore.consumeTenantAllowance(ALICE, RunId('run-interrupted'), spent)
    await first.controlPlaneStore.openRun({
      record: {
        runId: RunId('run-interrupted'), parentRunId: undefined,
        reserved: SHARE, spent, leaseExpiresAt: now + 300_000,
      },
      userId: ALICE,
      sessionId: SESSION,
      accountId: ACCOUNT,
      runtime: AUDIENCE,
      settledSpent: spent,
      absorbed: undefined,
    })
    await first.fiber.dispose()
    context = undefined

    const second = await boot(root)

    expect(await second.controlPlaneStore.tenantAllowance(ALICE)).toMatchObject({ consumed: spent })
    expect(await second.controlPlaneStore.runsOf(AUDIENCE)).toEqual([])
  })

  it('leaves another runtime\'s records alone', async () => {
    // Two runtimes sharing a medium must not settle each other's live runs.
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const first = await boot(root)
    const now = Date.now()
    await provision(first, now)
    const foreign = {
      record: {
        runId: RunId('run-elsewhere'), parentRunId: undefined,
        reserved: SHARE, spent: { tokens: 5, wallMs: 1, costMicroUsd: 1 }, leaseExpiresAt: now + 300_000,
      },
      userId: ALICE,
      sessionId: SESSION,
      accountId: ACCOUNT,
      runtime: 'candy-runtime-debian-2',
      settledSpent: undefined,
      absorbed: undefined,
    }
    await first.controlPlaneStore.openRun(foreign)
    await first.fiber.dispose()
    context = undefined

    const second = await boot(root)

    expect(await second.controlPlaneStore.tenantAllowance(ALICE)).toMatchObject({ consumed: { tokens: 0 } })
    expect(await second.controlPlaneStore.runsOf('candy-runtime-debian-2')).toEqual([foreign])
  })

  it('charges a metered provider stream, durably, before its finish is delivered', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
    async function* provider(): AsyncIterable<StreamChunk> {
      yield { type: 'usage', usage: { inputTokens: 800, outputTokens: 200, costMicroUsd: 1_234 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }

    const seen: StreamChunk[] = []
    for await (const chunk of ctx.runScheduler.meter(RunId('run-root'), provider())) seen.push(chunk)

    expect(seen.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(ctx.runScheduler.ledger.get(RunId('run-root')))
      .toMatchObject({ spent: { tokens: 1_000, costMicroUsd: 1_234 } })
    const [stored] = await ctx.controlPlaneStore.runsOf(AUDIENCE)
    expect(stored).toMatchObject({ record: { spent: { tokens: 1_000, costMicroUsd: 1_234 } } })
  })

  it('refuses the next call once a run has spent its allowance', async () => {
    // The enforcement the budget existed for: admission bounded the first call,
    // and nothing bounded the second until the stream was metered.
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
    async function* spender(): AsyncIterable<StreamChunk> {
      yield { type: 'usage', usage: { inputTokens: BUDGET.tokens, outputTokens: 0 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    let reached = false
    async function* second(): AsyncIterable<StreamChunk> {
      reached = true
      yield { type: 'finish', reason: { kind: 'stop' } }
    }

    for await (const _ of ctx.runScheduler.meter(RunId('run-root'), spender())) { /* drain */ }
    const refused: StreamChunk[] = []
    for await (const chunk of ctx.runScheduler.meter(RunId('run-root'), second())) refused.push(chunk)

    expect(reached).toBe(false)
    expect(refused).toEqual([{
      type: 'finish',
      reason: { kind: 'error', failure: { message: "run 'run-root' has spent tokens", code: 'RUN_BUDGET_EXHAUSTED' } },
    }])
  })

  it('charges a request assembled for a run\'s session, through the real waterfall', async () => {
    // The join: a model request carries the session it was assembled for, and
    // that is the only thing it and an admitted run have in common.
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
    await ctx.plugin(Llm)
    ctx.llm.registerAdapter(['fake'], new FakeAdapter())

    const seen: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream(request(SESSION))) seen.push(chunk)

    expect(seen.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(ctx.runScheduler.ledger.get(RunId('run-root')))
      .toMatchObject({ spent: { tokens: 42, costMicroUsd: 900 } })
  })

  it('refuses a call whose run authenticated with an account since revoked', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
    await ctx.plugin(Llm)
    ctx.llm.registerAdapter(['fake'], new FakeAdapter())

    // Revoking destroys the stored envelope, which stops the next admission
    // but reaches nothing already holding an opened credential.
    await revokeProviderAccount(ctx.controlPlaneStore, ALICE, ACCOUNT, now + 1)

    const seen: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream(request(SESSION))) seen.push(chunk)

    expect(seen.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'CREDENTIAL_REVOKED' } },
    })
    expect(ctx.runScheduler.ledger.get(RunId('run-root'))?.spent).toMatchObject({ tokens: 0, costMicroUsd: 0 })
  })

  it('records a refused call against the tenant whose run it was', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
    await ctx.plugin(Llm)
    ctx.llm.registerAdapter(['fake'], new FakeAdapter())

    await revokeProviderAccount(ctx.controlPlaneStore, ALICE, ACCOUNT, now + 1)
    for await (const _chunk of ctx.llm.stream(request(SESSION))) { /* drained */ }

    // A revoked credential still being used is the clearest signal admission
    // never sees, because the run that holds it never returns to the vault.
    expect(ctx.runScheduler.auditsOfTenant(ALICE).at(-1)).toMatchObject({
      runId: RunId('run-root'),
      userId: ALICE,
      accountId: ACCOUNT,
      event: 'refused',
      action: 'meter',
      outcome: 'CREDENTIAL_REVOKED',
    })
  })

  it('records a run that spent its allowance, so a quota violation has a reader', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    // A run funded with nothing is exhausted before its first call.
    await ctx.runScheduler.start(
      mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')),
      () => ({ tokens: 0, wallMs: 0, costMicroUsd: 0, children: 0 }),
      now,
    )
    await ctx.plugin(Llm)
    ctx.llm.registerAdapter(['fake'], new FakeAdapter())

    for await (const _chunk of ctx.llm.stream(request(SESSION))) { /* drained */ }

    expect(ctx.runScheduler.auditsOfTenant(ALICE).at(-1)).toMatchObject({
      runId: RunId('run-root'),
      event: 'refused',
      action: 'meter',
      outcome: 'RUN_BUDGET_EXHAUSTED',
    })
  })

  it('files a refusal with no run of its own against the runtime', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
    await ctx.plugin(Llm)
    ctx.llm.registerAdapter(['fake'], new FakeAdapter())
    await ctx.runScheduler.close(RunId('run-root'))

    for await (const _chunk of ctx.llm.stream(request(SESSION))) { /* drained */ }

    // The run is gone, so there is no tenant this runtime may believe the
    // session still belongs to.
    expect(ctx.runScheduler.auditsOfRuntime().at(-1)).toMatchObject({
      event: 'refused',
      action: 'meter',
      outcome: 'RUN_NOT_OPEN',
    })
    expect(ctx.runScheduler.auditsOfRuntime().at(-1)).not.toHaveProperty('userId')
  })

  it('still refuses the call when the trail cannot take the record', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
    await ctx.plugin(Llm)
    ctx.llm.registerAdapter(['fake'], new FakeAdapter())
    await revokeProviderAccount(ctx.controlPlaneStore, ALICE, ACCOUNT, now + 1)
    vi.spyOn(ctx.controlPlaneStore, 'recordAudit').mockRejectedValue(new Error('medium is gone'))

    const seen: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream(request(SESSION))) seen.push(chunk)

    // A store that cannot take the record must not turn one refused call into
    // a failure of its own: the caller still gets its one terminal chunk.
    expect(seen.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'CREDENTIAL_REVOKED' } },
    })
  })

  it('never lets two concurrent calls on one run outspend it', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    // Funded for exactly one call from the fake adapter.
    await ctx.runScheduler.start(
      mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')),
      () => ({ tokens: 42, wallMs: 60_000, costMicroUsd: 900, children: 0 }),
      now,
    )
    await ctx.plugin(Llm)
    ctx.llm.registerAdapter(['fake'], new FakeAdapter())

    const drain = async (): Promise<StreamChunk | undefined> => {
      const seen: StreamChunk[] = []
      for await (const chunk of ctx.llm.stream(request(SESSION))) seen.push(chunk)
      return seen.at(-1)
    }
    const [first, second] = await Promise.all([drain(), drain()])

    // One call spends the run's tokens; the one behind it reads what is left.
    expect(first).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(second).toMatchObject({ reason: { kind: 'error', failure: { code: 'RUN_BUDGET_EXHAUSTED' } } })
    expect(ctx.runScheduler.ledger.get(RunId('run-root'))?.spent.tokens).toBe(42)
  })

  it('releases the line when a call fails instead of finishing', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
    await ctx.plugin(Llm)
    ctx.llm.registerAdapter(['fake'], new FakeAdapter())
    // A charge that cannot be written leaves the stream by throwing, which is
    // not an ending the done path sees.
    const spend = vi.spyOn(ctx.controlPlaneStore, 'recordRunSpend').mockRejectedValue(new Error('medium is gone'))

    await expect(collectChunks(ctx.llm.stream(request(SESSION)))).rejects.toThrow(/medium is gone/)

    spend.mockRestore()
    const seen = await collectChunks(ctx.llm.stream(request(SESSION)))

    expect(seen.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('releases the line for a consumer that never reads the stream at all', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
    await ctx.plugin(Llm)
    ctx.llm.registerAdapter(['fake'], new FakeAdapter())

    // Closed before the first read: no call was ever started, so there is
    // nothing to close but the line still has to be given up.
    await ctx.llm.stream(request(SESSION))[Symbol.asyncIterator]().return?.(undefined)

    const seen = await collectChunks(ctx.llm.stream(request(SESSION)))

    expect(seen.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('leaves the line once, however a consumer ends the stream', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
    await ctx.plugin(Llm)
    ctx.llm.registerAdapter(['fake'], new FakeAdapter())

    // A consumer may close an iterator it has already drained; the second
    // leave must not release a line this call no longer holds.
    const reader = ctx.llm.stream(request(SESSION))[Symbol.asyncIterator]()
    let step = await reader.next()
    while (step.done !== true) step = await reader.next()
    await reader.return?.(undefined)

    const seen: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream(request(SESSION))) seen.push(chunk)

    expect(seen.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('lets a run make its next call once the one before it is abandoned', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
    await ctx.plugin(Llm)
    ctx.llm.registerAdapter(['fake'], new FakeAdapter())

    // A consumer that reads one chunk and stops must not hold the line.
    for await (const _chunk of ctx.llm.stream(request(SESSION))) break

    const seen: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream(request(SESSION))) seen.push(chunk)

    expect(seen.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('does not make one tenant wait on another tenant\'s run', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await provisionBobby(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now, {
      userId: BOBBY,
      accountId: ProviderAccountId('account-2'),
      sessionId: SECOND_SESSION,
      runId: RunId('run-bobby'),
      nonce: 'nonce-bobby',
    }), Buffer.from(SECRET, 'utf8')), undefined, now)
    await ctx.plugin(Llm)
    ctx.llm.registerAdapter(['fake'], new FakeAdapter())

    const drain = async (session: SessionId): Promise<StreamChunk | undefined> => {
      const seen: StreamChunk[] = []
      for await (const chunk of ctx.llm.stream(request(session))) seen.push(chunk)
      return seen.at(-1)
    }
    const [alice, bobby] = await Promise.all([drain(SESSION), drain(SECOND_SESSION)])

    expect(alice).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(bobby).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('still opens a credential sealed before the key was rotated', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const first = await boot(root)
    const now = Date.now()
    await provision(first, now)
    await first.fiber.dispose()

    // The operator rotates: a new key under a new version, with the old
    // version retained until every envelope has been rewrapped.
    vi.stubEnv('CANDY_CREDENTIAL_KEY', 'candy-credential-key-ROTATED-32b')
    vi.stubEnv('CANDY_CREDENTIAL_KEY_PREVIOUS', KEY)
    const second = await boot(root, {
      credentialKeyVersion: '2026-09-b',
      retiredCredentialKeys: [{ version: KEY_VERSION, env: 'CANDY_CREDENTIAL_KEY_PREVIOUS' }],
    })

    const started = await second.runScheduler.start(
      mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')),
      undefined,
      now,
    )

    expect(started.started).toBe(true)
  })

  it('locks nobody out by name: a rotation without the old key refuses every tenant', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const first = await boot(root)
    const now = Date.now()
    await provision(first, now)
    await first.fiber.dispose()

    vi.stubEnv('CANDY_CREDENTIAL_KEY', 'candy-credential-key-ROTATED-32b')
    const second = await boot(root, { credentialKeyVersion: '2026-09-b' })

    const started = await second.runScheduler.start(
      mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')),
      undefined,
      now,
    )

    // The envelope names the version it was sealed under, and this runtime no
    // longer holds that key. Retaining it is what makes the rotation safe.
    expect(started).toMatchObject({
      started: false,
      rejection: { rejection: { stage: 'credential', reason: 'unknown-key' } },
    })
  })

  it.each([
    ['a version that is also the current one', KEY_VERSION, /is both current and retired/],
    ['a version retired twice', '2026-09-old', /is retired twice/],
  ])('refuses at load %s', async (_case, version, message) => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    vi.stubEnv('CANDY_CREDENTIAL_KEY_PREVIOUS', KEY)

    // Either would silently decide which key a version means, and the wrong
    // answer is a tenant whose credential opens with the wrong key or not at
    // all, so the composition fails instead.
    await expect(boot(root, {
      retiredCredentialKeys: [
        { version, env: 'CANDY_CREDENTIAL_KEY_PREVIOUS' },
        { version: '2026-09-old', env: 'CANDY_CREDENTIAL_KEY_PREVIOUS' },
      ],
    })).rejects.toThrow(message)
  })

  it('refuses at load a retired key whose variable is not set', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))

    await expect(boot(root, {
      retiredCredentialKeys: [{ version: '2026-09-old', env: 'CANDY_CREDENTIAL_KEY_MISSING' }],
    })).rejects.toThrow(/CANDY_CREDENTIAL_KEY_MISSING is not set/)
  })

  it('keeps a tenant\'s history when its run is refused over and over', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root, { auditRetention: 4 })
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
    await ctx.plugin(Llm)
    ctx.llm.registerAdapter(['fake'], new FakeAdapter())

    await revokeProviderAccount(ctx.controlPlaneStore, ALICE, ACCOUNT, now + 1)
    for (let call = 0; call < 8; call += 1) await collectChunks(ctx.llm.stream(request(SESSION)))

    // Without folding, eight refusals against a retention of four leave only
    // refusals — the trail an operator investigates them with is the trail the
    // repetition erases.
    const trail = ctx.runScheduler.auditsOfTenant(ALICE)
    expect(trail.map(record => `${record.event}/${record.outcome}`)).toEqual([
      'credential/ok',
      'started/ok',
      'refused/CREDENTIAL_REVOKED',
    ])
    expect(trail.at(-1)).toMatchObject({ count: 8 })
  })

  it('keeps secrets and other tenants out of what an operator reads', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await provisionBobby(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
    // A denied attempt too: a token this runtime cannot verify names a tenant
    // it may not believe, so its record must not reach that tenant's trail.
    const denied = await ctx.runScheduler.start(
      mintExecutionAssertion(
        claims(now, { userId: BOBBY, runId: RunId('run-x'), nonce: 'n-x' }),
        Buffer.from('another-secret-at-least-32-bytes!', 'utf8'),
      ),
      undefined,
      now,
    )

    const read = JSON.stringify({
      tenantTrail: ctx.runScheduler.auditsOfTenant(ALICE),
      runtimeTrail: ctx.runScheduler.auditsOfRuntime(),
      deniedOutcome: denied,
      ledgerRecord: ctx.runScheduler.ledger.get(RunId('run-root')),
    })

    expect(read).not.toContain('sk-ant-alice')
    expect(read).not.toContain(SECRET)
    expect(read).not.toContain(KEY)
    expect(read).not.toContain(root)
    expect(JSON.stringify(ctx.runScheduler.auditsOfTenant(ALICE))).not.toContain(BOBBY)
  })

  it('never serializes the credential an admitted run carries', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provisionBobby(ctx, now)

    const started = await ctx.runScheduler.start(
      mintExecutionAssertion(claims(now, {
        userId: BOBBY, accountId: ProviderAccountId('account-2'), runId: RunId('run-2'), nonce: 'n-2',
      }), Buffer.from(SECRET, 'utf8')),
      undefined,
      now,
    )

    // Logging the outcome is the first thing an operator does with one, and a
    // plain object would put the decrypted provider key in that log byte by
    // byte. Reading it is unaffected — that is what launches the provider.
    const logged = JSON.stringify(started)
    expect(logged).not.toContain(JSON.stringify([...Buffer.from('sk-ant-bobby', 'utf8')]).slice(1, -1))
    expect(logged).toContain('[redacted]')
    expect(started.started ? Buffer.from(started.value.run.secret).toString('utf8') : undefined)
      .toBe('sk-ant-bobby')

    // `console.log` and every structured logger that walks own properties
    // ignore `toJSON`, so the credential is non-enumerable as well.
    const run = started.started ? started.value.run : undefined
    expect(Object.keys(run!)).not.toContain('secret')
    expect(inspect(run, { depth: 4 })).not.toContain('sk-ant-bobby')
  })

  it('charges a cancelled call for what it used and leaves the run open', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
    await ctx.plugin(Llm)
    let closed = false
    class CancellableAdapter extends LlmAdapter {
      async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        try {
          yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 12, costMicroUsd: 900 } }
          if (options.signal === undefined) { yield { type: 'finish', reason: { kind: 'stop' } }; return }
          await new Promise((_resolve, reject) => {
            // The signal may already have fired by the time this runs.
            if (options.signal?.aborted === true) { reject(new Error('aborted')); return }
            options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) })
          })
        } finally { closed = true }
      }
    }
    ctx.llm.registerAdapter(['fake'], new CancellableAdapter())

    const control = new AbortController()
    for await (const _chunk of ctx.llm.stream({ ...request(SESSION), signal: control.signal })) control.abort()

    // A cancelled call is not a free one: the meter charges what it consumed
    // before the caller gave up, and the run it belonged to stays open.
    expect(closed).toBe(true)
    expect(ctx.runScheduler.ledger.get(RunId('run-root'))?.spent).toMatchObject({ tokens: 42, costMicroUsd: 900 })
    expect(ctx.runScheduler.ledger.get(RunId('run-root'))).toBeDefined()

    // And it gave up its place, so the run's next call is not waiting on it.
    const seen = await collectChunks(ctx.llm.stream(request(SESSION)))
    expect(seen.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('gives up the line even when closing a cancelled call fails', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
    await ctx.plugin(Llm)
    let failOnClose = true
    class FailingCloseAdapter extends LlmAdapter {
      async *stream(): AsyncIterable<StreamChunk> {
        try {
          yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 12, costMicroUsd: 900 } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        } finally {
          // A provider whose teardown throws: reaping its process failed.
          if (failOnClose) throw new Error('the provider process could not be reaped')
        }
      }
    }
    ctx.llm.registerAdapter(['fake'], new FailingCloseAdapter())

    const abandoned = ctx.llm.stream(request(SESSION))[Symbol.asyncIterator]()
    await abandoned.next()
    await expect(abandoned.return?.(undefined)).rejects.toThrow(/could not be reaped/)

    // Holding the line over a close that went wrong would strand the run for
    // the rest of its life.
    failOnClose = false
    const seen = await collectChunks(ctx.llm.stream(request(SESSION)))
    expect(seen.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('recovers a run whose parent the store lost, instead of failing every tenant', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const first = await boot(root)
    const now = Date.now()
    await provision(first, now)
    // A child whose parent record is then lost, as a partial write or a delete
    // that took the parent and left the child would leave it.
    await first.controlPlaneStore.openRun({
      record: {
        runId: RunId('run-orphan'), parentRunId: RunId('run-gone'),
        reserved: { tokens: 100, wallMs: 1_000, costMicroUsd: 50, children: 0 },
        spent: { tokens: 40, wallMs: 5, costMicroUsd: 20 },
        leaseExpiresAt: now + 300_000,
      },
      userId: ALICE, sessionId: brandString<SessionId>('session-orphan'), accountId: ACCOUNT,
      runtime: AUDIENCE, settledSpent: undefined, absorbed: undefined,
    })
    await first.fiber.dispose()

    const second = await boot(root)

    // Recovery settles every root it restores, so the orphan was going to be
    // settled either way; the only question was who is charged, and the record
    // names its tenant. The damaged record is gone and its hold released.
    expect(await second.controlPlaneStore.runsOf(AUDIENCE)).toEqual([])
    const allowance = await second.controlPlaneStore.tenantAllowance(ALICE)
    expect(allowance?.consumed).toMatchObject({ tokens: 40, costMicroUsd: 20 })
    // The tenant can start again, which a failed boot would never have allowed.
    const started = await second.runScheduler.start(
      mintExecutionAssertion(claims(now, { runId: RunId('run-after'), nonce: 'n-after' }), Buffer.from(SECRET, 'utf8')),
      undefined,
      now,
    )
    expect(started.started).toBe(true)
  })

  it('attributes a process launched during a metered call to that run', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
    await ctx.plugin(Llm)
    // An adapter that starts a provider process the way a CLI route does: deep
    // inside the stream, with no session and no run of its own to name.
    class SpawningAdapter extends LlmAdapter {
      async *stream(): AsyncIterable<StreamChunk> {
        ctx.emit('subprocess/launched', { executable: '/opt/candy/bin/claude', cwd: '/pool', pid: 4242, kind: 'process' })
        yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 12, costMicroUsd: 900 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['fake'], new SpawningAdapter())

    await collectChunks(ctx.llm.stream(request(SESSION)))

    expect(ctx.runScheduler.auditsOfTenant(ALICE).at(-1)).toMatchObject({
      runId: RunId('run-root'),
      userId: ALICE,
      accountId: ACCOUNT,
      event: 'launched',
      action: '/opt/candy/bin/claude',
      outcome: 'ok',
    })
  })

  it('records a spawn that failed during a metered call', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
    await ctx.plugin(Llm)
    class FailedSpawnAdapter extends LlmAdapter {
      async *stream(): AsyncIterable<StreamChunk> {
        // The seam returns a handle either way, and -1 is how it says the
        // launch did not happen.
        ctx.emit('subprocess/launched', { executable: '/opt/candy/bin/claude', cwd: '/pool', pid: -1, kind: 'process' })
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['fake'], new FailedSpawnAdapter())

    await collectChunks(ctx.llm.stream(request(SESSION)))

    expect(ctx.runScheduler.auditsOfTenant(ALICE).at(-1)).toMatchObject({ event: 'launched', outcome: 'spawn-failed' })
  })

  it('drops a launch whose run the store no longer holds', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
    await ctx.plugin(Llm)
    class RaceAdapter extends LlmAdapter {
      async *stream(): AsyncIterable<StreamChunk> {
        // The run settles while its stream is still being pulled: there is no
        // record left to name a tenant with.
        await ctx.controlPlaneStore.deleteRun(RunId('run-root'))
        ctx.emit('subprocess/launched', { executable: '/opt/candy/bin/claude', cwd: '/pool', pid: 9, kind: 'process' })
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['fake'], new RaceAdapter())
    const before = ctx.runScheduler.auditsOfTenant(ALICE).length

    await collectChunks(ctx.llm.stream(request(SESSION)))

    expect(ctx.runScheduler.auditsOfTenant(ALICE)).toHaveLength(before)
  })

  it('keeps streaming when the trail cannot take a launch record', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
    await ctx.plugin(Llm)
    class SpawningAdapter extends LlmAdapter {
      async *stream(): AsyncIterable<StreamChunk> {
        ctx.emit('subprocess/launched', { executable: '/opt/candy/bin/claude', cwd: '/pool', pid: 4242, kind: 'process' })
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['fake'], new SpawningAdapter())
    vi.spyOn(ctx.controlPlaneStore, 'recordAudit').mockRejectedValue(new Error('medium is gone'))

    const seen = await collectChunks(ctx.llm.stream(request(SESSION)))

    // A trail that cannot take the record must not fail the call it describes.
    expect(seen.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('leaves a launch that belongs to no metered call unattributed', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
    const before = ctx.runScheduler.auditsOfTenant(ALICE).length

    // The harness's own bash or language-server children: no tenant to name,
    // and filing them would push a tenant's records out of a bounded trail.
    ctx.emit('subprocess/launched', { executable: '/bin/bash', cwd: '/tmp', pid: 7, kind: 'process' })
    await Promise.resolve()

    expect(ctx.runScheduler.auditsOfTenant(ALICE)).toHaveLength(before)
  })

  it('ends a run whose account can no longer authorize it, without waiting for its lease', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
    await ctx.runScheduler.charge(RunId('run-root'), { tokens: 40, wallMs: 5, costMicroUsd: 20 })

    await revokeProviderAccount(ctx.controlPlaneStore, ALICE, ACCOUNT, now + 1)
    // Well before the lease would have expired.
    const settled = await ctx.runScheduler.sweep(now + 1_000)

    // Refusing its calls left the run open, holding its funder's allowance
    // with what it had already spent unbilled, for the rest of its lease.
    expect(settled).toHaveLength(1)
    expect(ctx.runScheduler.ledger.get(RunId('run-root'))).toBeUndefined()
    expect((await ctx.controlPlaneStore.tenantAllowance(ALICE))?.consumed).toMatchObject({ tokens: 40 })
  })

  it('leaves a run alone when its account is still usable and its lease holds', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)

    expect(await ctx.runScheduler.sweep(now + 1_000)).toHaveLength(0)
    expect(ctx.runScheduler.ledger.get(RunId('run-root'))).toBeDefined()
  })

  it('leaves a run to its lease when the store cannot answer for it', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
    // The ledger holds the run and the store does not: settling on a store
    // that answered nothing would end runs over a read that failed.
    await ctx.controlPlaneStore.deleteRun(RunId('run-root'))

    expect(await ctx.runScheduler.sweep(now + 1_000)).toHaveLength(0)
    expect(ctx.runScheduler.ledger.get(RunId('run-root'))).toBeDefined()
  })

  it('runs a run\'s registered disposer when it settles', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
    const dispose = vi.fn()
    ctx.runScheduler.registerDisposer(RunId('run-root'), dispose)

    await ctx.runScheduler.close(RunId('run-root'))

    expect(dispose).toHaveBeenCalledOnce()
  })

  it('runs a child\'s disposer too, when its parent\'s tree closes around it', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
    await ctx.runScheduler.start(
      mintExecutionAssertion(
        claims(now, { runId: RunId('run-child'), parentRunId: RunId('run-root'), nonce: 'nonce-2', sessionId: CHILD_SESSION }),
        Buffer.from(SECRET, 'utf8'),
      ),
      () => SHARE,
      now,
    )
    const dispose = vi.fn()
    ctx.runScheduler.registerDisposer(RunId('run-child'), dispose)

    // The child is never closed directly; its process is still live when the
    // root closes the whole tree around it.
    await ctx.runScheduler.close(RunId('run-root'))

    expect(dispose).toHaveBeenCalledOnce()
  })

  it('does not run a disposer once it has been unregistered', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
    const dispose = vi.fn()
    const unregister = ctx.runScheduler.registerDisposer(RunId('run-root'), dispose)
    // The resource ended on its own before the run settled.
    unregister()

    await ctx.runScheduler.close(RunId('run-root'))

    expect(dispose).not.toHaveBeenCalled()
  })

  it('replaces an earlier disposer rather than accumulating one per call', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
    const first = vi.fn()
    const second = vi.fn()
    ctx.runScheduler.registerDisposer(RunId('run-root'), first)
    // A run's second sequential call registers over the first, whose process
    // already exited — only the live one still needs releasing.
    ctx.runScheduler.registerDisposer(RunId('run-root'), second)

    await ctx.runScheduler.close(RunId('run-root'))

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledOnce()
  })

  it('settles a run whose disposer fails, rather than leaving it open', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
    ctx.runScheduler.registerDisposer(RunId('run-root'), () => { throw new Error('process would not die') })

    const closed = await ctx.runScheduler.close(RunId('run-root'))

    // The disposer's own failure is a log, not a reason to leave the run's
    // accounting stuck open.
    expect(closed.ok).toBe(true)
    expect(ctx.runScheduler.ledger.get(RunId('run-root'))).toBeUndefined()
  })

  it('terminates a spawned process when its run settles for cause', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
    const terminate = vi.fn()
    let resolveDone!: () => void
    const done = new Promise<void>((resolve) => { resolveDone = resolve })
    const spawn = ctx.runScheduler.disposableSpawn(RunId('run-root'), (spec: { argv: string[] }) => {
      expect(spec.argv).toEqual(['claude'])
      return { done, terminate }
    })

    spawn({ argv: ['claude'] })
    await revokeProviderAccount(ctx.controlPlaneStore, ALICE, ACCOUNT, now + 1)
    await ctx.runScheduler.sweep(now + 1_000)

    expect(terminate).toHaveBeenCalledOnce()
    resolveDone()
  })

  it('never terminates a process that already exited on its own', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
    const terminate = vi.fn()
    const spawn = ctx.runScheduler.disposableSpawn(
      RunId('run-root'),
      (_spec: { argv: string[] }) => ({ done: Promise.resolve(), terminate }),
    )

    spawn({ argv: ['claude'] })
    // Let the handle's own `done` settle and unregister its disposer before
    // the run is settled for an unrelated reason.
    await Promise.resolve().then(() => Promise.resolve())
    await ctx.runScheduler.close(RunId('run-root'))

    expect(terminate).not.toHaveBeenCalled()
  })

  it('kills a real process, not just a mocked handle, when its run settles', async () => {
    // Every other disposer test uses a fake handle to pin the registry's own
    // logic; this one proves `disposableSpawn` actually reaps something a
    // real `SubprocessRuntime.spawn` started, the way a provider binding's
    // own `spawn` would.
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    await ctx.plugin(SubprocessLocal)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
    const spawn = ctx.runScheduler.disposableSpawn(
      RunId('run-root'),
      (spec: SubprocessSpawnSpec) => ctx.subprocess.spawn(spec),
    )

    const handle = spawn({
      argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      cwd: root,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1_024 }, stderr: { maxBytes: 1_024 } },
      graceMs: 1_000,
    })
    expect(alive(handle.pid)).toBe(true)

    await ctx.runScheduler.close(RunId('run-root'))

    expect(await reaped(handle.pid)).toBe(true)
  })

  it('keeps metering a call whose run still holds a usable account', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
    await ctx.plugin(Llm)
    ctx.llm.registerAdapter(['fake'], new FakeAdapter())

    // Another tenant's revocation says nothing about this run's account.
    await provisionBobby(ctx, now)
    await revokeProviderAccount(ctx.controlPlaneStore, BOBBY, ProviderAccountId('account-2'), now + 1)

    const seen: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream(request(SESSION))) seen.push(chunk)

    expect(seen.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('leaves a request that belongs to no run of this runtime alone', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
    await ctx.plugin(Llm)
    ctx.llm.registerAdapter(['fake'], new FakeAdapter())

    const other: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream(request(brandString<SessionId>('session-elsewhere')))) other.push(chunk)
    const unnamed: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream(request(undefined))) unnamed.push(chunk)

    expect(other.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(unnamed.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(ctx.runScheduler.ledger.get(RunId('run-root'))).toMatchObject({ spent: { tokens: 0 } })
  })

  it('refuses a request whose session two run records both claim', async () => {
    // `start` refuses the second run, so this state arrives only from outside
    // it: another runtime sharing this audience, or a direct record write.
    // Charging either tree would be a misbilling the caller cannot detect.
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), () => SHARE, now)
    await ctx.controlPlaneStore.openRun({
      record: {
        runId: RunId('run-elsewhere'), parentRunId: undefined,
        reserved: SHARE, spent: { tokens: 0, wallMs: 0, costMicroUsd: 0 }, leaseExpiresAt: now + 300_000,
      },
      userId: ALICE, sessionId: SESSION, accountId: ACCOUNT, runtime: AUDIENCE, settledSpent: undefined, absorbed: undefined,
    })
    await ctx.plugin(Llm)
    ctx.llm.registerAdapter(['fake'], new FakeAdapter())

    const seen: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream(request(SESSION))) seen.push(chunk)

    expect(seen).toEqual([{
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          message: "session 'session-1' is claimed by 2 open runs (run-root, run-elsewhere), so this call cannot be charged to one",
          code: 'RUN_NOT_OPEN',
        },
      },
    }])
  })

  it('refuses a second run on a session another run already drives', async () => {
    // The conflict is refused where it is created. Left to the metering
    // lookup, both runs open, hold their allowances, and every model call in
    // that session is refused one at a time — a tenant able to stop another
    // tenant's work by being minted onto its session.
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await provisionBobby(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), () => SHARE, now)

    const second = await ctx.runScheduler.start(
      mintExecutionAssertion(
        claims(now, { userId: BOBBY, accountId: ProviderAccountId('account-2'), runId: RunId('run-bobby'), nonce: 'n2' }),
        Buffer.from(SECRET, 'utf8'),
      ),
      () => SHARE,
      now,
    )

    expect(second).toMatchObject({
      started: false,
      rejection: {
        stage: 'admission',
        rejection: { stage: 'session', reason: 'already-driven', holder: RunId('run-root') },
      },
    })
    expect(ctx.runScheduler.ledger.open().map(record => record.runId)).toEqual([RunId('run-root')])
  })

  it('leaves the run that holds a session metering its own calls', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), () => SHARE, now)
    await ctx.runScheduler.start(
      mintExecutionAssertion(claims(now, { runId: RunId('run-2'), nonce: 'n2' }), Buffer.from(SECRET, 'utf8')),
      () => SHARE,
      now,
    )
    await ctx.plugin(Llm)
    ctx.llm.registerAdapter(['fake'], new FakeAdapter())

    const seen: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream(request(SESSION))) seen.push(chunk)

    expect(seen.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(ctx.runScheduler.ledger.get(RunId('run-root'))).toMatchObject({ spent: { tokens: 42 } })
  })

  describe("a provider binding's launch identity for a session", () => {
    it('resolves the pool, the opened credential, and what the run may still spend', async () => {
      root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
      const ctx = await boot(root)
      const now = Date.now()
      await provision(ctx, now)
      await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
      await ctx.runScheduler.charge(RunId('run-root'), { tokens: 40, wallMs: 0, costMicroUsd: 0 })

      const identity = await ctx.runScheduler.runIdentityFor(SESSION)

      expect(identity.ok).toBe(true)
      if (!identity.ok) return
      expect(identity.value.runId).toBe(RunId('run-root'))
      expect(identity.value.provider).toBe('claude-cli')
      expect(Buffer.from(identity.value.secret).toString('utf8')).toBe('sk-ant-alice')
      expect(identity.value.remaining).toMatchObject({ tokens: BUDGET.tokens - 40 })
      // The pool root is a pure function of tenant, provider and account, so a
      // caller can be shown the same value this method used without the
      // method exposing its derivation.
      const poolKey = runtimePoolKey({ userId: ALICE, provider: 'claude-cli', accountId: ACCOUNT })
      expect(identity.value.poolRoot).toBe(runtimePoolRoot(join(root, 'pools'), poolKey))
    })

    it('re-opens the credential on every call rather than caching the first', async () => {
      root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
      const ctx = await boot(root)
      const now = Date.now()
      await provision(ctx, now)
      await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
      const first = await ctx.runScheduler.runIdentityFor(SESSION)
      expect(first.ok).toBe(true)

      await revokeProviderAccount(ctx.controlPlaneStore, ALICE, ACCOUNT, now + 1)
      const second = await ctx.runScheduler.runIdentityFor(SESSION)

      // The revocation happened between the run's two calls; the second must
      // see it rather than reuse what the first already resolved.
      expect(second).toMatchObject({ ok: false, rejection: { reason: 'account-unusable' } })
    })

    it('refuses a session with no open run', async () => {
      root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
      const ctx = await boot(root)

      const identity = await ctx.runScheduler.runIdentityFor(SESSION)

      expect(identity).toMatchObject({ ok: false, rejection: { reason: 'no-open-run' } })
    })

    it('refuses a session whose run the ledger no longer holds open', async () => {
      // The store still answers for the run, but this runtime's live ledger
      // does not — the store's own opinion of "open" is not this runtime's.
      root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
      const ctx = await boot(root)
      const now = Date.now()
      await provision(ctx, now)
      await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
      vi.spyOn(ctx.runScheduler.ledger, 'remaining').mockReturnValue(undefined)

      const identity = await ctx.runScheduler.runIdentityFor(SESSION)

      expect(identity).toMatchObject({ ok: false, rejection: { reason: 'no-open-run' } })
    })

    it('refuses a run whose account has no stored credential to open', async () => {
      // The two are written together, so this is a storage inconsistency
      // rather than a state normal use reaches — the same reason `deleteRun`
      // and the store's other reads never trust a sibling read to agree.
      root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
      const ctx = await boot(root)
      const now = Date.now()
      await provision(ctx, now)
      await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
      vi.spyOn(ctx.controlPlaneStore, 'findCredential').mockResolvedValue(undefined)

      const identity = await ctx.runScheduler.runIdentityFor(SESSION)

      expect(identity).toMatchObject({ ok: false, rejection: { reason: 'no-credential', runId: RunId('run-root') } })
    })

    it('refuses a session two open runs both claim', async () => {
      // `start` refuses the second run onto one session, so this state arrives
      // only from outside it — another runtime sharing this audience, or a
      // direct record write, as in the equivalent metering test above.
      root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
      const ctx = await boot(root)
      const now = Date.now()
      await provision(ctx, now)
      await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), () => SHARE, now)
      await ctx.controlPlaneStore.openRun({
        record: {
          runId: RunId('run-elsewhere'), parentRunId: undefined,
          reserved: SHARE, spent: { tokens: 0, wallMs: 0, costMicroUsd: 0 }, leaseExpiresAt: now + 300_000,
        },
        userId: ALICE, sessionId: SESSION, accountId: ACCOUNT, runtime: AUDIENCE, settledSpent: undefined, absorbed: undefined,
      })

      const identity = await ctx.runScheduler.runIdentityFor(SESSION)

      expect(identity).toMatchObject({
        ok: false,
        rejection: { reason: 'claimed-by-several', runIds: [RunId('run-root'), RunId('run-elsewhere')] },
      })
    })

    it('records every open as a credential audit, success or failure', async () => {
      // Revocation is caught earlier, by the account check `findSessionRun`
      // already makes — it never reaches `openCredential` at all, so it is
      // not what exercises this method's own failure branch. A tampered
      // envelope is: the account stays usable, and the vault itself refuses.
      root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
      const ctx = await boot(root)
      const now = Date.now()
      await provision(ctx, now)
      await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
      const before = ctx.runScheduler.auditsOfTenant(ALICE).filter(record => record.event === 'credential').length

      const first = await ctx.runScheduler.runIdentityFor(SESSION)
      expect(first.ok).toBe(true)
      const entry = await ctx.controlPlaneStore.find(ACCOUNT)
      if (entry === undefined) throw new Error('the fixture account is not in the store')
      await ctx.controlPlaneStore.save({ ...entry, credential: { ...entry.credential, ciphertext: 'tampered' } })
      const second = await ctx.runScheduler.runIdentityFor(SESSION)
      expect(second).toMatchObject({ ok: false, rejection: { reason: 'corrupt' } })

      const opens = ctx.runScheduler.auditsOfTenant(ALICE)
        .filter(record => record.event === 'credential')
        .slice(before)
      expect(opens.map(record => record.outcome)).toEqual(['ok', 'corrupt'])
    })

    it('still resolves the identity when the trail cannot take the audit record', async () => {
      root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
      const ctx = await boot(root)
      const now = Date.now()
      await provision(ctx, now)
      await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
      vi.spyOn(ctx.controlPlaneStore, 'recordAudit').mockRejectedValue(new Error('medium is gone'))

      const identity = await ctx.runScheduler.runIdentityFor(SESSION)

      expect(identity.ok).toBe(true)
    })
  })

  describe('the tenant of a session', () => {
    it('resolves synchronously from the session\'s one open run', async () => {
      root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
      const ctx = await boot(root)
      const now = Date.now()
      await provision(ctx, now)
      await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)

      expect(ctx.runScheduler.tenantOf(SESSION)).toBe(ALICE)
    })

    it('answers undefined for a session with no open run', async () => {
      root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
      const ctx = await boot(root)

      expect(ctx.runScheduler.tenantOf(SESSION)).toBeUndefined()
    })

    it('answers undefined for a session two open runs both claim', async () => {
      // Mirrors the `runIdentityFor` ambiguity test: a session two runs both
      // name has no ONE tenant this method can answer for.
      root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
      const ctx = await boot(root)
      const now = Date.now()
      await provision(ctx, now)
      await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), () => SHARE, now)
      await ctx.controlPlaneStore.openRun({
        record: {
          runId: RunId('run-elsewhere'), parentRunId: undefined,
          reserved: SHARE, spent: { tokens: 0, wallMs: 0, costMicroUsd: 0 }, leaseExpiresAt: now + 300_000,
        },
        userId: ALICE, sessionId: SESSION, accountId: ACCOUNT, runtime: AUDIENCE, settledSpent: undefined, absorbed: undefined,
      })

      expect(ctx.runScheduler.tenantOf(SESSION)).toBeUndefined()
    })

    it('answers undefined for a run whose account is no longer usable', async () => {
      root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
      const ctx = await boot(root)
      const now = Date.now()
      await provision(ctx, now)
      await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
      await revokeProviderAccount(ctx.controlPlaneStore, ALICE, ACCOUNT, now + 1)

      expect(ctx.runScheduler.tenantOf(SESSION)).toBeUndefined()
    })
  })

  it('refuses a child that names another tenant, and bills nobody for it', async () => {
    // Without the check the child runs on the other tenant's credential while
    // its spend settles into this parent's tree: the parent's tenant funds work
    // it never authorized, and the child's tenant is billed nothing.
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await provisionBobby(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)

    const child = await ctx.runScheduler.start(
      mintExecutionAssertion(
        claims(now, {
          userId: BOBBY, accountId: ProviderAccountId('account-2'),
          runId: RunId('run-child'), parentRunId: RunId('run-root'),
          nonce: 'n2', sessionId: CHILD_SESSION,
        }),
        Buffer.from(SECRET, 'utf8'),
      ),
      () => SHARE,
      now,
    )

    expect(child).toMatchObject({
      started: false,
      rejection: { stage: 'admission', rejection: { stage: 'lineage', reason: 'tenant-mismatch' } },
    })
    expect(ctx.runScheduler.ledger.open().map(record => record.runId)).toEqual([RunId('run-root')])
  })

  it('refuses a child that names another account of its own tenant', async () => {
    // One account is not a subset of another: the parent held exactly one, and
    // a child reaching a second credential widens the grant it inherited.
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.controlPlaneStore.save({
      record: {
        id: ProviderAccountId('account-3'), userId: ALICE, provider: 'claude-cli', label: 'second',
        createdAt: now, updatedAt: now, validatedAt: undefined, revokedAt: undefined, deletedAt: undefined, isDefault: false,
      },
      credential: sealCredential(
        Buffer.from('sk-ant-alice-2', 'utf8'),
        { userId: ALICE, accountId: ProviderAccountId('account-3') },
        KEYRING,
        now,
      ).envelope,
    })
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)

    const child = await ctx.runScheduler.start(
      mintExecutionAssertion(
        claims(now, {
          accountId: ProviderAccountId('account-3'),
          runId: RunId('run-child'), parentRunId: RunId('run-root'),
          nonce: 'n2', sessionId: CHILD_SESSION,
        }),
        Buffer.from(SECRET, 'utf8'),
      ),
      () => SHARE,
      now,
    )

    expect(child).toMatchObject({
      started: false,
      rejection: { stage: 'admission', rejection: { stage: 'lineage', reason: 'account-mismatch' } },
    })
  })

  it('refuses a run on a revoked account, and records both the attempt and the refusal', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    const entry = await ctx.controlPlaneStore.find(ACCOUNT)
    expect(entry).toBeDefined()
    if (entry === undefined) return
    await ctx.controlPlaneStore.save({
      record: { ...entry.record, revokedAt: now + 1 },
      credential: revokeCredential(entry.credential, now + 1).envelope,
    })

    const outcome = await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)

    expect(outcome).toMatchObject({
      started: false,
      rejection: { stage: 'admission', rejection: { stage: 'credential', reason: 'revoked' } },
    })
    // The vault's own record of the attempt, and the refusal naming whose run
    // it was: an operator can see a revoked account being used, not just that
    // something was denied.
    expect(ctx.runScheduler.auditsOfTenant(ALICE)).toEqual([
      { at: expect.any(Number) as number, userId: ALICE, accountId: ACCOUNT, event: 'credential', action: 'open', outcome: 'revoked' },
      { at: now, runId: RunId('run-root'), userId: ALICE, accountId: ACCOUNT, event: 'refused', action: 'credential', outcome: 'revoked' },
    ])
  })

  it('refuses a call on a session whose run has ended', async () => {
    // A lease can expire under an agent that is still working. The run record
    // is gone by then, so without a memory of the ending its next call looks
    // like one this runtime never had and runs for free.
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
    await ctx.plugin(Llm)
    ctx.llm.registerAdapter(['fake'], new FakeAdapter())
    await ctx.runScheduler.sweep(now + 300_001)

    const seen: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream(request(SESSION))) seen.push(chunk)

    expect(seen).toEqual([{
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          message: "session 'session-1' has no open run: the run driving it has ended",
          code: 'RUN_NOT_OPEN',
        },
      },
    }])
  })

  it('meters a session again once a new run drives it', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), () => SHARE, now)
    await ctx.runScheduler.close(RunId('run-root'))
    await ctx.plugin(Llm)
    ctx.llm.registerAdapter(['fake'], new FakeAdapter())

    await ctx.runScheduler.start(
      mintExecutionAssertion(claims(now, { runId: RunId('run-2'), nonce: 'n2' }), Buffer.from(SECRET, 'utf8')),
      () => SHARE,
      now,
    )
    const seen: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream(request(SESSION))) seen.push(chunk)

    expect(seen.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(ctx.runScheduler.ledger.get(RunId('run-2'))).toMatchObject({ spent: { tokens: 42 } })
  })

  it('forgets an ended session once its memory is full', async () => {
    // The memory bounds what the runtime holds; an evicted session falls back
    // to passing its calls through.
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root, { endedSessionMemory: 1 })
    const now = Date.now()
    await provision(ctx, now)
    await ctx.plugin(Llm)
    ctx.llm.registerAdapter(['fake'], new FakeAdapter())
    for (const attempt of [0, 1]) {
      await ctx.runScheduler.start(
        mintExecutionAssertion(
          claims(now, {
            runId: RunId(`run-${String(attempt)}`),
            nonce: `n${String(attempt)}`,
            sessionId: brandString<SessionId>(`session-${String(attempt)}`),
          }),
          Buffer.from(SECRET, 'utf8'),
        ),
        () => SHARE,
        now,
      )
      await ctx.runScheduler.close(RunId(`run-${String(attempt)}`))
    }

    const evicted: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream(request(brandString<SessionId>('session-0')))) evicted.push(chunk)
    const remembered: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream(request(brandString<SessionId>('session-1')))) remembered.push(chunk)

    expect(evicted.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(remembered.at(-1)).toMatchObject({ reason: { kind: 'error', failure: { code: 'RUN_NOT_OPEN' } } })
  })

  it('records every attempt when a tenant starts several runs at once', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)

    await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map(attempt => ctx.runScheduler.start(
      mintExecutionAssertion(
        claims(now, {
          runId: RunId(`run-${String(attempt)}`),
          nonce: `n${String(attempt)}`,
          sessionId: brandString<SessionId>(`session-${String(attempt)}`),
        }),
        Buffer.from(SECRET, 'utf8'),
      ),
      () => SHARE,
      now,
    )))

    // Two records per attempt: the vault opening the credential, and the run
    // starting.
    expect(ctx.runScheduler.auditsOfTenant(ALICE)).toHaveLength(16)
  })

  it('never lets two concurrent starts hold more than the tenant was granted', async () => {
    // The allowance a start reads and the hold that consumes it sit on opposite
    // sides of an await. Both reads seeing the whole grant leaves the tenant
    // holding twice it.
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)

    const outcomes = await Promise.all([0, 1].map(attempt => ctx.runScheduler.start(
      mintExecutionAssertion(
        claims(now, {
          runId: RunId(`run-${String(attempt)}`),
          nonce: `n${String(attempt)}`,
          sessionId: brandString<SessionId>(`session-${String(attempt)}`),
        }),
        Buffer.from(SECRET, 'utf8'),
      ),
      undefined,
      now,
    )))

    expect(outcomes.filter(outcome => outcome.started)).toHaveLength(1)
    const held = ctx.runScheduler.ledger.open().reduce((sum, record) => sum + record.reserved.tokens, 0)
    expect(held).toBe(BUDGET.tokens)
  })

  it('lets only one of two concurrent starts take a session', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)

    const outcomes = await Promise.all([0, 1].map(attempt => ctx.runScheduler.start(
      mintExecutionAssertion(
        claims(now, { runId: RunId(`run-${String(attempt)}`), nonce: `n${String(attempt)}` }),
        Buffer.from(SECRET, 'utf8'),
      ),
      () => SHARE,
      now,
    )))

    expect(outcomes.filter(outcome => outcome.started)).toHaveLength(1)
    expect(outcomes.find(outcome => !outcome.started)).toMatchObject({
      rejection: { stage: 'admission', rejection: { stage: 'session', reason: 'already-driven' } },
    })
  })

  it('records what a started run did, against the tenant that ran it', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)

    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)

    expect(ctx.runScheduler.auditsOfTenant(ALICE)).toEqual([
      { at: expect.any(Number) as number, userId: ALICE, accountId: ACCOUNT, event: 'credential', action: 'open', outcome: 'ok' },
      { at: now, runId: RunId('run-root'), userId: ALICE, accountId: ACCOUNT, event: 'started', action: 'start', outcome: 'ok' },
    ])
  })

  it('records a denial against the tenant it refused', async () => {
    // A denied run is the event an audit trail exists for, and every stage past
    // the assertion knows whose run it refused.
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    const token = mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8'))

    await ctx.runScheduler.start(token, undefined, now)

    expect(ctx.runScheduler.auditsOfTenant(ALICE)).toEqual([
      { at: now, runId: RunId('run-root'), userId: ALICE, accountId: ACCOUNT, event: 'refused', action: 'budget', outcome: 'no-budget' },
    ])
  })

  it('files an unverifiable token against the runtime, not a tenant it cannot believe', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)

    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from('a-different-secret-of-32-bytes!!!', 'utf8')), undefined, now)

    expect(ctx.runScheduler.auditsOfRuntime())
      .toEqual([{ at: now, event: 'refused', action: 'assertion', outcome: 'signature' }])
    expect(ctx.runScheduler.auditsOfTenant(ALICE)).toEqual([])
  })

  it('records a run the ledger refused, naming whose it was', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), () => SHARE, now)

    // The same run id on a session of its own: the session check passes and the
    // ledger is what refuses.
    await ctx.runScheduler.start(
      mintExecutionAssertion(claims(now, { nonce: 'nonce-2', sessionId: SECOND_SESSION }), Buffer.from(SECRET, 'utf8')),
      () => SHARE,
      now,
    )

    expect(ctx.runScheduler.auditsOfTenant(ALICE).at(-1))
      .toEqual({ at: now, runId: RunId('run-root'), userId: ALICE, accountId: ACCOUNT, event: 'refused', action: 'ledger', outcome: 'duplicate-run' })
  })

  it('keeps only the most recent records a deployment asked to retain', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root, { auditRetention: 3 })
    const now = Date.now()

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await ctx.runScheduler.start(
        mintExecutionAssertion(claims(now, { runId: RunId(`run-${String(attempt)}`), nonce: `nonce-${String(attempt)}`, sessionId: brandString<SessionId>(`session-${String(attempt)}`) }), Buffer.from(SECRET, 'utf8')),
        undefined,
        now,
      )
    }

    expect(ctx.runScheduler.auditsOfTenant(ALICE).map(record => record.runId))
      .toEqual([RunId('run-2'), RunId('run-3'), RunId('run-4')])
  })

  it('keeps a tenant\'s records across a restart', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const first = await boot(root)
    const now = Date.now()
    await first.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
    await first.fiber.dispose()
    context = undefined

    const second = await boot(root)

    expect(second.runScheduler.auditsOfTenant(ALICE)).toHaveLength(1)
  })

  it('refuses a charge for a run that is not open', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)

    expect(await ctx.runScheduler.charge(RunId('run-absent'), { tokens: 1, wallMs: 1, costMicroUsd: 1 }))
      .toEqual({ ok: false, rejection: { reason: 'unknown-run', runId: RunId('run-absent') } })
  })

  it('settles an expired tree once, not once per record it held', async () => {
    // The sweep walks a snapshot, and settling the parent closes the child, so
    // the child it reaches next is already gone.
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
    await ctx.runScheduler.start(
      mintExecutionAssertion(
        claims(now, { runId: RunId('run-child'), parentRunId: RunId('run-root'), nonce: 'nonce-2', sessionId: CHILD_SESSION }),
        Buffer.from(SECRET, 'utf8'),
      ),
      () => SHARE,
      now,
    )
    await ctx.runScheduler.charge(RunId('run-child'), { tokens: 20, wallMs: 1, costMicroUsd: 1 })

    const settled = await ctx.runScheduler.sweep(now + 300_001)

    expect(settled.map(settlement => settlement.runId)).toEqual([RunId('run-root')])
    expect(await ctx.controlPlaneStore.tenantAllowance(ALICE)).toMatchObject({ consumed: { tokens: 20 } })
    expect(await ctx.controlPlaneStore.runsOf(AUDIENCE)).toEqual([])
  })

  it('returns a hold when the run it funded cannot be written down', async () => {
    // A run this runtime cannot record is one a restart would forget while its
    // provider kept spending, so the medium failure travels and the hold goes
    // back at once rather than at the lease.
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    vi.spyOn(ctx.controlPlaneStore, 'openRun').mockRejectedValue(new Error('medium is gone'))

    await expect(ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now))
      .rejects.toThrow(/medium is gone/)

    expect(ctx.runScheduler.ledger.open()).toEqual([])
  })

  it('finishes an interrupted settlement that still has descendants recorded', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const first = await boot(root)
    const now = Date.now()
    await provision(first, now)
    const settled = { tokens: 70, wallMs: 4, costMicroUsd: 5 }
    await first.controlPlaneStore.openRun({
      record: {
        runId: RunId('run-root'), parentRunId: undefined,
        reserved: BUDGET, spent: settled, leaseExpiresAt: now + 300_000,
      },
      userId: ALICE, sessionId: SESSION, accountId: ACCOUNT, runtime: AUDIENCE, settledSpent: settled, absorbed: undefined,
    })
    await first.controlPlaneStore.openRun({
      record: {
        runId: RunId('run-child'), parentRunId: RunId('run-root'),
        reserved: SHARE, spent: { tokens: 3, wallMs: 0, costMicroUsd: 0 }, leaseExpiresAt: now + 300_000,
      },
      userId: ALICE, sessionId: SESSION, accountId: ACCOUNT, runtime: AUDIENCE, settledSpent: undefined, absorbed: undefined,
    })
    await first.fiber.dispose()
    context = undefined

    const second = await boot(root)

    // The root's settled figure already covered its subtree, so the child is
    // forgotten with it rather than charged again.
    expect(await second.controlPlaneStore.tenantAllowance(ALICE)).toMatchObject({ consumed: settled })
    expect(await second.controlPlaneStore.runsOf(AUDIENCE)).toEqual([])
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
