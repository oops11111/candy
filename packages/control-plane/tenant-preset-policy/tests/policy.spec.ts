/**
 * Real composition: a real Candy scheduler admits a run for a real session, a
 * real `dsh-agent-presets` roster composes agents from the fixture presets
 * `dsh-agent-presets`'s own tests already use, and this package's guard is
 * the only thing standing between the two. Nothing about the tenant, the
 * run, or the preset roster is faked.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import {
  ConversationId, DeviceId, ProviderAccountId, RunId, UserId, WorkspaceGrantId,
} from '@deepseek-ai/dsh-control-plane'
import ControlPlaneStore from '@deepseek-ai/dsh-control-plane-store'
import { CredentialKeyVersion, sealCredential, type CredentialKeyring } from '@deepseek-ai/dsh-credential-vault'
import { mintExecutionAssertion, type ExecutionAssertionClaims } from '@deepseek-ai/dsh-execution-assertion'
import Llm from '@deepseek-ai/dsh-llm'
import type { RunBudget } from '@deepseek-ai/dsh-run-budget'
import RunScheduler from '@deepseek-ai/dsh-run-scheduler'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { createScope } from '@deepseek-ai/dsh-scope'
import { afterEach, describe, expect, it } from 'vitest'
import * as TenantPresetPolicy from '../src/index.ts'
import type { Config } from '../src/index.ts'

const PRESET_FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'preset', 'agent-presets', 'tests', 'fixtures',
)

const SECRET = 'candy-assertion-secret-at-least-32-bytes'
const KEY = 'candy-credential-key-32-bytes!!!'
const KEY_VERSION = '2026-09-a'
const ISSUER = 'candy-control-plane'
const AUDIENCE = 'candy-runtime-debian-1'
const ALICE = UserId('user-alice')
const ACCOUNT: ProviderAccountId = ProviderAccountId('account-1')
const BUDGET: RunBudget = { tokens: 100_000, wallMs: 600_000, costMicroUsd: 2_500_000, children: 4 }
/** A share small enough that a second root run for the same tenant is still funded beside it. */
const SHARE: RunBudget = { tokens: 1_000, wallMs: 60_000, costMicroUsd: 10_000, children: 0 }
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

/** Boot storage, the control plane, the scheduler, a real preset roster, and the policy under test. */
async function boot(at: string, config: Config): Promise<Context> {
  process.env['CANDY_ASSERTION_SECRET'] = SECRET
  process.env['CANDY_CREDENTIAL_KEY'] = KEY
  await mkdir(join(at, 'pools'), { mode: 0o700, recursive: true })
  const context = new Context()
  ctx = context
  context.baseUrl = `${pathToFileURL(PRESET_FIXTURES).href}/`
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  context.loader.builtins.group = Group
  await context.plugin(Llm)
  await context.plugin(SessionStore)
  await context.plugin(SystemPrompt, { persona: '' })
  await context.plugin(ToolRuntime)
  await context.plugin(AgentRegistry)
  await context.plugin(SessionProjectionRegistry)
  await context.plugin(AgentLoop, { agents: [] })
  await context.plugin(AgentPresets, {
    default: 'standard',
    roots: [
      { path: join(PRESET_FIXTURES, 'system'), trust: 'system' },
      { path: join(PRESET_FIXTURES, 'user'), trust: 'user' },
    ],
    includeShippedRoot: false,
    includeUserRoot: false,
  })
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
  await context.plugin(TenantPresetPolicy, config)
  return context
}

/** Give the tenant an allowance and a sealed credential, as a control plane would. */
async function provision(context: Context, now: number): Promise<void> {
  await context.controlPlaneStore.setTenantGrant(ALICE, BUDGET)
  await context.controlPlaneStore.saveGrant({
    id: WorkspaceGrantId('grant-1'), userId: ALICE, deviceId: DeviceId('device-1'),
    roots: ['/srv/candy/alice'], mode: 'workspace-write', version: 1,
    createdAt: now, updatedAt: now, revokedAt: undefined,
  })
  await context.controlPlaneStore.save({
    record: {
      id: ACCOUNT, userId: ALICE, provider: 'claude-cli', label: 'work',
      createdAt: now, updatedAt: now, validatedAt: undefined, revokedAt: undefined, deletedAt: undefined, isDefault: true,
    },
    credential: sealCredential(Buffer.from('sk-ant-alice', 'utf8'), { userId: ALICE, accountId: ACCOUNT }, KEYRING, now).envelope,
  })
}

function claims(sessionId: SessionId, now: number, overrides: Partial<ExecutionAssertionClaims> = {}): ExecutionAssertionClaims {
  return {
    issuer: ISSUER, audience: AUDIENCE, userId: ALICE, deviceId: DeviceId('device-1'),
    accountId: ACCOUNT, provider: 'claude-cli', workspaceGrantId: WorkspaceGrantId('grant-1'),
    conversationId: ConversationId('conversation-1'), sessionId,
    runId: RunId('run-root'), parentRunId: undefined, nonce: 'nonce-1',
    issuedAt: now, expiresAt: now + 60_000,
    ...overrides,
  }
}

/** Compose an agent from `presetId`, the way an application's session factory would. */
async function agentOn(context: Context, sessionId: SessionId, presetId: string): Promise<Agent> {
  const handle = await context.agents.create({
    sessionId,
    setup: async (agentCtx: Context) => void await context.agentPresets.mount(agentCtx, presetId),
  })
  return handle.agent
}

