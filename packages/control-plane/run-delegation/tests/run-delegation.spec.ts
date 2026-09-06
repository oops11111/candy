/**
 * Real composition: a real Candy scheduler admits the parent's run, a real
 * `dsh-subagent` runtime and its shipped in-process spawn provider delegate a
 * child, and this package's `onBeforeDelegate` hook is the only thing minting
 * a run for it. Nothing about the tenant, the ledger, or the delegated child
 * is faked — only the model, through `MockAdapter`.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import {
  ConversationId, DeviceId, ProviderAccountId, RunId, UserId, WorkspaceGrantId,
} from '@deepseek-ai/dsh-control-plane'
import ControlPlaneStore, { type DurableRunRecord } from '@deepseek-ai/dsh-control-plane-store'
import { CredentialKeyVersion, sealCredential, type CredentialKeyring } from '@deepseek-ai/dsh-credential-vault'
import { mintExecutionAssertion, type ExecutionAssertionClaims } from '@deepseek-ai/dsh-execution-assertion'
import type { RunBudget } from '@deepseek-ai/dsh-run-budget'
import RunScheduler from '@deepseek-ai/dsh-run-scheduler'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import SubagentRuntime, { type SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import * as SpawnInProcess from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { afterEach, describe, expect, it } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as RunDelegation from '../src/index.ts'
import type { Config } from '../src/index.ts'

const SECRET = 'candy-assertion-secret-at-least-32-bytes'
const KEY = 'candy-credential-key-32-bytes!!!'
const KEY_VERSION = '2026-09-a'
const ISSUER = 'candy-control-plane'
const AUDIENCE = 'candy-runtime-debian-1'
const ALICE = UserId('user-alice')
const ACCOUNT: ProviderAccountId = ProviderAccountId('account-1')
const TENANT_GRANT: RunBudget = { tokens: 1_000_000, wallMs: 6_000_000, costMicroUsd: 25_000_000, children: 10 }
const CHILD_BUDGET: RunBudget = { tokens: 1_000, wallMs: 60_000, costMicroUsd: 10_000, children: 0 }
const KEYRING: CredentialKeyring = {
  currentVersion: CredentialKeyVersion(KEY_VERSION),
  keys: new Map([[CredentialKeyVersion(KEY_VERSION), Buffer.from(KEY, 'utf8')]]),
}

let root: string | undefined
let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Boot storage, the control plane, the scheduler, a real subagent runtime, and the policy under test. */
async function boot(at: string, config: Config, script: readonly ReturnType<typeof textResponse>[]): Promise<Context> {
  process.env['CANDY_ASSERTION_SECRET'] = SECRET
  process.env['CANDY_CREDENTIAL_KEY'] = KEY
  await mkdir(join(at, 'pools'), { mode: 0o700, recursive: true })
  const context = new Context()
  ctx = context
  await mountAgentLoopTestDependencies(context)
  context.llm.registerAdapter(['mock'], new MockAdapter([...script]))
  await context.plugin(SessionProjectionRegistry)
  await context.plugin(AgentLoop, { agents: [] })
  await context.plugin(SubagentRuntime)
  await context.plugin(SpawnInProcess, { providerName: 'spawn' })
  await context.plugin(Timer)
  await context.plugin(Storage)
  await context.plugin(StorageSqlite, { path: join(at, 'candy.db') })
  await context.plugin(StorageDomain, { backend: 'sqlite' })
  await context.plugin(ControlPlaneStore)
  await context.plugin(RunScheduler, {
    issuer: ISSUER,
    audience: AUDIENCE,
    credentialKeyVersion: KEY_VERSION,
    poolBase: join(at, 'pools'),
  })
  await context.plugin(RunDelegation, config)
  return context
}

/** Give the tenant an allowance and a sealed credential, as a control plane would. */
async function provision(context: Context, now: number): Promise<void> {
  await context.controlPlaneStore.setTenantGrant(ALICE, TENANT_GRANT)
  await context.controlPlaneStore.save({
    record: {
      id: ACCOUNT, userId: ALICE, provider: 'claude-cli', label: 'work',
      createdAt: now, updatedAt: now, validatedAt: undefined, revokedAt: undefined, deletedAt: undefined, isDefault: true,
    },
    credential: sealCredential(Buffer.from('sk-ant-alice', 'utf8'), { userId: ALICE, accountId: ACCOUNT }, KEYRING, now).envelope,
  })
}

function claims(
  sessionId: SessionId,
  runId: RunId,
  now: number,
  overrides: Partial<ExecutionAssertionClaims> = {},
): ExecutionAssertionClaims {
  return {
    issuer: ISSUER, audience: AUDIENCE, userId: ALICE, deviceId: DeviceId('device-1'),
    accountId: ACCOUNT, provider: 'claude-cli', workspaceGrantId: WorkspaceGrantId('grant-1'),
    conversationId: ConversationId('conversation-1'), sessionId,
    runId, parentRunId: undefined, nonce: `nonce-${runId}`,
    issuedAt: now, expiresAt: now + 60_000,
    ...overrides,
  }
}

