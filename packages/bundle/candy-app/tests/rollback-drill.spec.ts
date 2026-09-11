/**
 * The rollback the deployment page promises, performed rather than described.
 *
 * Two claims are being checked. The page tells an operator to take an online
 * backup and not to use `cp`, because a copy taken mid-write opens and is
 * missing rows; and it tells them a restored database is one the runtime boots
 * over. Neither was ever executed, and a backup procedure nobody has run is a
 * procedure an operator discovers is wrong during an incident.
 *
 * The control plane writes continuously here — provider accounts through the
 * real store, over the real SQLite backend — while the backup is taken, so the
 * copy is genuinely concurrent with writers rather than a quiet-file copy that
 * would prove nothing.
 */

import { execFile } from 'node:child_process'
import { copyFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { ProviderAccountId, UserId } from '@deepseek-ai/dsh-control-plane'
import { CredentialKeyVersion, sealCredential, type CredentialKeyring } from '@deepseek-ai/dsh-credential-vault'
import type { ProviderAccountEntry } from '@deepseek-ai/dsh-provider-accounts'
import ControlPlaneStore from '@deepseek-ai/dsh-control-plane-store'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const BACKUP_TOOL = fileURLToPath(new URL('../deploy/candy-backup.mjs', import.meta.url))
const ALICE = UserId('user-alice')
const KEY_VERSION = CredentialKeyVersion('2026-09-a')
const KEYRING: CredentialKeyring = { currentVersion: KEY_VERSION, keys: new Map([[KEY_VERSION, Buffer.alloc(32, 7)]]) }

let root: string | undefined
const running: Context[] = []

afterEach(async () => {
  await Promise.all(running.splice(0).map(ctx => ctx.fiber.dispose()))
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Boot the store over one database file, as the shipped layer routes it. */
async function boot(path: string): Promise<Context> {
  const ctx = new Context()
  running.push(ctx)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageSqlite, { path })
  await ctx.plugin(StorageDomain, { backend: 'sqlite' })
  await ctx.plugin(ControlPlaneStore)
  await ctx.fiber.await()
  return ctx
}

/** One account of Alice's, numbered so a restore can be counted. */
function account(index: number): ProviderAccountEntry {
  const id = ProviderAccountId(`account-${String(index).padStart(4, '0')}`)
  return {
    record: {
      id,
      userId: ALICE,
      provider: 'deepseek-api',
      label: `work ${String(index)}`,
      createdAt: 1_800_000_000_000 + index,
      updatedAt: 1_800_000_000_000 + index,
      validatedAt: undefined,
      revokedAt: undefined,
      deletedAt: undefined,
      isDefault: index === 0,
    },
    credential: sealCredential(
      Buffer.from(`sk-alice-${String(index)}`, 'utf8'),
      { userId: ALICE, accountId: id },
      KEYRING,
      1_800_000_000_000,
    ).envelope,
  }
}

/** Count the rows a restored database holds, without the harness. */
function storedAccounts(path: string): number {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    const table = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%accounts%'")
      .get() as { name?: string } | undefined
    if (table?.name === undefined) return 0
    const counted = database.prepare(`SELECT count(*) AS c FROM "${table.name}"`).get() as { c: number }
    return counted.c
  } finally {
    database.close()
  }
}

describe('the rollback drill the deployment page documents', () => {
  it('takes an online backup while the control plane is writing, and boots over the restore', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-candy-rollback-'))
    const live = join(root, 'control-plane.db')
    const ctx = await boot(live)

    // Writers that do not stop for the backup. Each save is a queued
    // read-modify-write through the real store, so the file is being changed
    // while the copy runs.
    let writing = true
    let written = 0
    const writer = (async () => {
      for (let index = 0; writing && index < 400; index += 1) {
        await ctx.controlPlaneStore.save(account(index))
        written += 1
      }
    })()
    while (written < 8) await new Promise(resolve => setTimeout(resolve, 5))

    const backup = join(root, 'backup.db')
    await execFileAsync(process.execPath, [BACKUP_TOOL, live, backup])
    const captured = storedAccounts(backup)

    writing = false
    await writer

    // The backup is a point in time, not the end state: it holds what was
    // committed when it ran, and that is what a restore gets back.
    expect(captured).toBeGreaterThan(0)
    expect(captured).toBeLessThanOrEqual(written)

    // The restore is what the page tells an operator to do: put the file back
    // and start the service. A database that boots and answers is the claim.
    await Promise.all(running.splice(0).map(one => one.fiber.dispose()))
    const restored = join(root, 'restored.db')
    copyFileSync(backup, restored)
    const second = await boot(restored)

    const accounts = await second.controlPlaneStore.listByUser(ALICE)
    expect(accounts).toHaveLength(captured)
    // Every credential in the restore still opens under the same keyring, so
    // the restore is usable rather than merely readable.
    const first = await second.controlPlaneStore.findCredential({
      userId: ALICE, accountId: ProviderAccountId('account-0000'),
    })
    expect(first).toMatchObject({ userId: ALICE, keyVersion: KEY_VERSION })
  }, 120_000)

  it('shows what copying the database file alone loses', async () => {
    // The backend runs WAL by default, so recent commits live in the `-wal`
    // file beside the database. A `cp` of the database alone is therefore not
    // a slightly stale backup: it can be a file with no schema in it at all,
    // which is stronger than "missing rows" and is why the tool exists.
    root = await mkdtemp(join(tmpdir(), 'dsh-candy-rollback-'))
    const live = join(root, 'control-plane.db')
    const ctx = await boot(live)
    for (let index = 0; index < 24; index += 1) await ctx.controlPlaneStore.save(account(index))
    expect(await ctx.controlPlaneStore.listByUser(ALICE)).toHaveLength(24)

    const partial = join(root, 'cp-of-main-file.db')
    copyFileSync(live, partial)
    const online = join(root, 'online.db')
    await execFileAsync(process.execPath, [BACKUP_TOOL, live, online])

    // The online backup holds every committed account; the file copy holds
    // fewer, and on a database this young it holds none.
    expect(storedAccounts(online)).toBe(24)
    expect(storedAccounts(partial)).toBeLessThan(24)
  }, 120_000)

  it('refuses to write a destination when the source is not there', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-candy-rollback-'))
    const destination = join(root, 'backup.db')

    // A backup must not create the database it was asked to copy: an operator
    // who mistypes the source needs an error, not an empty file that restores.
    await expect(execFileAsync(process.execPath, [BACKUP_TOOL, join(root, 'absent.db'), destination]))
      .rejects.toMatchObject({ code: 1 })
    expect(() => storedAccounts(destination)).toThrow()
  }, 60_000)

  it('reports its usage rather than guessing what an operator meant', async () => {
    await expect(execFileAsync(process.execPath, [BACKUP_TOOL])).rejects.toMatchObject({ code: 2 })
  }, 60_000)
})
