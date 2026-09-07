/**
 * The filesystem authority one Candy run is admitted with.
 *
 * An execution assertion carries a {@link WorkspaceGrantId} and nothing else
 * about the filesystem, so until this existed the id resolved to no record and
 * admission could not read it: a run named whatever grant it liked and no step
 * looked. This package holds what the id resolves to — the roots a device
 * granted, the file-effect ceiling for work under them, and whether the grant
 * still stands — and the one rule admission enforces against it.
 *
 * Path containment is deliberately not here. A grant's roots are spelled for
 * the device that issued them, and deciding whether a path lies under one is
 * that device's filesystem semantics — casing, junctions, symbolic links, 8.3
 * aliases — which a control plane on another host cannot reproduce by
 * comparing strings. What is decided here is identity and inheritance, which
 * are the same on every host.
 *
 * @module @deepseek-ai/dsh-workspace-grant
 */

import type { DeviceId, UserId, WorkspaceGrantId } from '@deepseek-ai/dsh-control-plane'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'

/**
 * One device's standing grant of filesystem authority to one tenant.
 *
 * The record is the authority; an assertion only names it. That is what keeps
 * a revocation effective against a token already minted, and what keeps the
 * roots out of a claim a caller could edit.
 */
export interface WorkspaceGrantRecord {
  /** The id an execution assertion names. */
  readonly id: WorkspaceGrantId
  /** The tenant this grant was issued to; a run of any other is refused. */
  readonly userId: UserId
  /**
   * The device that issued the grant, and whose filesystem {@link roots} are
   * spelled for.
   *
   * It is also the only host that may decide whether a path lies under one of
   * them: the roots travel with the record, and reading them is not the same
   * as being able to resolve against them.
   */
  readonly deviceId: DeviceId
  /**
   * The granted roots, canonical on the issuing device.
   *
   * Empty is a valid grant of no filesystem authority at all, which is what a
   * run that should touch nothing is given.
   */
  readonly roots: readonly string[]
  /** The file-effect ceiling for work under {@link roots}. */
  readonly mode: SandboxMode
  /**
   * The grant's own revision, incremented whenever its roots or mode change.
   *
   * An assertion names only the id, so a run admitted before a narrowing and
   * one admitted after it are indistinguishable by id alone. Admission records
   * the version it read, which is what lets a later check tell a run holding
   * authority that has since been reduced from one holding what it was given.
   */
  readonly version: number
  /** When the grant was issued. */
  readonly createdAt: number
  /** When its roots, mode or revocation last changed. */
  readonly updatedAt: number
  /** When it was revoked; absent while it stands. */
  readonly revokedAt: number | undefined
}

/** Durable storage for grants, supplied by the deployment. */
export interface WorkspaceGrantStore {
  /** Read one grant by the id an assertion names. */
  readonly findGrant: (id: WorkspaceGrantId) => Promise<WorkspaceGrantRecord | undefined>
  /** Write one grant, replacing any record under the same id. */
  readonly saveGrant: (record: WorkspaceGrantRecord) => Promise<void>
}

/**
 * The identity one run claims filesystem authority under.
 *
 * It is the verified claims narrowed to what this rule reads, so the rule
 * takes no dependency on the assertion format.
 */
export interface WorkspaceGrantRequest {
  /** The tenant the verified assertion names. */
  readonly userId: UserId
  /** The device the verified assertion names. */
  readonly deviceId: DeviceId
  /** The grant the run claims. */
  readonly grantId: WorkspaceGrantId
  /**
   * The grant the parent run was admitted with, absent for a root run and for
   * a child whose parent this deployment does not hold.
   */
  readonly parentGrantId: WorkspaceGrantId | undefined
}

/** Why a run may not hold the grant it named. */
export type WorkspaceGrantRejection =
  /** No record resolves the id; an unknown grant is never an unlimited one. */
  | 'not-found'
  /** The grant was revoked, whatever an already-minted assertion still says. */
  | 'revoked'
  /** The grant belongs to another tenant. */
  | 'tenant-mismatch'
  /** The grant belongs to another device of this tenant. */
  | 'device-mismatch'
  /** A child named a grant other than the one its parent holds. */
  | 'not-inherited'

/**
 * Whether a grant still confers authority.
 * @param record - the stored grant.
 * @returns true while it stands.
 */
export function isWorkspaceGrantUsable(record: WorkspaceGrantRecord): boolean {
  return record.revokedAt === undefined
}

/** Whether one run may hold the grant it named, and the grant when it may. */
export type WorkspaceGrantAdmission =
  | { readonly admitted: true; readonly grant: WorkspaceGrantRecord }
  | { readonly admitted: false; readonly rejection: WorkspaceGrantRejection }

/**
 * Decide whether one run may hold the grant it named.
 *
 * A child must name its parent's grant exactly. Equality is the subset rule at
 * its strongest: a child that cannot name another grant cannot widen its roots
 * or raise its mode, so over-granting is impossible rather than detectable —
 * the same shape the budget rule takes. Nothing in this repository issues a
 * narrowed child grant today; when something does, it will be a record the
 * issuing device derives after checking containment with its own filesystem,
 * and this rule will accept that derivation. It will not become a path
 * comparison made here.
 *
 * @param request - the identity the run claims authority under.
 * @param record - the grant the id resolved to, or `undefined` when none did.
 * @returns the grant the run holds, or the reason it holds none.
 */
export function admitWorkspaceGrant(
  request: WorkspaceGrantRequest,
  record: WorkspaceGrantRecord | undefined,
): WorkspaceGrantAdmission {
  if (record === undefined) return { admitted: false, rejection: 'not-found' }
  if (!isWorkspaceGrantUsable(record)) return { admitted: false, rejection: 'revoked' }
  if (record.userId !== request.userId) return { admitted: false, rejection: 'tenant-mismatch' }
  if (record.deviceId !== request.deviceId) return { admitted: false, rejection: 'device-mismatch' }
  if (request.parentGrantId !== undefined && request.parentGrantId !== request.grantId) {
    return { admitted: false, rejection: 'not-inherited' }
  }
  return { admitted: true, grant: record }
}
