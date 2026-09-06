/**
 * Every way `SessionRoutedClaudeCliAdapter` can refuse a call, pinned against
 * a fake `runIdentityFor` rather than a real scheduler — the real scheduler's
 * own resolution is `dsh-run-scheduler`'s to test, and the composition suite
 * beside this one already proves the success path against a real process.
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import { RunId, ProviderAccountId } from '@deepseek-ai/dsh-control-plane'
import type { RunIdentity, RunIdentityResult } from '@deepseek-ai/dsh-run-scheduler'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it, vi } from 'vitest'
import {
  BINDING_REFUSED_CODE,
  CREDENTIAL_UNAVAILABLE_CODE,
  NO_SESSION_CODE,
  PROVIDER_MISMATCH_CODE,
  resolveDeployment,
  SessionRoutedClaudeCliAdapter,
  type SessionRunIdentitySource,
} from '../src/index.ts'

const RUN = RunId('run-1')
const ACCOUNT = ProviderAccountId('account-1')
const SESSION = brandString<SessionId>('session-1')

const IDENTITY: RunIdentity = {
  runId: RUN,
  provider: 'claude-cli',
  poolRoot: '/srv/candy/pools/abc',
  secret: Buffer.from('sk-ant-alice', 'utf8'),
  remaining: { tokens: 1_000, wallMs: 60_000, costMicroUsd: 10_000, children: 0 },
}

/** A scheduler stub answering one fixed identity resolution and never spawning for real. */
function stubScheduler(result: RunIdentityResult): SessionRunIdentitySource {
  return {
    runIdentityFor: vi.fn().mockResolvedValue(result),
    disposableSpawn: (_runId, spawn) => spawn,
  }
}

/** A spawn function this suite never expects to be called. */
const unreachableSpawn = (_spec: SubprocessSpawnSpec): SubprocessHandle => {
  throw new Error('this test refuses before a process would be spawned')
}

const DEPLOYMENT = { executable: '/opt/candy/bin/claude', graceMs: 1_000, maxOutputBytes: 1024, maxStderrBytes: 1024 }

async function drain(stream: AsyncIterable<unknown>): Promise<unknown> {
  const iterator = stream[Symbol.asyncIterator]()
  return iterator.next()
}

