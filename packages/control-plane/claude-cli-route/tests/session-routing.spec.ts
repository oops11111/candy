/**
 * The route exercised end to end: a real process, spawned under an opened
 * credential resolved fresh from a session, with a real scheduler settlement
 * reaching back to reap it.
 *
 * The composition boots the same services `dsh-run-scheduler`'s own suite
 * does, without the YAML Loader ceremony that suite uses to prove config
 * loading — that is proven there; this suite's subject is the route.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  ProviderAccountId,
  RunId,
  UserId,
  type ConversationId,
  type DeviceId,
  type WorkspaceGrantId,
} from '@deepseek-ai/dsh-control-plane'
import ControlPlaneStore from '@deepseek-ai/dsh-control-plane-store'
import {
  CredentialKeyVersion,
  sealCredential,
  type CredentialKeyring,
} from '@deepseek-ai/dsh-credential-vault'
import { mintExecutionAssertion, type ExecutionAssertionClaims } from '@deepseek-ai/dsh-execution-assertion'
import Llm, { BlockAssembler, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { revokeProviderAccount } from '@deepseek-ai/dsh-provider-accounts'
import type { RunBudget } from '@deepseek-ai/dsh-run-budget'
import RunScheduler from '@deepseek-ai/dsh-run-scheduler'
import type { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import { afterEach, describe, expect, it } from 'vitest'
import * as ClaudeCliRoute from '../src/index.ts'

/**
 * A stand-in `claude` that reports the environment it was given, and, with
 * `STAND_IN_PIDS` set, reports its own pid and hangs — standing in for a
 * live call nobody cancelled.
 */
const STAND_IN = `
const say = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n')
say({ type: 'system', subtype: 'init', apiKeySource: 'ANTHROPIC_API_KEY' })
const report = JSON.stringify({ home: process.env.HOME, key: process.env.ANTHROPIC_API_KEY ?? 'absent' })
say({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } })
say({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: report } } })
const pidFile = process.env.STAND_IN_PIDS
if (pidFile !== undefined) {
  const { writeFileSync, renameSync } = await import('node:fs')
  writeFileSync(pidFile + '.tmp', JSON.stringify({ pid: process.pid }))
  renameSync(pidFile + '.tmp', pidFile)
  setInterval(() => {}, 1000)
} else {
  say({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
  say({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 } })
}
`

const SECRET = 'candy-assertion-secret-at-least-32-bytes'
const KEY = 'candy-credential-key-32-bytes!!!'
const KEY_VERSION = '2026-09-a'
const ISSUER = 'candy-control-plane'
const AUDIENCE = 'candy-runtime-debian-1'
const ALICE = UserId('user-alice')
const ACCOUNT = ProviderAccountId('account-1')
const SESSION = brandString<SessionId>('session-1')
const RUN = RunId('run-root')
const BUDGET: RunBudget = { tokens: 100_000, wallMs: 600_000, costMicroUsd: 2_500_000, children: 4 }
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

/** Boot storage, the control plane, the scheduler, the LLM seam, a real subprocess service, and the route. */
async function boot(at: string): Promise<Context> {
  process.env['CANDY_ASSERTION_SECRET'] = SECRET
  process.env['CANDY_CREDENTIAL_KEY'] = KEY
  await mkdir(join(at, 'pools'), { mode: 0o700, recursive: true })
  const context = new Context()
  ctx = context
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
  await context.plugin(Llm)
  await context.plugin(SubprocessLocal)
  await context.plugin(ClaudeCliRoute, {
    executable: process.execPath,
    graceMs: 1_000,
    maxOutputBytes: 1024 * 1024,
    maxStderrBytes: 1024,
  })
  return context
}

/**
 * Insert the stand-in script as the process's first argument, the way a real
 * `claude` executable would already be a single resolved path — `argv[0]` is
 * `deployment.executable` (`node`, here), so the script belongs right after
 * it, ahead of every flag `dsh-claude-cli-protocol` builds.
 */
function useStandIn(context: Context, executable: string, extraEnv: NodeJS.ProcessEnv = {}): void {
  const spawn = context.subprocess.spawn.bind(context.subprocess)
  context.subprocess.spawn = (spec: SubprocessSpawnSpec) => spawn({
    ...spec,
    argv: [spec.argv[0] ?? '', executable, ...spec.argv.slice(1)],
    env: { ...spec.env, ...extraEnv },
  })
}

/** Give the tenant an allowance and a sealed credential, as a control plane would. */
async function provision(context: Context, now: number): Promise<void> {
  await context.controlPlaneStore.setTenantGrant(ALICE, BUDGET)
  await context.controlPlaneStore.save({
    record: {
      id: ACCOUNT, userId: ALICE, provider: 'claude-cli', label: 'work',
      createdAt: now, updatedAt: now, validatedAt: undefined, revokedAt: undefined, deletedAt: undefined, isDefault: true,
    },
    credential: sealCredential(Buffer.from('sk-ant-alice', 'utf8'), { userId: ALICE, accountId: ACCOUNT }, KEYRING, now).envelope,
  })
}

