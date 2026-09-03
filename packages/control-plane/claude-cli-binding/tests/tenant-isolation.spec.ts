/**
 * The isolation claim, exercised end to end: mint an assertion, admit it, bind
 * it, and run a real process through `dsh-subprocess`.
 *
 * Every other spec in this chain checks one link. This one checks that the
 * links hold together where it matters — what the operating system hands the
 * child. The stand-in executable reports the environment it was actually
 * given, so a home or a key that leaked between tenants shows up as a value in
 * the model's own output rather than as an assertion about an object.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ConversationId, DeviceId, ProviderAccountId, RunId, UserId, WorkspaceGrantId } from '@deepseek-ai/dsh-control-plane'
import { CredentialKeyVersion, sealCredential, type CredentialKeyring } from '@deepseek-ai/dsh-credential-vault'
import { mintExecutionAssertion, type ExecutionAssertionClaims } from '@deepseek-ai/dsh-execution-assertion'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { ClaudeCliAdapter } from '@deepseek-ai/dsh-llm-claude-cli'
import { admitRun, type AdmittedRun, type RunAdmissionPolicy } from '@deepseek-ai/dsh-run-admission'
import type { RunBudget } from '@deepseek-ai/dsh-run-budget'
import type { SessionId } from '@deepseek-ai/dsh-session'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bindClaudeCliRun, type ClaudeCliDeployment } from '../src/index.ts'

const ASSERTION_SECRET = Buffer.alloc(32, 3)
const KEY_VERSION = CredentialKeyVersion('2026-09-a')
const NOW = 1_800_000_000_000
const LIFETIME = 60_000
const BUDGET: RunBudget = { tokens: 100_000, wallMs: 600_000, costMicroUsd: 2_500_000, children: 4 }

const EXPECTATION = {
  issuer: 'candy-control-plane',
  audience: 'candy-runtime-debian-1',
  maxLifetimeMs: LIFETIME,
} as const

const KEYRING: CredentialKeyring = {
  currentVersion: KEY_VERSION,
  keys: new Map([[KEY_VERSION, Buffer.alloc(32, 5)]]),
}

/**
 * A stand-in `claude` that answers with the environment it was handed.
 *
 * `apiKeySource` mirrors the real CLI's init frame, so a run told to report
 * `none` exercises the credential-isolation refusal without a real provider.
 */
const STAND_IN = `
const say = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n')
const source = process.env.STAND_IN_KEY_SOURCE ?? 'ANTHROPIC_API_KEY'
say({ type: 'system', subtype: 'init', apiKeySource: source })
const report = JSON.stringify({
  home: process.env.HOME,
  cwd: process.cwd(),
  key: process.env.ANTHROPIC_API_KEY ?? 'absent',
  routed: process.env.CLAUDE_CODE_USE_BEDROCK ?? 'absent',
  baseUrl: process.env.ANTHROPIC_BASE_URL ?? 'absent',
  probe: process.env.STAND_IN_AMBIENT_PROBE ?? 'absent',
  budget: process.argv.includes('--max-budget-usd')
    ? process.argv[process.argv.indexOf('--max-budget-usd') + 1]
    : 'absent',
})
say({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } })
say({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: report } } })
say({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
say({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', total_cost_usd: 0.5, usage: { input_tokens: 1, output_tokens: 1 } })
`

let root: string
let executable: string
let ctx: Context

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-tenant-isolation-'))
  executable = join(root, 'stand-in-claude.mjs')
  await writeFile(executable, STAND_IN, 'utf8')
  ctx = new Context()
  await ctx.plugin(SubprocessLocal)
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

function claims(overrides: Partial<ExecutionAssertionClaims> = {}): ExecutionAssertionClaims {
  return {
    issuer: EXPECTATION.issuer,
    audience: EXPECTATION.audience,
    userId: UserId('user-alice'),
    deviceId: DeviceId('device-1'),
    accountId: ProviderAccountId('account-1'),
    provider: 'claude-cli',
    workspaceGrantId: WorkspaceGrantId('grant-1'),
    conversationId: ConversationId('conversation-1'),
    sessionId: brandString<SessionId>('session-1'),
    runId: RunId('run-1'),
    parentRunId: undefined,
    nonce: 'nonce-1',
    issuedAt: NOW,
    expiresAt: NOW + LIFETIME,
    ...overrides,
  }
}

