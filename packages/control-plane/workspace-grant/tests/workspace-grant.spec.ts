/**
 * The rule one run's filesystem authority is admitted by. Every case is the
 * pure decision: the store, the assertion, and the filesystem are all
 * somewhere else, and what is checked here is which identities may hold a
 * grant and which may not.
 */

import { DeviceId, UserId, WorkspaceGrantId } from '@deepseek-ai/dsh-control-plane'
import { describe, expect, it } from 'vitest'
import {
  admitWorkspaceGrant,
  isWorkspaceGrantUsable,
  type WorkspaceGrantRecord,
  type WorkspaceGrantRequest,
} from '../src/index.ts'

const NOW = 1_780_000_000_000
const ALICE = UserId('user-alice')
const DEVICE = DeviceId('device-1')
const GRANT_ID = WorkspaceGrantId('grant-1')

function grant(overrides: Partial<WorkspaceGrantRecord> = {}): WorkspaceGrantRecord {
  return {
    id: GRANT_ID,
    userId: ALICE,
    deviceId: DEVICE,
    roots: ['/srv/candy/alice'],
    mode: 'workspace-write',
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    revokedAt: undefined,
    ...overrides,
  }
}

function request(overrides: Partial<WorkspaceGrantRequest> = {}): WorkspaceGrantRequest {
  return { userId: ALICE, deviceId: DEVICE, grantId: GRANT_ID, parentGrantId: undefined, ...overrides }
}

describe('admitting a workspace grant', () => {
  it('admits a root run holding its own tenant\'s grant on its own device', () => {
    const record = grant()

    expect(admitWorkspaceGrant(request(), record)).toEqual({ admitted: true, grant: record })
  })

  it('refuses a grant the deployment does not hold', () => {
    // An id nothing resolves is not authority nobody bounded; it is a run
    // naming a grant that was never issued, or one that has been deleted.
    expect(admitWorkspaceGrant(request(), undefined)).toEqual({ admitted: false, rejection: 'not-found' })
  })

  it('refuses a revoked grant, whatever an already-minted assertion still says', () => {
    // The record is the authority and the assertion only names it, so
    // revocation reaches a token that was valid when it was issued.
    expect(admitWorkspaceGrant(request(), grant({ revokedAt: NOW + 1 })))
      .toEqual({ admitted: false, rejection: 'revoked' })
  })

  it('refuses a run of one tenant holding another tenant\'s grant', () => {
    expect(admitWorkspaceGrant(request({ userId: UserId('user-bobby') }), grant()))
      .toEqual({ admitted: false, rejection: 'tenant-mismatch' })
  })

  it('refuses a run holding this tenant\'s grant on another of its devices', () => {
    // The roots are spelled for the device that issued them, so honouring the
    // grant from elsewhere would apply one machine's paths to another's disk.
    expect(admitWorkspaceGrant(request({ deviceId: DeviceId('device-2') }), grant()))
      .toEqual({ admitted: false, rejection: 'device-mismatch' })
  })

  it('refuses a child naming any grant other than the one its parent holds', () => {
    // Equality is the subset rule at its strongest: a child that cannot name
    // another grant cannot widen its roots or raise its mode.
    const widened = grant({ id: WorkspaceGrantId('grant-9'), roots: ['/'], mode: 'danger-full-access' })

    expect(admitWorkspaceGrant(
      request({ grantId: widened.id, parentGrantId: GRANT_ID }),
      widened,
    )).toEqual({ admitted: false, rejection: 'not-inherited' })
  })

  it('admits a child naming exactly its parent\'s grant', () => {
    const record = grant()

    expect(admitWorkspaceGrant(request({ parentGrantId: GRANT_ID }), record))
      .toEqual({ admitted: true, grant: record })
  })
})

describe('whether a grant still confers authority', () => {
  it('stands while it has not been revoked', () => {
    expect(isWorkspaceGrantUsable(grant())).toBe(true)
  })

  it('does not stand once it has', () => {
    expect(isWorkspaceGrantUsable(grant({ revokedAt: NOW }))).toBe(false)
  })
})