describe('the session-routed adapter, refusing a call', () => {
  it('refuses a request with no session before resolving anything', async () => {
    const scheduler = stubScheduler({ ok: true, value: IDENTITY })
    const adapter = new SessionRoutedClaudeCliAdapter({ deployment: DEPLOYMENT, scheduler, spawn: unreachableSpawn })

    await expect(drain(adapter.stream({ provider: 'claude-cli', model: 'claude-sonnet-5', messages: [] })))
      .rejects.toMatchObject({ failure: { code: NO_SESSION_CODE } })
    expect(scheduler.runIdentityFor).not.toHaveBeenCalled()
  })

  it('refuses a session with no open run', async () => {
    const scheduler = stubScheduler({ ok: false, rejection: { reason: 'no-open-run' } })
    const adapter = new SessionRoutedClaudeCliAdapter({ deployment: DEPLOYMENT, scheduler, spawn: unreachableSpawn })

    await expect(drain(adapter.stream({ provider: 'claude-cli', model: 'claude-sonnet-5', messages: [], sessionId: SESSION })))
      .rejects.toMatchObject({ failure: { code: 'RUN_NOT_OPEN' } })
  })

  it('names how many runs claim a session two records both claim', async () => {
    const scheduler = stubScheduler({
      ok: false,
      rejection: { reason: 'claimed-by-several', runIds: [RUN, RunId('run-2')] },
    })
    const adapter = new SessionRoutedClaudeCliAdapter({ deployment: DEPLOYMENT, scheduler, spawn: unreachableSpawn })

    await expect(drain(adapter.stream({ provider: 'claude-cli', model: 'claude-sonnet-5', messages: [], sessionId: SESSION })))
      .rejects.toMatchObject({ failure: { code: 'RUN_NOT_OPEN' }, message: expect.stringContaining('2 open runs') as string })
  })

  it('refuses a run whose account can no longer authorize work', async () => {
    const scheduler = stubScheduler({ ok: false, rejection: { reason: 'account-unusable', runId: RUN, accountId: ACCOUNT } })
    const adapter = new SessionRoutedClaudeCliAdapter({ deployment: DEPLOYMENT, scheduler, spawn: unreachableSpawn })

    await expect(drain(adapter.stream({ provider: 'claude-cli', model: 'claude-sonnet-5', messages: [], sessionId: SESSION })))
      .rejects.toMatchObject({ failure: { code: 'CREDENTIAL_REVOKED' } })
  })

  it('refuses a run whose account has no stored credential', async () => {
    const scheduler = stubScheduler({ ok: false, rejection: { reason: 'no-credential', runId: RUN, accountId: ACCOUNT } })
    const adapter = new SessionRoutedClaudeCliAdapter({ deployment: DEPLOYMENT, scheduler, spawn: unreachableSpawn })

    await expect(drain(adapter.stream({ provider: 'claude-cli', model: 'claude-sonnet-5', messages: [], sessionId: SESSION })))
      .rejects.toMatchObject({ failure: { code: CREDENTIAL_UNAVAILABLE_CODE } })
  })

  it('refuses a run whose credential the vault itself would not open', async () => {
    const scheduler = stubScheduler({ ok: false, rejection: { reason: 'corrupt', runId: RUN, accountId: ACCOUNT } })
    const adapter = new SessionRoutedClaudeCliAdapter({ deployment: DEPLOYMENT, scheduler, spawn: unreachableSpawn })

    await expect(drain(adapter.stream({ provider: 'claude-cli', model: 'claude-sonnet-5', messages: [], sessionId: SESSION })))
      .rejects.toMatchObject({ failure: { code: CREDENTIAL_UNAVAILABLE_CODE }, message: expect.stringContaining('corrupt') as string })
  })

  it('refuses a run whose account authenticates a different provider', async () => {
    const scheduler = stubScheduler({ ok: true, value: { ...IDENTITY, provider: 'deepseek-api' } })
    const adapter = new SessionRoutedClaudeCliAdapter({ deployment: DEPLOYMENT, scheduler, spawn: unreachableSpawn })

    await expect(drain(adapter.stream({ provider: 'claude-cli', model: 'claude-sonnet-5', messages: [], sessionId: SESSION })))
      .rejects.toMatchObject({ failure: { code: PROVIDER_MISMATCH_CODE } })
  })

  it('refuses a run whose opened credential cannot become a launch', async () => {
    // An empty secret is what `bindClaudeCliCredential` itself refuses; this
    // proves the refusal reaches the caller as this route's own error, not an
    // unhandled throw from inside `dsh-claude-cli-binding`.
    const scheduler = stubScheduler({ ok: true, value: { ...IDENTITY, secret: new Uint8Array(0) } })
    const adapter = new SessionRoutedClaudeCliAdapter({ deployment: DEPLOYMENT, scheduler, spawn: unreachableSpawn })

    await expect(drain(adapter.stream({ provider: 'claude-cli', model: 'claude-sonnet-5', messages: [], sessionId: SESSION })))
      .rejects.toMatchObject({ failure: { code: BINDING_REFUSED_CODE }, message: expect.stringContaining('empty') as string })
  })
})

describe('resolveDeployment', () => {
  it('applies every default a programmatic caller omits', () => {
    expect(resolveDeployment({})).toEqual({
      executable: 'claude',
      graceMs: 5_000,
      maxOutputBytes: 16 * 1024 * 1024,
      maxStderrBytes: 8 * 1024,
    })
  })

  it('keeps every field a caller supplies', () => {
    expect(resolveDeployment(DEPLOYMENT)).toEqual(DEPLOYMENT)
  })
})
