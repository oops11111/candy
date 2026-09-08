/**
 * Real-composition guard: the storage hub, the SQLite backend, the domain
 * facility and this store boot from a test-only cordis.yml through the actual
 * Loader + Include path, and the ports `dsh-run-admission` requires are
 * answered from a real database file. Nothing here is replaced — the medium is
 * SQLite on disk, and a second boot over the same file reads what the first
 * wrote.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ConversationId, DeviceId, ProviderAccountId, RunId, UserId, WorkspaceGrantId } from '@deepseek-ai/dsh-control-plane'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  CredentialKeyVersion,
  sealCredential,
  type CredentialKeyring,
} from '@deepseek-ai/dsh-credential-vault'
import type { ProviderAccountEntry } from '@deepseek-ai/dsh-provider-accounts'
import type { RunBudget } from '@deepseek-ai/dsh-run-budget'
import type { WorkspaceGrantRecord } from '@deepseek-ai/dsh-workspace-grant'
import type { ExecutionAssertionClaims } from '@deepseek-ai/dsh-execution-assertion'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { afterEach, describe, expect, it } from 'vitest'
import ControlPlaneStore, { runtimeSubject, tenantSubject, type RunAuditRecord } from '../src/index.ts'

const NOW = 1_800_000_000_000
const ALICE = UserId('user-alice')
const SESSION = brandString<SessionId>('session-1')
const BOBBY = UserId('user-bobby')
const ACCOUNT = ProviderAccountId('account-1')
const DEVICE = DeviceId('device-1')
const WORKSPACE_GRANT = WorkspaceGrantId('grant-1')
const CONVERSATION = ConversationId('conversation-1')
const KEY_VERSION = CredentialKeyVersion('2026-09-a')
const KEYRING: CredentialKeyring = { currentVersion: KEY_VERSION, keys: new Map([[KEY_VERSION, Buffer.alloc(32, 5)]]) }
const BUDGET: RunBudget = { tokens: 100_000, wallMs: 600_000, costMicroUsd: 2_500_000, children: 4 }

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Boot the storage stack and this store over one database file. */
async function boot(at: string): Promise<Context> {
  const configPath = join(at, 'cordis.yml')
  await writeFile(configPath, [
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
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = `${pathToFileURL(at).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-storage', Storage],
    ['@deepseek-ai/dsh-storage-sqlite', StorageSqlite],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain],
    ['@deepseek-ai/dsh-control-plane-store', ControlPlaneStore],
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

function account(userId = ALICE, id = ACCOUNT): ProviderAccountEntry {
  return {
    record: {
      id,
      userId,
      provider: 'claude-cli',
      label: 'work',
      createdAt: NOW,
      updatedAt: NOW,
      validatedAt: undefined,
      revokedAt: undefined,
      deletedAt: undefined,
      isDefault: true,
    },
    credential: sealCredential(
      Buffer.from('sk-ant-alice', 'utf8'),
      { userId, accountId: id },
      KEYRING,
      NOW,
    ).envelope,
  }
}

function assertion(nonce = 'nonce-1'): ExecutionAssertionClaims {
  return {
    issuer: 'candy-control-plane',
    audience: 'candy-runtime-debian-1',
    userId: ALICE,
    deviceId: DEVICE,
    accountId: ACCOUNT,
    provider: 'claude-cli',
    workspaceGrantId: WORKSPACE_GRANT,
    conversationId: CONVERSATION,
    sessionId: SESSION,
    runId: RunId('run-1'),
    parentRunId: undefined,
    nonce,
    issuedAt: NOW,
    expiresAt: NOW + 60_000,
  }
}

describe('a booted control-plane store', () => {
  it('retains a spent nonce across a runtime restart and releases it after expiry', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-cp-store-'))
    const first = await boot(root)

    expect(await first.controlPlaneStore.spendNonce(assertion(), NOW)).toBe(true)
    expect(await first.controlPlaneStore.spendNonce(assertion(), NOW)).toBe(false)
    await first.fiber.dispose()
    context = undefined

    const restarted = await boot(root)
    expect(await restarted.controlPlaneStore.spendNonce(assertion(), NOW + 1)).toBe(false)
    expect(await restarted.controlPlaneStore.spendNonce(assertion(), NOW + 60_000)).toBe(true)
  })

  it('registers on the context once the domain is open', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-cp-store-'))

    const ctx = await boot(root)

    expect(ctx.controlPlaneStore).toBeInstanceOf(ControlPlaneStore)
  })

  it('persists an OAuth-backed browser session without exposing its bearer', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-cp-store-'))
    const first = await boot(root)
    const created = await first.controlPlaneStore.createUserSession(
      ALICE,
      'administrator',
      { issuer: 'https://identity.example', subject: 'oauth-alice' },
      NOW,
      NOW + 60_000,
    )

    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(created.record).toMatchObject({ userId: ALICE, role: 'administrator' })
    expect(JSON.stringify(created.record)).not.toContain(created.token)
    await first.fiber.dispose()
    context = undefined

    const restarted = await boot(root)
    expect(restarted.controlPlaneStore.authenticateUserSession(created.token, NOW + 1))
      .toEqual(created.record)
    expect(restarted.controlPlaneStore.authenticateUserSession(`${created.token}x`, NOW + 1))
      .toBeUndefined()
  })

  it('rejects expired and revoked browser sessions without trusting request identity', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-cp-store-'))
    const ctx = await boot(root)
    const created = await ctx.controlPlaneStore.createUserSession(
      ALICE,
      'member',
      { issuer: 'https://identity.example', subject: 'oauth-alice' },
      NOW,
      NOW + 10,
    )

    expect(ctx.controlPlaneStore.authenticateUserSession(created.token, NOW + 9)?.userId).toBe(ALICE)
    expect(ctx.controlPlaneStore.authenticateUserSession(created.token, NOW + 10)).toBeUndefined()
    expect(await ctx.controlPlaneStore.revokeUserSession(created.record.id, NOW + 5)).toBe(true)
    expect(ctx.controlPlaneStore.authenticateUserSession(created.token, NOW + 6)).toBeUndefined()
  })

  it('refuses invalid OAuth identity and session lifetime inputs', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-cp-store-'))
    const ctx = await boot(root)

    await expect(ctx.controlPlaneStore.createUserSession(
      ALICE, 'member', { issuer: ' ', subject: 'alice' }, NOW, NOW + 1,
    )).rejects.toThrow(/issuer and subject must be non-blank/)
    await expect(ctx.controlPlaneStore.createUserSession(
      ALICE, 'member', { issuer: 'issuer', subject: 'alice' }, NOW, NOW,
    )).rejects.toThrow(/expiry must be a safe integer after creation/)
  })

  it('answers the credential port a verified assertion names', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-cp-store-'))
    const ctx = await boot(root)
    await ctx.controlPlaneStore.save(account())

    const found = await ctx.controlPlaneStore.findCredential({ userId: ALICE, accountId: ACCOUNT })

    expect(found).toMatchObject({ userId: ALICE, accountId: ACCOUNT, keyVersion: KEY_VERSION })
  })

  it('answers nothing for an account it does not hold', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-cp-store-'))
    const ctx = await boot(root)

    expect(await ctx.controlPlaneStore.find(ACCOUNT)).toBeUndefined()
    expect(ctx.controlPlaneStore.accountOf(ACCOUNT)).toBeUndefined()
    expect(await ctx.controlPlaneStore.findCredential({ userId: ALICE, accountId: ACCOUNT })).toBeUndefined()
  })

  it('refuses an account that records another tenant', async () => {
    // The vault would refuse to open it; refusing here keeps a mismatch out of
    // the one call that could otherwise be handed the wrong envelope.
    root = await mkdtemp(join(tmpdir(), 'dsh-cp-store-'))
    const ctx = await boot(root)
    await ctx.controlPlaneStore.save(account())

    expect(await ctx.controlPlaneStore.findCredential({ userId: BOBBY, accountId: ACCOUNT })).toBeUndefined()
  })

  it('answers the tenant allowance, and denies a tenant it does not know', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-cp-store-'))
    const ctx = await boot(root)
    await ctx.controlPlaneStore.setTenantGrant(ALICE, BUDGET)

    expect(await ctx.controlPlaneStore.tenantAllowance(ALICE))
      .toEqual({ grant: BUDGET, consumed: { tokens: 0, wallMs: 0, costMicroUsd: 0 } })
    expect(await ctx.controlPlaneStore.tenantAllowance(BOBBY)).toBeUndefined()
  })

  it('persists exact tenant model routes across restart without crossing tenants', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-cp-store-'))
    const first = await boot(root)
    const routes = [
      { provider: 'claude-cli', model: 'sonnet' },
      { provider: 'codex-cli', model: 'gpt-5.4' },
    ]

    await first.controlPlaneStore.setTenantModelRoutes(ALICE, routes)
    expect(first.controlPlaneStore.tenantModelRoutes(BOBBY)).toBeUndefined()
    await first.fiber.dispose()
    context = undefined

    const restarted = await boot(root)
    expect(restarted.controlPlaneStore.tenantModelRoutes(ALICE)).toEqual(routes)
    expect(restarted.controlPlaneStore.tenantModelRoutes(BOBBY)).toBeUndefined()
  })

  it('adds the route table to an existing version-8 database without losing its records', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-cp-store-'))
    const first = await boot(root)
    await first.controlPlaneStore.save(account())
    await first.fiber.dispose()
    context = undefined

    // A version-8 deployment created before route policies has every existing
    // table and the same unit stamp, but no independently materialized route table.
    const database = new DatabaseSync(join(root, 'candy.db'))
    database.exec('DROP TABLE "u_candy_control_plane_tenant_routes"')
    database.close()

    const upgraded = await boot(root)
    expect(await upgraded.controlPlaneStore.find(ACCOUNT)).toMatchObject({ record: account().record })
    expect(upgraded.controlPlaneStore.tenantModelRoutes(ALICE)).toBeUndefined()
    await expect(upgraded.controlPlaneStore.setTenantModelRoutes(ALICE, [
      { provider: 'claude-cli', model: 'sonnet' },
    ])).resolves.toEqual([{ provider: 'claude-cli', model: 'sonnet' }])
  })

  it('persists deny-all and rejects malformed tenant model-route policies', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-cp-store-'))
    const ctx = await boot(root)

    expect(await ctx.controlPlaneStore.setTenantModelRoutes(ALICE, [])).toEqual([])
    expect(ctx.controlPlaneStore.tenantModelRoutes(ALICE)).toEqual([])
    await expect(ctx.controlPlaneStore.setTenantModelRoutes(ALICE, [
      { provider: 'claude-cli', model: 'sonnet' },
      { provider: 'claude-cli', model: 'sonnet' },
    ])).rejects.toThrow(/duplicate tenant model route/)
    await expect(ctx.controlPlaneStore.setTenantModelRoutes(ALICE, [
      { provider: ' ', model: 'sonnet' },
    ])).rejects.toThrow(/non-blank provider and model ids/)
  })

  it('adds a settled run to what the tenant has consumed, leaving the grant alone', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-cp-store-'))
    const ctx = await boot(root)
    await ctx.controlPlaneStore.setTenantGrant(ALICE, BUDGET)

    await ctx.controlPlaneStore.consumeTenantAllowance(ALICE, RunId('run-1'), { tokens: 40, wallMs: 500, costMicroUsd: 7 })
    const charged = await ctx.controlPlaneStore.consumeTenantAllowance(ALICE, RunId('run-2'), { tokens: 2, wallMs: 1, costMicroUsd: 0 })

    expect(charged).toEqual({ grant: BUDGET, consumed: { tokens: 42, wallMs: 501, costMicroUsd: 7 } })
    expect(await ctx.controlPlaneStore.tenantAllowance(ALICE)).toEqual(charged)
  })

  it('charges one settled run once, however often the charge is re-driven', async () => {
    // Charging the tenant and deleting the settled run record are two writes,
    // so a crash between them leaves a record a recovering runtime charges
    // again. The run's id rides in the same write as the charge.
    root = await mkdtemp(join(tmpdir(), 'dsh-cp-store-'))
    const ctx = await boot(root)
    await ctx.controlPlaneStore.setTenantGrant(ALICE, BUDGET)

    await ctx.controlPlaneStore.consumeTenantAllowance(ALICE, RunId('run-1'), { tokens: 40, wallMs: 0, costMicroUsd: 0 })
    await ctx.controlPlaneStore.consumeTenantAllowance(ALICE, RunId('run-1'), { tokens: 40, wallMs: 0, costMicroUsd: 0 })

    expect(await ctx.controlPlaneStore.tenantAllowance(ALICE)).toMatchObject({ consumed: { tokens: 40 } })
  })

  it('folds a settled child into its parent once, however often it is re-driven', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-cp-store-'))
    const ctx = await boot(root)
    await ctx.controlPlaneStore.openRun({
      record: {
        runId: RunId('run-root'), parentRunId: undefined,
        reserved: BUDGET, spent: { tokens: 5, wallMs: 0, costMicroUsd: 0 }, leaseExpiresAt: NOW,
      },
      userId: ALICE, sessionId: SESSION, accountId: ACCOUNT,
      deviceId: DEVICE, workspaceGrantId: WORKSPACE_GRANT, conversationId: CONVERSATION,
      runtime: 'runtime-1', settledSpent: undefined, absorbed: undefined,
    })
    expect(ctx.controlPlaneStore.isManagedSession(SESSION, 'runtime-1')).toBe(true)
    expect(ctx.controlPlaneStore.isManagedSession(SESSION, 'runtime-2')).toBe(false)

    await ctx.controlPlaneStore.absorbChild(RunId('run-root'), RunId('run-child'), { tokens: 30, wallMs: 1, costMicroUsd: 2 })
    await ctx.controlPlaneStore.absorbChild(RunId('run-root'), RunId('run-child'), { tokens: 30, wallMs: 1, costMicroUsd: 2 })

    const [stored] = await ctx.controlPlaneStore.runsOf('runtime-1')
    expect(stored).toMatchObject({ record: { spent: { tokens: 35, wallMs: 1, costMicroUsd: 2 } }, absorbed: RunId('run-child') })
  })

  it('keeps one subject\'s most recent records and drops the rest', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-cp-store-'))
    const ctx = await boot(root)
    const subject = tenantSubject(ALICE)
    // Distinct runs: identical records fold into one instead of accumulating.
    const record = (at: number): RunAuditRecord =>
      ({ at, runId: RunId(`run-${String(at)}`), event: 'started', action: 'start', outcome: 'ok' })

    await ctx.controlPlaneStore.recordAudit(subject, [record(1), record(2)], 3)
    const kept = await ctx.controlPlaneStore.recordAudit(subject, [record(3), record(4)], 3)

    expect(kept.map(entry => entry.at)).toEqual([2, 3, 4])
    expect(ctx.controlPlaneStore.auditsOf(subject).map(entry => entry.at)).toEqual([2, 3, 4])
  })

  it('writes nothing when an attempt produced no records', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-cp-store-'))
    const ctx = await boot(root)
    const subject = runtimeSubject('runtime-1')

    expect(await ctx.controlPlaneStore.recordAudit(subject, [], 3)).toEqual([])
    expect(ctx.controlPlaneStore.auditsOf(subject)).toEqual([])
  })

  it('refuses a retention that is not a positive safe integer', async () => {
    // A deployment error rather than a record to drop: silently keeping one
    // would be a retention nobody chose.
    root = await mkdtemp(join(tmpdir(), 'dsh-cp-store-'))
    const ctx = await boot(root)
    const record: RunAuditRecord = { at: 1, event: 'started', action: 'start', outcome: 'ok' }

    await expect(ctx.controlPlaneStore.recordAudit(tenantSubject(ALICE), [record], 0))
      .rejects.toThrow(/audit retention must be a positive safe integer, got 0/)
  })

  it('answers nothing for a run it holds no record for', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-cp-store-'))
    const ctx = await boot(root)

    expect(ctx.controlPlaneStore.findRun(RunId('run-absent'))).toBeUndefined()
  })

  it('keeps every record when appends arrive at once', async () => {
    // The domain serializes each write but not the read that decides what to
    // write. Reading a trail before another append lands drops that append.
    root = await mkdtemp(join(tmpdir(), 'dsh-cp-store-'))
    const ctx = await boot(root)
    const subject = tenantSubject(ALICE)

    await Promise.all(Array.from({ length: 32 }, (_unused, index) => ctx.controlPlaneStore.recordAudit(
      subject,
      [{ at: index, runId: RunId(`run-${String(index)}`), event: 'started', action: 'start', outcome: 'ok' }],
      1_000,
    )))

    expect(ctx.controlPlaneStore.auditsOf(subject)).toHaveLength(32)
  })

  it('folds a record that says the same thing again into a count', async () => {
    // A bounded trail is rewritten whole, so a repeating event pushes the
    // subject's earlier history out one record at a time — which makes the
    // trail erasable by whoever causes the repetition.
    root = await mkdtemp(join(tmpdir(), 'dsh-cp-store-'))
    const ctx = await boot(root)
    const subject = tenantSubject(ALICE)
    const opened: RunAuditRecord = { at: 1, userId: ALICE, accountId: ACCOUNT, event: 'credential', action: 'open', outcome: 'ok' }
    const refused = (at: number): RunAuditRecord =>
      ({ at, runId: RunId('run-1'), event: 'refused', action: 'meter', outcome: 'CREDENTIAL_REVOKED' })

    await ctx.controlPlaneStore.recordAudit(subject, [opened], 2)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await ctx.controlPlaneStore.recordAudit(subject, [refused(attempt + 2)], 2)
    }

    expect(ctx.controlPlaneStore.auditsOf(subject)).toEqual([
      opened,
      { ...refused(6), count: 5 },
    ])
  })

  it('keeps two records apart when any field but the instant differs', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-cp-store-'))
    const ctx = await boot(root)
    const subject = tenantSubject(ALICE)
    const base: RunAuditRecord = { at: 1, runId: RunId('run-1'), event: 'refused', action: 'meter', outcome: 'RUN_NOT_OPEN' }

    await ctx.controlPlaneStore.recordAudit(subject, [
      base,
      { ...base, at: 2, outcome: 'CREDENTIAL_REVOKED' },
      { ...base, at: 3, runId: RunId('run-2'), outcome: 'CREDENTIAL_REVOKED' },
      { ...base, at: 4, runId: RunId('run-2'), outcome: 'CREDENTIAL_REVOKED', userId: ALICE },
    ], 10)

    expect(ctx.controlPlaneStore.auditsOf(subject)).toHaveLength(4)
  })

  it('charges every settlement when they arrive at once', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-cp-store-'))
    const ctx = await boot(root)
    await ctx.controlPlaneStore.setTenantGrant(ALICE, BUDGET)

    await Promise.all(Array.from({ length: 32 }, (_unused, index) => ctx.controlPlaneStore.consumeTenantAllowance(
      ALICE,
      RunId(`run-${String(index)}`),
      { tokens: 1, wallMs: 0, costMicroUsd: 0 },
    )))

    expect(await ctx.controlPlaneStore.tenantAllowance(ALICE)).toMatchObject({ consumed: { tokens: 32 } })
  })

  it('keeps writing after a queued write fails', async () => {
    // One rejected read-modify-write must not poison the chain the rest queue on.
    root = await mkdtemp(join(tmpdir(), 'dsh-cp-store-'))
    const ctx = await boot(root)
    await ctx.controlPlaneStore.setTenantGrant(ALICE, BUDGET)

    const [refused] = await Promise.allSettled([
      ctx.controlPlaneStore.consumeTenantAllowance(ALICE, RunId('run-bad'), { tokens: -1, wallMs: 0, costMicroUsd: 0 }),
      ctx.controlPlaneStore.consumeTenantAllowance(ALICE, RunId('run-good'), { tokens: 5, wallMs: 0, costMicroUsd: 0 }),
    ])

    expect(refused).toMatchObject({ status: 'rejected' })
    expect(await ctx.controlPlaneStore.tenantAllowance(ALICE)).toMatchObject({ consumed: { tokens: 5 } })
  })

  it('keeps a tenant\'s consumption when its grant changes at the same time', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-cp-store-'))
    const ctx = await boot(root)
    await ctx.controlPlaneStore.setTenantGrant(ALICE, BUDGET)

    await Promise.all([
      ctx.controlPlaneStore.consumeTenantAllowance(ALICE, RunId('run-1'), { tokens: 7, wallMs: 0, costMicroUsd: 0 }),
      ctx.controlPlaneStore.setTenantGrant(ALICE, { ...BUDGET, tokens: BUDGET.tokens * 2 }),
    ])

    expect(await ctx.controlPlaneStore.tenantAllowance(ALICE))
      .toEqual({ grant: { ...BUDGET, tokens: BUDGET.tokens * 2 }, consumed: { tokens: 7, wallMs: 0, costMicroUsd: 0 } })
  })

  it('writes nothing about a run it holds no record for', async () => {
    // Only a live ledger can say a run exists; the medium answers for records.
    root = await mkdtemp(join(tmpdir(), 'dsh-cp-store-'))
    const ctx = await boot(root)
    const missing = RunId('run-absent')

    await ctx.controlPlaneStore.recordRunSpend(missing, { tokens: 1, wallMs: 1, costMicroUsd: 1 })
    await ctx.controlPlaneStore.renewRun(missing, Date.now() + 300_000)
    await ctx.controlPlaneStore.absorbChild(missing, RunId('run-child'), { tokens: 1, wallMs: 1, costMicroUsd: 1 })

    // Settling is the exception: a run open in a ledger always has a record, so
    // an absent one is a lost write rather than a run to settle quietly.
    await expect(ctx.controlPlaneStore.markRunSettled(missing, { tokens: 1, wallMs: 1, costMicroUsd: 1 }))
      .rejects.toThrow(/run-absent/)
    expect(await ctx.controlPlaneStore.deleteRun(missing)).toBe(false)
    expect(await ctx.controlPlaneStore.runsOf('runtime-1')).toEqual([])
  })

  it('charges nothing for a tenant it holds no allowance for', async () => {
    // A charge with nowhere to land is reported rather than written under a
    // tenant record the operator never created.
    root = await mkdtemp(join(tmpdir(), 'dsh-cp-store-'))
    const ctx = await boot(root)

    expect(await ctx.controlPlaneStore.consumeTenantAllowance(BOBBY, RunId('run-1'), { tokens: 1, wallMs: 1, costMicroUsd: 1 }))
      .toBeUndefined()
    expect(await ctx.controlPlaneStore.tenantAllowance(BOBBY)).toBeUndefined()
  })

  it('keeps what a tenant consumed when its grant is changed', async () => {
    // Raising a quota mid-period means the tenant may spend more in total, not
    // that its history was erased.
    root = await mkdtemp(join(tmpdir(), 'dsh-cp-store-'))
    const ctx = await boot(root)
    await ctx.controlPlaneStore.setTenantGrant(ALICE, BUDGET)
    await ctx.controlPlaneStore.consumeTenantAllowance(ALICE, RunId('run-1'), { tokens: 40, wallMs: 0, costMicroUsd: 0 })

    const raised = await ctx.controlPlaneStore.setTenantGrant(ALICE, { ...BUDGET, tokens: BUDGET.tokens * 2 })

    expect(raised).toEqual({ grant: { ...BUDGET, tokens: BUDGET.tokens * 2 }, consumed: { tokens: 40, wallMs: 0, costMicroUsd: 0 } })
  })

  it('lists one tenant\'s accounts without another tenant\'s', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-cp-store-'))
    const ctx = await boot(root)
    await ctx.controlPlaneStore.save(account())
    await ctx.controlPlaneStore.save(account(BOBBY, ProviderAccountId('account-2')))

    const owned = await ctx.controlPlaneStore.listByUser(ALICE)

    expect(owned.map(entry => entry.record.id)).toEqual([ACCOUNT])
  })

  it('round-trips an account whose every optional timestamp is set', async () => {
    // JSON drops an undefined property, so the absent and present forms take
    // different paths through the stored shape; a revoked, rewrapped, deleted
    // account exercises the one the fixtures above do not.
    root = await mkdtemp(join(tmpdir(), 'dsh-cp-store-'))
    const ctx = await boot(root)
    const base = account()
    const populated: ProviderAccountEntry = {
      record: { ...base.record, validatedAt: NOW + 1, revokedAt: NOW + 2, deletedAt: NOW + 3 },
      credential: { ...base.credential, rewrappedAt: NOW + 4, revokedAt: NOW + 5 },
    }

    await ctx.controlPlaneStore.save(populated)

    expect(await ctx.controlPlaneStore.find(ACCOUNT)).toEqual(populated)
    // The synchronous reader answers the same record, minus the credential a
    // metering decision has no business touching.
    expect(ctx.controlPlaneStore.accountOf(ACCOUNT)).toEqual(populated.record)
  })

  it('reads back what an earlier boot wrote to the same database', async () => {
    // The point of the medium: a restart keeps the tenant's accounts and
    // allowance, which is what the in-memory ports could never do.
    root = await mkdtemp(join(tmpdir(), 'dsh-cp-store-'))
    const first = await boot(root)
    await first.controlPlaneStore.save(account())
    await first.controlPlaneStore.setTenantGrant(ALICE, BUDGET)
    await first.controlPlaneStore.consumeTenantAllowance(ALICE, RunId('run-1'), { tokens: 9, wallMs: 8, costMicroUsd: 7 })
    await first.fiber.dispose()
    context = undefined

    const second = await boot(root)

    expect(await second.controlPlaneStore.tenantAllowance(ALICE))
      .toEqual({ grant: BUDGET, consumed: { tokens: 9, wallMs: 8, costMicroUsd: 7 } })
    expect(await second.controlPlaneStore.findCredential({ userId: ALICE, accountId: ACCOUNT }))
      .toMatchObject({ accountId: ACCOUNT })
  })

  it('keeps a workspace grant, and its revocation, across a restart', async () => {
    // A grant that did not survive the process would let a revoked one come
    // back as never-issued, and every run naming a live one be refused at boot.
    root = await mkdtemp(join(tmpdir(), 'dsh-cp-store-'))
    const first = await boot(root)
    const grant: WorkspaceGrantRecord = {
      id: WorkspaceGrantId('grant-1'),
      userId: ALICE,
      deviceId: DEVICE,
      roots: ['/srv/candy/alice', '/srv/candy/shared'],
      mode: 'workspace-write',
      version: 2,
      createdAt: NOW,
      updatedAt: NOW,
      revokedAt: undefined,
    }
    await first.controlPlaneStore.saveGrant(grant)
    await first.controlPlaneStore.saveGrant({
      id: WorkspaceGrantId('grant-2'), userId: ALICE, deviceId: DEVICE,
      roots: [], mode: 'read-only', version: 1,
      createdAt: NOW, updatedAt: NOW + 1, revokedAt: NOW + 1,
    })
    await first.fiber.dispose()
    context = undefined

    const second = await boot(root)

    expect(await second.controlPlaneStore.findGrant(WorkspaceGrantId('grant-1'))).toEqual(grant)
    expect(await second.controlPlaneStore.findGrant(WorkspaceGrantId('grant-2')))
      .toMatchObject({ roots: [], mode: 'read-only', revokedAt: NOW + 1 })
    expect(await second.controlPlaneStore.findGrant(WorkspaceGrantId('grant-9'))).toBeUndefined()
  })
})