function claims(now: number, overrides: Partial<ExecutionAssertionClaims> = {}): ExecutionAssertionClaims {
  return {
    issuer: ISSUER, audience: AUDIENCE, userId: ALICE, deviceId: brandString<DeviceId>('device-1'),
    accountId: ACCOUNT, provider: 'claude-cli', workspaceGrantId: brandString<WorkspaceGrantId>('grant-1'),
    conversationId: brandString<ConversationId>('conversation-1'), sessionId: SESSION,
    runId: RUN, parentRunId: undefined, nonce: 'nonce-1',
    issuedAt: now, expiresAt: now + 60_000,
    ...overrides,
  }
}

function request(): GenerateOptions {
  return {
    provider: 'claude-cli',
    model: 'claude-sonnet-5',
    sessionId: SESSION,
    messages: [createUserMessage({ content: [{ type: 'text', text: 'report' }], source: { kind: 'user' } })],
  }
}

async function collectChunks(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const seen: StreamChunk[] = []
  for await (const chunk of stream) seen.push(chunk)
  return seen
}

async function collectText(context: Context): Promise<string> {
  const assembler = new BlockAssembler()
  for (const chunk of await collectChunks(context.llm.stream(request()))) assembler.push(chunk)
  const block = assembler.blocks().find(candidate => candidate.type === 'text')
  return block?.type === 'text' ? block.text : ''
}

describe('the Claude CLI route, resolved per call from a session', () => {
  it("hands the run's own tenant its home and credential", async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-claude-cli-route-'))
    const executable = join(root, 'stand-in-claude.mjs')
    await writeFile(executable, STAND_IN, 'utf8')
    const context = await boot(root)
    useStandIn(context, executable)
    const now = Date.now()
    await provision(context, now)
    await context.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)

    const text = await collectText(context)

    expect(JSON.parse(text)).toMatchObject({ key: 'sk-ant-alice' })
  })

  it('re-resolves the credential for a second call of the same run', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-claude-cli-route-'))
    const executable = join(root, 'stand-in-claude.mjs')
    await writeFile(executable, STAND_IN, 'utf8')
    const context = await boot(root)
    useStandIn(context, executable)
    const now = Date.now()
    await provision(context, now)
    await context.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
    await collectText(context)

    const second = await collectText(context)

    expect(JSON.parse(second)).toMatchObject({ key: 'sk-ant-alice' })
  })

  it('refuses a call whose account has since been revoked', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-claude-cli-route-'))
    const executable = join(root, 'stand-in-claude.mjs')
    await writeFile(executable, STAND_IN, 'utf8')
    const context = await boot(root)
    useStandIn(context, executable)
    const now = Date.now()
    await provision(context, now)
    await context.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)
    await revokeProviderAccount(context.controlPlaneStore, ALICE, ACCOUNT, now + 1)

    const seen = await collectChunks(context.llm.stream(request()))

    expect(seen).toMatchObject([{
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'CREDENTIAL_REVOKED' } },
    }])
  })

  it('refuses a request with no session', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-claude-cli-route-'))
    const context = await boot(root)

    const seen = await collectChunks(context.llm.stream({ provider: 'claude-cli', model: 'claude-sonnet-5', messages: [] }))

    expect(seen).toMatchObject([{
      type: 'finish',
      reason: { kind: 'error', failure: { code: ClaudeCliRoute.NO_SESSION_CODE } },
    }])
  })

  it('reaps a hanging launch when the scheduler settles the run for cause', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-claude-cli-route-'))
    const executable = join(root, 'stand-in-claude.mjs')
    await writeFile(executable, STAND_IN, 'utf8')
    const context = await boot(root)
    const pidFile = join(root, 'stand-in-pids.json')
    useStandIn(context, executable, { STAND_IN_PIDS: pidFile })
    const now = Date.now()
    await provision(context, now)
    await context.runScheduler.start(mintExecutionAssertion(claims(now), Buffer.from(SECRET, 'utf8')), undefined, now)

    const chunks = context.llm.stream(request())[Symbol.asyncIterator]()
    // Read to the first text delta: the stand-in has reached the point where
    // it reports its own pid and starts hanging.
    while (true) {
      const next = await chunks.next()
      if (next.done === true) throw new Error('the hanging run finished on its own')
      if (next.value.type === 'text-delta') break
    }
    const pid = await (async () => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        try {
          return (JSON.parse(await readFile(pidFile, 'utf8')) as { pid: number }).pid
        } catch {
          await new Promise(resolve => setTimeout(resolve, 10))
        }
      }
      throw new Error('the stand-in never reported its pid')
    })()
    const alive = (): boolean => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    expect(alive()).toBe(true)

    await context.runScheduler.close(RUN)

    const deadline = Date.now() + 5_000
    while (Date.now() < deadline && alive()) await new Promise(resolve => setTimeout(resolve, 10))
    expect(alive()).toBe(false)
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone, which is the passing case */ }
  })
})
