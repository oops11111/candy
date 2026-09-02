import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  ConversationId,
  DeviceId,
  ProviderAccountId,
  RunId,
  UserId,
  WorkspaceGrantId,
  type RunLineage,
} from '../src/index.ts'

describe('control-plane ids', () => {
  it('brands a user id without changing the runtime value', () => {
    const id = UserId('user-1')

    expect(id).toBe('user-1')
    expectTypeOf(id).toEqualTypeOf<UserId>()
  })

  it('brands a device id without changing the runtime value', () => {
    const id = DeviceId('device-1')

    expect(id).toBe('device-1')
    expectTypeOf(id).toEqualTypeOf<DeviceId>()
  })

  it('brands a provider-account id without changing the runtime value', () => {
    const id = ProviderAccountId('account-1')

    expect(id).toBe('account-1')
    expectTypeOf(id).toEqualTypeOf<ProviderAccountId>()
  })

  it('brands a workspace-grant id without changing the runtime value', () => {
    const id = WorkspaceGrantId('grant-1')

    expect(id).toBe('grant-1')
    expectTypeOf(id).toEqualTypeOf<WorkspaceGrantId>()
  })

  it('brands a conversation id without changing the runtime value', () => {
    const id = ConversationId('conversation-1')

    expect(id).toBe('conversation-1')
    expectTypeOf(id).toEqualTypeOf<ConversationId>()
  })

  it('brands a run id without changing the runtime value', () => {
    const id = RunId('run-1')

    expect(id).toBe('run-1')
    expectTypeOf(id).toEqualTypeOf<RunId>()
  })
})

describe('RunLineage', () => {
  it('names a root run with no parent', () => {
    const lineage: RunLineage = { runId: RunId('run-root'), parentRunId: undefined }

    expect(lineage.parentRunId).toBeUndefined()
  })

  it('names a child run by its parent run id', () => {
    const parentRunId = RunId('run-root')
    const lineage: RunLineage = { runId: RunId('run-child'), parentRunId }

    expect(lineage.parentRunId).toBe(parentRunId)
  })
})
