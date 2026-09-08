/** The Candy grant is proven through the inherited filesystem executor. */

import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { DeviceId, UserId, WorkspaceGrantId } from '@deepseek-ai/dsh-control-plane'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceGrantRecord } from '@deepseek-ai/dsh-workspace-grant'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WorkspaceGrantExecution from '../src/index.ts'

const ALICE = UserId('user-alice')
const DEVICE = DeviceId('device-1')
const GRANT_ID = WorkspaceGrantId('grant-1')
const SESSION = SessionId('session-1')

let base: string
let root: string
let outside: string
let grant: WorkspaceGrantRecord | undefined
let ctx: Context

function record(mode: SandboxMode = 'workspace-write'): WorkspaceGrantRecord {
  return {
    id: GRANT_ID,
    userId: ALICE,
    deviceId: DEVICE,
    roots: [root],
    mode,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    revokedAt: undefined,
  }
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'candy-workspace-authority-'))
  root = join(base, 'root')
  outside = join(base, 'outside')
  await mkdir(root)
  await mkdir(outside)
  grant = record()
  ctx = new Context()
  ctx.provide('controlPlaneStore', {
    findGrant: async () => grant,
    grantSnapshot: () => grant,
  } as never)
  ctx.provide('runScheduler', {
    runOfSession: (sessionId: SessionId) => sessionId === SESSION
      ? { userId: ALICE, deviceId: DEVICE, workspaceGrantId: GRANT_ID }
      : undefined,
  } as never)
  ctx.provide('sandboxPolicy', {
    defaultMode: 'workspace-write',
    resolve: () => ({ mode: 'workspace-write', workspaceRoot: root, sessionId: SESSION }),
  } as never)
  new WorkspaceGrantExecution(ctx)
  new SandboxedFileSystem(ctx, { cwd: root, diffBasisMaxBytes: 10 * 1024 * 1024 })
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(base, { recursive: true, force: true })
})

describe('workspace grant enforcement at the filesystem executor', () => {
  it('allows a granted read and write while rejecting paths outside the canonical root', async () => {
    await ctx.workspaceAuthority.enter(SESSION, async () => {
      const inside = await ctx.fs.resolve(join(root, 'inside.txt'))
      await ctx.fs.writeText(inside, 'inside')
      expect(await ctx.fs.readText(inside)).toBe('inside')
      await expect(ctx.fs.resolve(join(outside, 'outside.txt')))
        .rejects.toThrow('path is outside granted roots')
    })
  })

  it('rejects writes under a read-only grant at the executor', async () => {
    grant = record('read-only')
    await ctx.workspaceAuthority.enter(SESSION, async () => {
      const target = await ctx.fs.resolve(join(root, 'denied.txt'))
      await expect(ctx.fs.writeText(target, 'denied')).rejects.toThrow('grant is read-only')
    })
  })

  it('revalidates revocation before a later operation in the same dispatch', async () => {
    const path = join(root, 'present.txt')
    await writeFile(path, 'present')
    await ctx.workspaceAuthority.enter(SESSION, async () => {
      const target = await ctx.fs.resolve(path)
      expect(await ctx.fs.readText(target)).toBe('present')
      grant = { ...record(), revokedAt: 2, updatedAt: 2 }
      await expect(ctx.fs.readText(target)).rejects.toThrow('grant is unavailable')
    })
  })

  it('rejects a symbolic-link or junction escape after local canonicalization', async () => {
    const secret = join(outside, 'secret.txt')
    await writeFile(secret, 'outside')
    const link = join(root, 'escape')
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    await ctx.workspaceAuthority.enter(SESSION, async () => {
      await expect(ctx.fs.resolve(join(link, 'secret.txt'))).rejects.toThrow('path is outside granted roots')
    })
    expect(await readFile(secret, 'utf8')).toBe('outside')
  })

  it('rejects a grant whose tenant or device differs from the admitted run', async () => {
    grant = { ...record(), userId: UserId('user-bobby') }
    await expect(ctx.workspaceAuthority.enter(SESSION, async () => undefined))
      .rejects.toThrow('grant identity does not match the run')
    grant = { ...record(), id: WorkspaceGrantId('grant-other') }
    await expect(ctx.workspaceAuthority.enter(SESSION, async () => undefined))
      .rejects.toThrow('grant identity does not match the run')
    grant = undefined
    await expect(ctx.workspaceAuthority.enter(SESSION, async () => undefined))
      .rejects.toThrow('grant is unavailable')
    grant = { ...record(), deviceId: DeviceId('device-2') }
    await expect(ctx.workspaceAuthority.enter(SESSION, async () => undefined))
      .rejects.toThrow('grant identity does not match the run')
  })

  it('narrows a process policy to the grant ceiling and rejects an outside workdir', async () => {
    grant = record('read-only')
    await ctx.workspaceAuthority.enter(SESSION, async () => {
      await expect(ctx.workspaceAuthority.authorizePolicy({
        mode: 'danger-full-access',
        workspaceRoot: root,
        sessionId: SESSION,
      })).resolves.toMatchObject({ mode: 'read-only', workspaceRoot: root })
      await expect(ctx.workspaceAuthority.authorizePolicy({
        mode: 'workspace-write',
        workspaceRoot: outside,
        sessionId: SESSION,
      })).rejects.toThrow('working directory is outside granted roots')
    })
    grant = record('workspace-write')
    await ctx.workspaceAuthority.enter(SESSION, async () => {
      await expect(ctx.workspaceAuthority.authorizePolicy({
        mode: 'read-only',
        workspaceRoot: root,
        sessionId: SESSION,
      })).resolves.toMatchObject({ mode: 'read-only' })
    })
  })

  it('is transparent outside a Candy run scope', async () => {
    const policy = { mode: 'workspace-write' as const, workspaceRoot: root, sessionId: SESSION }
    await expect(ctx.workspaceAuthority.authorizePath(outside, 'write')).resolves.toBeUndefined()
    await expect(ctx.workspaceAuthority.authorizePolicy(policy)).resolves.toBe(policy)
    expect(ctx.workspaceAuthority.constrainPolicy(policy)).toBe(policy)
  })

  it('binds the admitted session only around the tools/execute continuation', async () => {
    const result = { content: [], isError: false, value: null }
    await expect(ctx.waterfall(
      ctx as never,
      'tools/execute',
      { agent: undefined } as never,
      async () => result as never,
    )).resolves.toBe(result)

    await expect(ctx.waterfall(
      ctx as never,
      'tools/execute',
      { agent: { session: { id: SESSION } } } as never,
      async () => {
        await ctx.workspaceAuthority.authorizePath(outside, 'read')
        return result as never
      },
    )).rejects.toThrow('path is outside granted roots')
  })

  it('refuses an unowned session before any executor operation begins', async () => {
    await expect(ctx.workspaceAuthority.enter(SessionId('unknown'), async () => undefined))
      .rejects.toThrow('session has no open Candy run')
  })
})