/** Admit one run for real against a pool base inside this spec's own directory. */
async function admitted(secret: string, overrides: Partial<ExecutionAssertionClaims> = {}): Promise<AdmittedRun> {
  const subject = claims(overrides)
  const policy: RunAdmissionPolicy = {
    expectation: EXPECTATION,
    assertionSecret: ASSERTION_SECRET,
    keyring: KEYRING,
    poolBase: join(root, 'pools'),
    findBudget: () => Promise.resolve(BUDGET),
    spendNonce: () => Promise.resolve(true),
    findCredential: () => Promise.resolve(
      sealCredential(
        Buffer.from(secret, 'utf8'),
        { userId: subject.userId, accountId: subject.accountId },
        KEYRING,
        NOW,
      ).envelope,
    ),
  }
  const admission = await admitRun({ token: mintExecutionAssertion(subject, ASSERTION_SECRET) }, policy, NOW)
  if (!admission.admitted) throw new Error(`the fixture run was denied at ${admission.rejection.stage}`)
  return admission.run
}

/** The whole chain for one tenant: admit, bind, spawn, assemble. */
async function runFor(
  secret: string,
  overrides: Partial<ExecutionAssertionClaims> = {},
  env: NodeJS.ProcessEnv = {},
): Promise<{ text: string; run: AdmittedRun }> {
  const run = await admitted(secret, overrides)
  // Creating the pool directory is the deployment's, not the binding's; a
  // launch into a directory nobody made fails at spawn.
  await mkdir(run.poolRoot, { recursive: true, mode: 0o700 })
  const deployment: ClaudeCliDeployment = { executable: process.execPath, graceMs: 2_000 }
  const result = bindClaudeCliRun(run, deployment)
  if (!result.bound) throw new Error(`the fixture run would not bind: ${result.rejection}`)
  const adapter = new ClaudeCliAdapter({
    ...result.binding,
    // The stand-in is a script, so the executable is node and the script is
    // its first argument; everything else about the launch is the binding's.
    spawn: spec => ctx.subprocess.spawn({
      ...spec,
      argv: [spec.argv[0] ?? '', executable, ...spec.argv.slice(1)],
      env: { ...spec.env, ...env },
    }),
  })
  const assembler = new BlockAssembler()
  for await (const chunk of adapter.stream({
    provider: 'claude-cli',
    model: 'claude-sonnet-5',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'report' }], source: { kind: 'user' } })],
  })) {
    assembler.push(chunk)
  }
  const block = assembler.blocks().find(candidate => candidate.type === 'text')
  return { text: block?.type === 'text' ? block.text : '', run }
}

describe('a tenant run, from token to process', () => {
  it('hands the child that tenant\'s home, working directory, and key', async () => {
    const { text, run } = await runFor('sk-ant-alice')

    expect(JSON.parse(text)).toEqual({
      home: run.poolRoot,
      cwd: run.poolRoot,
      key: 'sk-ant-alice',
      routed: 'absent',
      baseUrl: 'absent',
      probe: 'absent',
      budget: '2.5',
    })
  })

  it('tombstones the ambient routing variables that would redirect the run', async () => {
    const restore = { ...process.env }
    process.env['CLAUDE_CODE_USE_BEDROCK'] = '1'
    process.env['ANTHROPIC_BASE_URL'] = 'https://gateway.example/v1'
    process.env['STAND_IN_AMBIENT_PROBE'] = 'present'
    try {
      const { text } = await runFor('sk-ant-alice')

      // Either routing variable would send the run to a provider that
      // authenticates with the host's own credentials, spending nobody's
      // tenant budget and leaving the injected key unused. The probe is the
      // control: an ordinary ambient entry does reach the child, so their
      // absence is the tombstone rather than a child with no inherited
      // environment at all.
      expect(JSON.parse(text)).toMatchObject({ routed: 'absent', baseUrl: 'absent', probe: 'present' })
    } finally {
      process.env = restore
    }
  })

  it('gives two tenants two homes and never crosses their keys', async () => {
    const alice = await runFor('sk-ant-alice')
    const bob = await runFor('sk-ant-bob', { userId: UserId('user-bob'), nonce: 'nonce-2' })

    const first = JSON.parse(alice.text) as { home: string; key: string }
    const second = JSON.parse(bob.text) as { home: string; key: string }
    expect(first.home).not.toBe(second.home)
    expect(first.key).toBe('sk-ant-alice')
    expect(second.key).toBe('sk-ant-bob')
    // The claim is not merely that they differ: neither process could see the
    // other's secret at all.
    expect(alice.text).not.toContain('sk-ant-bob')
    expect(bob.text).not.toContain('sk-ant-alice')
  })

  it('fails a run that authenticated with anything but the injected key', async () => {
    // A run that reached some other credential is billing a tenant that did
    // not authorize it, so the isolation the binding always requires must stop
    // it at the CLI's own report rather than let it finish.
    await expect(runFor('sk-ant-alice', {}, { STAND_IN_KEY_SOURCE: 'none' }))
      .rejects.toThrow(/did not inject/)
  })

  it('carries the admitted budget to the process as its spend ceiling', async () => {
    const { text } = await runFor('sk-ant-alice')

    expect((JSON.parse(text) as { budget: string }).budget).toBe('2.5')
  })
})