describe('a tenant restricted to a preset subset', () => {
  it('refuses a preset outside the tenant\'s allowlist', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-tenant-preset-policy-'))
    const context = await boot(root, { allowlists: { 'user-alice': ['minimal'] } })
    const now = Date.now()
    await provision(context, now)
    const session = SessionId('sess-restricted')
    await context.runScheduler.start(mintExecutionAssertion(claims(session, now), Buffer.from(SECRET, 'utf8')), () => SHARE, now)
    const secondSession = SessionId('sess-restricted-2')
    await context.runScheduler.start(
      mintExecutionAssertion(claims(secondSession, now, { runId: RunId('run-second'), nonce: 'nonce-2' }), Buffer.from(SECRET, 'utf8')),
      () => SHARE,
      now,
    )

    const first = await agentOn(context, session, 'standard').then(() => undefined, (error: unknown) => error)
    const second = await agentOn(context, secondSession, 'standard').then(() => undefined, (error: unknown) => error)

    // Extracted to plain strings before asserting: pretty-printing the
    // `RemoteError` object itself, under this package's full composition,
    // trips an unrelated vitest/pretty-format crash on a failing diff.
    expect(String((first as { code?: unknown } | undefined)?.code)).toBe('agent-preset/refused')
    expect(String((first as { message?: unknown } | undefined)?.message)).toContain(
      'tenant "user-alice" is not permitted to use preset "standard"',
    )
    expect(String((second as { code?: unknown } | undefined)?.code)).toBe('agent-preset/refused')
    expect(String((second as { message?: unknown } | undefined)?.message)).toContain(
      'tenant "user-alice" is not permitted to use preset "standard"',
    )
  })

  it('allows a preset inside the tenant\'s allowlist', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-tenant-preset-policy-'))
    const context = await boot(root, { allowlists: { 'user-alice': ['minimal'] } })
    const now = Date.now()
    await provision(context, now)
    const session = SessionId('sess-allowed')
    await context.runScheduler.start(mintExecutionAssertion(claims(session, now), Buffer.from(SECRET, 'utf8')), undefined, now)

    const agent = await agentOn(context, session, 'minimal')

    expect(agent.id).toBe(session)
  })

  it('leaves a tenant absent from the configured allowlists unrestricted', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-tenant-preset-policy-'))
    // Bobby has no entry in `allowlists` at all, unlike Alice below.
    const context = await boot(root, { allowlists: { 'user-alice': ['minimal'] } })
    const now = Date.now()
    await context.controlPlaneStore.setTenantGrant(UserId('user-bobby'), BUDGET)
    await context.controlPlaneStore.save({
      record: {
        id: ProviderAccountId('account-bobby'), userId: UserId('user-bobby'), provider: 'claude-cli', label: 'work',
        createdAt: now, updatedAt: now, validatedAt: undefined, revokedAt: undefined, deletedAt: undefined, isDefault: true,
      },
      credential: sealCredential(
        Buffer.from('sk-ant-bobby', 'utf8'),
        { userId: UserId('user-bobby'), accountId: ProviderAccountId('account-bobby') },
        KEYRING,
        now,
      ).envelope,
    })
    const session = SessionId('sess-bobby')
    await context.runScheduler.start(mintExecutionAssertion(claims(session, now, {
      userId: UserId('user-bobby'), accountId: ProviderAccountId('account-bobby'),
    }), Buffer.from(SECRET, 'utf8')), undefined, now)

    const agent = await agentOn(context, session, 'standard')

    expect(agent.id).toBe(session)
  })

  it('leaves a session with no open run unrestricted', async () => {
    // No Candy run drives this session at all — the same "not this runtime's
    // to charge" default `RunScheduler.meterRequest` already applies.
    root = await mkdtemp(join(tmpdir(), 'dsh-tenant-preset-policy-'))
    const context = await boot(root, { allowlists: { 'user-alice': ['minimal'] } })

    const agent = await agentOn(context, SessionId('sess-no-run'), 'standard')

    expect(agent.id).toBe(SessionId('sess-no-run'))
  })

  it('also gates a preset switch, not only the first mount', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-tenant-preset-policy-'))
    const context = await boot(root, { allowlists: { 'user-alice': ['minimal'] } })
    const now = Date.now()
    await provision(context, now)
    const session = SessionId('sess-switch')
    await context.runScheduler.start(mintExecutionAssertion(claims(session, now), Buffer.from(SECRET, 'utf8')), undefined, now)
    const agent = await agentOn(context, session, 'minimal')

    await expect(context.agentPresets.recompose(agent.ctx, 'standard'))
      .rejects.toMatchObject({ code: 'agent-preset/refused' })
  })

  it('leaves a scoped context with no constructing agent unrestricted', async () => {
    // A scope carries the key `mount()` needs, but `mount()`'s own guard is
    // the only place `agentCtx.agent` is read — a caller that reaches it
    // through a bare scope, not `ctx.agents.create()`'s `setup`, has no
    // agent identity for this policy to resolve a tenant from.
    root = await mkdtemp(join(tmpdir(), 'dsh-tenant-preset-policy-'))
    const context = await boot(root, { allowlists: { 'user-alice': ['minimal'] } })
    const loner = createScope(context, { test: 'loner' })

    const preset = await context.agentPresets.mount(loner.ctx, 'standard')

    expect(preset.id).toBe('standard')
  })
})
