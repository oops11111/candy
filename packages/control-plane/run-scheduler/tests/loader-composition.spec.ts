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
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { RunBudget } from '@deepseek-ai/dsh-run-budget'
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
function schedulerEntry(at: string, overrides: Readonly<Record<string, number>>): readonly string[] {
  return [
    '- id: run-scheduler',
    "  name: '@deepseek-ai/dsh-run-scheduler'",
    '  config:',
    `    issuer: ${JSON.stringify(ISSUER)}`,
    `    audience: ${JSON.stringify(AUDIENCE)}`,
    `    credentialKeyVersion: ${JSON.stringify(KEY_VERSION)}`,
    `    poolBase: ${JSON.stringify(join(at, 'pools'))}`,
    ...Object.entries(overrides).map(([key, value]) => `    ${key}: ${String(value)}`),
  ]
}

async function boot(
  at: string,
  overrides: Readonly<Record<string, number>> = {},
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
    await ctx.runScheduler.charge(RunId('run-root'), { tokens: BUDGET.tokens, wallMs: 1, costMicroUsd: 1 })
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
        claims(now, { runId: RunId('run-child'), parentRunId: RunId('run-root'), nonce: 'nonce-2' }),
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

  it('refuses a request whose session two open runs both claim', async () => {
    // Charging either tree would be a misbilling the caller cannot detect, so
    // the bookkeeping error stops the call instead.
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root)
    const now = Date.now()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), () => SHARE, now)
    await ctx.runScheduler.start(
      mintExecutionAssertion(claims(now, { runId: RunId('run-2'), nonce: 'nonce-2' }), Buffer.from(SECRET, 'utf8')),
      () => SHARE,
      now,
    )
    await ctx.plugin(Llm)
    ctx.llm.registerAdapter(['fake'], new FakeAdapter())

    const seen: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream(request(SESSION))) seen.push(chunk)

    expect(seen).toEqual([{
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          message: "session 'session-1' is claimed by 2 open runs (run-root, run-2), so this call cannot be charged to one",
          code: 'RUN_NOT_OPEN',
        },
      },
    }])
  })

  it('stops metering when its own fiber is disposed', async () => {
    // A listener that outlived its service would meter against a ledger nobody
    // owns, which is what the disposal contract exists to prevent.
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const ctx = await boot(root, {}, false)
    const now = Date.now()
    const fiber = ctx.plugin(RunScheduler, {
      issuer: ISSUER,
      audience: AUDIENCE,
      credentialKeyVersion: KEY_VERSION,
      poolBase: join(root, 'pools'),
    })
    await ctx.loader.await()
    await provision(ctx, now)
    await ctx.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
    await ctx.plugin(Llm)
    ctx.llm.registerAdapter(['fake'], new FakeAdapter())
    const scheduler = ctx.runScheduler

    await fiber.dispose()

    const seen: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream(request(SESSION))) seen.push(chunk)

    expect(seen.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(scheduler.ledger.get(RunId('run-root'))).toMatchObject({ spent: { tokens: 0 } })
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

    await ctx.runScheduler.start(
      mintExecutionAssertion(claims(now, { nonce: 'nonce-2' }), Buffer.from(SECRET, 'utf8')),
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
        mintExecutionAssertion(claims(now, { runId: RunId(`run-${String(attempt)}`), nonce: `nonce-${String(attempt)}` }), Buffer.from(SECRET, 'utf8')),
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
        claims(now, { runId: RunId('run-child'), parentRunId: RunId('run-root'), nonce: 'nonce-2' }),
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
      userId: ALICE, sessionId: SESSION, runtime: AUDIENCE, settledSpent: settled, absorbed: undefined,
    })
    await first.controlPlaneStore.openRun({
      record: {
        runId: RunId('run-child'), parentRunId: RunId('run-root'),
        reserved: SHARE, spent: { tokens: 3, wallMs: 0, costMicroUsd: 0 }, leaseExpiresAt: now + 300_000,
      },
      userId: ALICE, sessionId: SESSION, runtime: AUDIENCE, settledSpent: undefined, absorbed: undefined,
    })
    await first.fiber.dispose()
    context = undefined

    const second = await boot(root)

    // The root's settled figure already covered its subtree, so the child is
    // forgotten with it rather than charged again.
    expect(await second.controlPlaneStore.tenantAllowance(ALICE)).toMatchObject({ consumed: settled })
    expect(await second.controlPlaneStore.runsOf(AUDIENCE)).toEqual([])
  })

  it('refuses to boot on records that do not form complete trees', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
    const first = await boot(root)
    const now = Date.now()
    await provision(first, now)
    await first.controlPlaneStore.openRun({
      record: {
        runId: RunId('run-orphan'), parentRunId: RunId('run-gone'),
        reserved: SHARE, spent: { tokens: 0, wallMs: 0, costMicroUsd: 0 }, leaseExpiresAt: now + 300_000,
      },
      userId: ALICE,
      sessionId: SESSION,
      runtime: AUDIENCE,
      settledSpent: undefined,
      absorbed: undefined,
    })
    await first.fiber.dispose()
    context = undefined

    await expect(boot(root)).rejects.toThrow(/names parent 'run-gone', which no record supplies/)
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
