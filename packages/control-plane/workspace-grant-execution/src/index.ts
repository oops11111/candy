/**
 * Binds a Candy run's durable workspace grant to the inherited filesystem and
 * shell executors without defining a second file-operation protocol.
 * @module @deepseek-ai/dsh-workspace-grant-execution
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { DeviceId, UserId, WorkspaceGrantId } from '@deepseek-ai/dsh-control-plane'
import type {} from '@deepseek-ai/dsh-control-plane-store'
import { RunScheduler } from '@deepseek-ai/dsh-run-scheduler'
import {
  WorkspaceAuthority,
  type SandboxExecutionPolicy,
  type SandboxMode,
  type WorkspaceAccess,
} from '@deepseek-ai/dsh-sandbox'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolDispatchExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { WorkspaceGrantRecord } from '@deepseek-ai/dsh-workspace-grant'

interface AuthorityIdentity {
  readonly userId: UserId
  readonly deviceId: DeviceId
  readonly grantId: WorkspaceGrantId
}

const MODE_RANK: Readonly<Record<SandboxMode, number>> = {
  'read-only': 0,
  'workspace-write': 1,
  'danger-full-access': 2,
}

function canonicalExisting(path: string): string {
  let candidate = resolve(path)
  const suffix: string[] = []
  while (true) {
    try {
      return resolve(realpathSync.native(candidate), ...suffix.reverse())
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code
      /* v8 ignore next -- propagate unexpected native filesystem failures unchanged */
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
      const parent = dirname(candidate)
      /* v8 ignore next -- resolve() cannot climb above the filesystem root */
      if (parent === candidate) return resolve(path)
      suffix.push(relative(parent, candidate))
      candidate = parent
    }
  }
}

function pathIsUnder(path: string, root: string): boolean {
  const delta = relative(canonicalExisting(root), canonicalExisting(path))
  return delta === '' || (delta !== '..' && !delta.startsWith(`..${sep}`) && !isAbsolute(delta))
}

function assertGrant(identity: AuthorityIdentity, grant: WorkspaceGrantRecord | undefined): WorkspaceGrantRecord {
  if (grant === undefined || grant.revokedAt !== undefined) throw new Error('workspace authority denied: grant is unavailable')
  if (grant.id !== identity.grantId || grant.userId !== identity.userId || grant.deviceId !== identity.deviceId) {
    throw new Error('workspace authority denied: grant identity does not match the run')
  }
  return grant
}

/** Enforces the current run's grant at inherited filesystem and shell operations. */
export class WorkspaceGrantExecution extends WorkspaceAuthority {
  static inject = ['controlPlaneStore', 'runScheduler']

  private readonly scope = new AsyncLocalStorage<AuthorityIdentity>()

  constructor(ctx: Context) {
    super(ctx)
    ctx.on('tools/execute', (execution: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>) => {
      const sessionId = execution.agent?.session.id
      return sessionId === undefined ? next() : this.enter(sessionId, next)
    }, { global: true })
  }

  override async enter<T>(sessionId: SessionId, operation: () => Promise<T>): Promise<T> {
    const run = (this.ctx.runScheduler as RunScheduler).runOfSession(sessionId)
    if (run === undefined) throw new Error('workspace authority denied: session has no open Candy run')
    const identity: AuthorityIdentity = {
      userId: run.userId,
      deviceId: run.deviceId,
      grantId: run.workspaceGrantId,
    }
    assertGrant(identity, await this.ctx.controlPlaneStore.findGrant(identity.grantId))
    return this.scope.run(identity, operation)
  }

  override async authorizePath(path: string, access: WorkspaceAccess): Promise<void> {
    const identity = this.scope.getStore()
    if (identity === undefined) return
    const grant = assertGrant(identity, await this.ctx.controlPlaneStore.findGrant(identity.grantId))
    if (access === 'write' && grant.mode === 'read-only') {
      throw new Error('workspace authority denied: grant is read-only')
    }
    if (!grant.roots.some(root => pathIsUnder(path, root))) {
      throw new Error('workspace authority denied: path is outside granted roots')
    }
  }

  override async authorizePolicy(policy: SandboxExecutionPolicy): Promise<SandboxExecutionPolicy> {
    const identity = this.scope.getStore()
    if (identity === undefined) return policy
    assertGrant(identity, await this.ctx.controlPlaneStore.findGrant(identity.grantId))
    return this.constrainPolicy(policy)
  }

  override constrainPolicy(policy: SandboxExecutionPolicy): SandboxExecutionPolicy {
    const identity = this.scope.getStore()
    if (identity === undefined) return policy
    const grant = assertGrant(identity, this.ctx.controlPlaneStore.grantSnapshot(identity.grantId))
    if (!grant.roots.some(root => pathIsUnder(policy.workspaceRoot, root))) {
      throw new Error('workspace authority denied: process working directory is outside granted roots')
    }
    const mode = MODE_RANK[policy.mode] <= MODE_RANK[grant.mode] ? policy.mode : grant.mode
    return { ...policy, mode }
  }
}

export default WorkspaceGrantExecution
