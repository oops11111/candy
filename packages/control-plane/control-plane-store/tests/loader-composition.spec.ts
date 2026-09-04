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
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ProviderAccountId, UserId } from '@deepseek-ai/dsh-control-plane'
import {
  CredentialKeyVersion,
  sealCredential,
  type CredentialKeyring,
} from '@deepseek-ai/dsh-credential-vault'
import type { ProviderAccountEntry } from '@deepseek-ai/dsh-provider-accounts'
import type { RunBudget } from '@deepseek-ai/dsh-run-budget'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { afterEach, describe, expect, it } from 'vitest'
import ControlPlaneStore from '../src/index.ts'

const NOW = 1_800_000_000_000
const ALICE = UserId('user-alice')
const BOBBY = UserId('user-bobby')
const ACCOUNT = ProviderAccountId('account-1')
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

describe('a booted control-plane store', () => {
  it('registers on the context once the domain is open', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-cp-store-'))

    const ctx = await boot(root)

    expect(ctx.controlPlaneStore).toBeInstanceOf(ControlPlaneStore)
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

  it('answers the tenant budget port, and denies a tenant it does not know', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-cp-store-'))
    const ctx = await boot(root)
    await ctx.controlPlaneStore.setTenantBudget(ALICE, BUDGET)

    expect(await ctx.controlPlaneStore.tenantBudget(ALICE)).toEqual(BUDGET)
    expect(await ctx.controlPlaneStore.tenantBudget(BOBBY)).toBeUndefined()
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
  })

  it('reads back what an earlier boot wrote to the same database', async () => {
    // The point of the medium: a restart keeps the tenant's accounts and
    // allowance, which is what the in-memory ports could never do.
    root = await mkdtemp(join(tmpdir(), 'dsh-cp-store-'))
    const first = await boot(root)
    await first.controlPlaneStore.save(account())
    await first.controlPlaneStore.setTenantBudget(ALICE, BUDGET)
    await first.fiber.dispose()
    context = undefined

    const second = await boot(root)

    expect(await second.controlPlaneStore.tenantBudget(ALICE)).toEqual(BUDGET)
    expect(await second.controlPlaneStore.findCredential({ userId: ALICE, accountId: ACCOUNT }))
      .toMatchObject({ accountId: ACCOUNT })
  })
})