/** Start a real root run for `sessionId`, opened with exactly `share`. */
async function openRootRun(context: Context, sessionId: SessionId, runId: RunId, share: RunBudget, now: number): Promise<void> {
  const outcome = await context.runScheduler.start(
    mintExecutionAssertion(claims(sessionId, runId, now), Buffer.from(SECRET, 'utf8')),
    () => share,
    now,
  )
  if (!outcome.started) throw new Error(`test setup: root run failed to start: ${JSON.stringify(outcome.rejection)}`)
}

/** A real subagent delegation, the way `tool-subagent` drives one. */
function delegate(context: Context, request: Omit<SubagentStartRequest, 'signal'> & { signal?: AbortSignal }) {
  return context.subagents.start('spawn', { signal: request.signal ?? new AbortController().signal, ...request })
}

async function parentAgent(context: Context, sessionId: SessionId): Promise<Agent> {
  const handle = await context.agents.create({ sessionId, agentOptions: { provider: 'mock', model: 'mock' } })
  return handle.agent
}

describe('opening a run for a delegated child', () => {
  it('funds the child with the configured budget, parented to the delegating run', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-run-delegation-'))
    const context = await boot(root, { childBudget: CHILD_BUDGET }, [textResponse('child answer')])
    const now = Date.now()
    await provision(context, now)
    const session = SessionId('sess-funded')
    const parentRunId = RunId('run-parent')
    await openRootRun(context, session, parentRunId, TENANT_GRANT, now)
    const parent = await parentAgent(context, session)

    // Registered after the plugin's own hook, so it observes the run the
    // plugin just opened — the child's run exists only while the child does.
    let funded: readonly DurableRunRecord[] = []
    const stop = context.subagents.onBeforeDelegate((_delegating, childId) => {
      funded = context.controlPlaneStore.runsOfSession(AUDIENCE, childId)
    })

    const run = await delegate(context, { prompt: [{ type: 'text', text: 'do X' }], parent })
    const result = await run.result
    await run.dispose()

    expect(result.stopReason).toBe('completed')
    expect(funded).toHaveLength(1)
    expect(funded[0]?.record.parentRunId).toBe(parentRunId)
    expect(funded[0]?.record.reserved).toEqual(CHILD_BUDGET)
    // Settled: the child holds nothing once it is done.
    expect(context.controlPlaneStore.runsOfSession(AUDIENCE, run.id)).toEqual([])
    stop()
  })

  it('returns the parent\'s concurrency slot when a delegated child settles', async () => {
    // A finished child holds nothing: its run closes at settlement rather than
    // waiting out a lease, so the next delegation has the slot back.
    root = await mkdtemp(join(tmpdir(), 'dsh-run-delegation-'))
    const context = await boot(root, { childBudget: CHILD_BUDGET }, [textResponse('one'), textResponse('two')])
    const now = Date.now()
    await provision(context, now)
    const session = SessionId('sess-sequential')
    // One child slot: a second delegation needs the first child's slot back.
    const oneSlot: RunBudget = { ...TENANT_GRANT, children: 1 }
    await openRootRun(context, session, RunId('run-parent-sequential'), oneSlot, now)
    const parent = await parentAgent(context, session)

    const first = await delegate(context, { prompt: [{ type: 'text', text: 'do X' }], parent })
    expect((await first.result).stopReason).toBe('completed')
    await first.dispose()
    const second = await delegate(context, { prompt: [{ type: 'text', text: 'do Y' }], parent })

    expect((await second.result).stopReason).toBe('completed')
    await second.dispose()
  })

  it('leaves a child that already has a run with the run it has', async () => {
    // A continuable child is prepared on every residency epoch. One that
    // resumes before its previous run's lease lapses still has that run, and a
    // second run for one session is refused at admission.
    root = await mkdtemp(join(tmpdir(), 'dsh-run-delegation-'))
    const context = await boot(root, { childBudget: CHILD_BUDGET }, [textResponse('child answer')])
    const now = Date.now()
    await provision(context, now)
    const session = SessionId('sess-second-epoch')
    await openRootRun(context, session, RunId('run-parent-epochs'), TENANT_GRANT, now)
    const parent = await parentAgent(context, session)
    const childId = SessionId('sess-child-epochs')
    await context.subagents.prepareDelegatedChild(parent, childId)
    const funded = context.controlPlaneStore.runsOfSession(AUDIENCE, childId)
    expect(funded).toHaveLength(1)

    // A second epoch reached before the first one's run is closed — a resume
    // racing the settlement that releases it.
    await expect(context.subagents.prepareDelegatedChild(parent, childId)).resolves.toBeUndefined()

    expect(context.controlPlaneStore.runsOfSession(AUDIENCE, childId)).toEqual(funded)
  })

  it('refuses the delegation when the parent cannot fund the exact child request, with no orphaned child', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-run-delegation-'))
    // Enough for the parent's own admission to pass (nonzero in every
    // dimension) but short of what `CHILD_BUDGET` asks for.
    const shortShare: RunBudget = { tokens: 10, wallMs: 60_000, costMicroUsd: 10_000, children: 1 }
    const context = await boot(root, { childBudget: CHILD_BUDGET }, [])
    const now = Date.now()
    await provision(context, now)
    const session = SessionId('sess-short')
    await openRootRun(context, session, RunId('run-parent-short'), shortShare, now)
    const parent = await parentAgent(context, session)
    const before = context.agents.list().length

    await expect(delegate(context, { prompt: [{ type: 'text', text: 'do X' }], parent }))
      .rejects.toThrow(/parent's remaining tokens \(10\) is less than the configured child tokens request \(1,?000\)/)
    expect(context.agents.list().length).toBe(before)
  })

  it('refuses the delegation when the parent\'s own allowance is already exhausted', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-run-delegation-'))
    const exhaustedShare: RunBudget = { tokens: 0, wallMs: 60_000, costMicroUsd: 10_000, children: 1 }
    const context = await boot(root, { childBudget: CHILD_BUDGET }, [])
    const now = Date.now()
    await provision(context, now)
    const session = SessionId('sess-exhausted')
    await openRootRun(context, session, RunId('run-parent-exhausted'), exhaustedShare, now)
    const parent = await parentAgent(context, session)
    const before = context.agents.list().length

    await expect(delegate(context, { prompt: [{ type: 'text', text: 'do X' }], parent }))
      .rejects.toThrow(/tenant allowance is exhausted for this delegation/)
    expect(context.agents.list().length).toBe(before)
  })

  it('leaves a parent with no open Candy run unrestricted', async () => {
    // A plain `dsh` session, outside Candy: nothing here funds it, and
    // nothing here should refuse it either.
    root = await mkdtemp(join(tmpdir(), 'dsh-run-delegation-'))
    const context = await boot(root, { childBudget: CHILD_BUDGET }, [textResponse('child answer')])
    const parent = await parentAgent(context, SessionId('sess-no-run'))

    const run = await delegate(context, { prompt: [{ type: 'text', text: 'do X' }], parent })
    const result = await run.result
    await run.dispose()

    expect(result.stopReason).toBe('completed')
  })

  it('refuses the delegation when the parent session is claimed by more than one open run', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-run-delegation-'))
    const context = await boot(root, { childBudget: CHILD_BUDGET }, [])
    const now = Date.now()
    await provision(context, now)
    const session = SessionId('sess-claimed-twice')
    await openRootRun(context, session, RunId('run-first'), TENANT_GRANT, now)
    // A second run claiming the same session cannot happen through `start()`
    // itself — admission's own "already-driven" check refuses it — so this
    // plants the conflicting record directly, the way another runtime sharing
    // this audience (or a storage inconsistency) would produce one.
    await context.controlPlaneStore.openRun({
      record: {
        runId: RunId('run-elsewhere'), parentRunId: undefined,
        reserved: TENANT_GRANT, spent: { tokens: 0, wallMs: 0, costMicroUsd: 0 }, leaseExpiresAt: now + 300_000,
      },
      userId: ALICE, sessionId: session, accountId: ACCOUNT,
      deviceId: DeviceId('device-1'), workspaceGrantId: WorkspaceGrantId('grant-1'), conversationId: ConversationId('conversation-1'),
      runtime: AUDIENCE, settledSpent: undefined, absorbed: undefined,
    })
    const parent = await parentAgent(context, session)

    // Extracted to a plain string before asserting: pretty-printing the
    // thrown error itself, under this package's full composition, trips an
    // unrelated vitest/pretty-format crash on a failing diff.
    const error = await delegate(context, { prompt: [{ type: 'text', text: 'do X' }], parent })
      .then(() => undefined, (thrown: unknown) => thrown)
    expect(String((error as { message?: unknown } | undefined)?.message)).toContain('claimed by 2 open runs')
  })

  it('refuses the delegation when the parent run\'s account can no longer authorize work', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-run-delegation-'))
    const context = await boot(root, { childBudget: CHILD_BUDGET }, [])
    const now = Date.now()
    await provision(context, now)
    const session = SessionId('sess-revoked')
    await openRootRun(context, session, RunId('run-revoked'), TENANT_GRANT, now)
    const entry = await context.controlPlaneStore.find(ACCOUNT)
    if (entry === undefined) throw new Error('test setup: account not found')
    await context.controlPlaneStore.save({ record: { ...entry.record, revokedAt: now + 1 }, credential: entry.credential })
    const parent = await parentAgent(context, session)

    await expect(delegate(context, { prompt: [{ type: 'text', text: 'do X' }], parent }))
      .rejects.toThrow(/account can no longer authorize work/)
  })
})
