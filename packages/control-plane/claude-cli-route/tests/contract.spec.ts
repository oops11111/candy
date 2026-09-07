/**
 * The shared `dsh-llm` adapter contract, run against the session-routed
 * Claude CLI route. Each scenario scripts a CLI process; the suite owns what
 * the adapter must do with it. Identity resolution is stubbed to a fixed,
 * always-successful answer, since `dsh-run-scheduler`'s own tests are what
 * cover `runIdentityFor` itself.
 */

import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RunId } from '@deepseek-ai/dsh-control-plane'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { testLlmAdapterContract } from '@deepseek-ai/dsh-llm-adapter-contract'
import type { RunIdentity } from '@deepseek-ai/dsh-run-scheduler'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it } from 'vitest'
import { PROVIDER, SessionRoutedClaudeCliAdapter, type SessionRunIdentitySource } from '../src/index.ts'

const SECRET = 'sk-ant-contract-secret'

function recorded(name: string): string {
  return readFileSync(fileURLToPath(
    new URL(`../../../llm/claude-cli-protocol/tests/fixtures/${name}`, import.meta.url),
  ), 'utf8')
}

/** One scripted process: what it writes, how it ends, and whether it was reaped. */
function scripted(stdout: Readable, outcome?: SubprocessOutcome) {
  let terminated = false
  const handle: SubprocessHandle = {
    pid: 99,
    stdin: undefined,
    stdout,
    stderr: undefined,
    collected: {},
    // A run nobody ends never resolves this; the adapter must not depend on it
    // except where it has established the process died on its own.
    done: outcome === undefined ? new Promise<SubprocessOutcome>(() => {}) : Promise.resolve(outcome),
    terminate: () => { terminated = true },
    waitForExit: () => Promise.resolve(true),
  }
  return { handle, terminated: () => terminated }
}

/** A live pipe carrying `text` and then nothing: a process still running. */
function openPipe(text: string): Readable {
  const pipe = new Readable({ read() {} })
  pipe.push(text)
  return pipe
}

const IDENTITY: RunIdentity = {
  runId: RunId('run-contract'),
  provider: PROVIDER,
  poolRoot: '/srv/candy/pools/abc',
  secret: Buffer.from(SECRET, 'utf8'),
  remaining: { tokens: 1_000_000, wallMs: 600_000, costMicroUsd: 10_000_000, children: 0 },
}

/** A scheduler stub answering the one identity every scenario runs under. */
function schedulerOver(handle: SubprocessHandle): SessionRunIdentitySource {
  return {
    runIdentityFor: () => Promise.resolve({ ok: true, value: IDENTITY }),
    // Every scenario here instantiates the real method at the same Spec/Handle
    // this suite's own SubprocessHandle already is; the cast is narrower than
    // the fully generic method type this stub does not need to satisfy.
    disposableSpawn: (() => () => handle) as SessionRunIdentitySource['disposableSpawn'],
  }
}

function adapterOver(handle: SubprocessHandle): SessionRoutedClaudeCliAdapter {
  return new SessionRoutedClaudeCliAdapter({
    deployment: { executable: '/usr/bin/claude', graceMs: 5_000, maxOutputBytes: 1_000_000, maxStderrBytes: 8_192 },
    scheduler: schedulerOver(handle),
    spawn: () => handle,
  })
}

const SESSION = brandString<SessionId>('session-contract')

function request(signal?: AbortSignal): GenerateOptions {
  return {
    provider: PROVIDER,
    model: 'claude-opus-5',
    sessionId: SESSION,
    messages: [createUserMessage({ content: [{ type: 'text', text: 'say ok' }], source: { kind: 'user' } })],
    ...signal === undefined ? {} : { signal },
  }
}

/**
 * Stream through the seam, which is where the contract holds: the runtime, not
 * the adapter, guarantees a terminal chunk for a run that throws.
 */
async function* viaSeam(adapter: SessionRoutedClaudeCliAdapter, signal?: AbortSignal): AsyncIterable<StreamChunk> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter([PROVIDER], adapter)
  try {
    yield* ctx.llm.stream(request(signal))
  } finally {
    await ctx.fiber.dispose()
  }
}

/** Frames through the first that produces a chunk, so a consumer has one to break on. */
const THROUGH_FIRST_CHUNK = recorded('text-turn.jsonl').split('\n').slice(0, 8).join('\n') + '\n'

testLlmAdapterContract({
  name: 'SessionRoutedClaudeCliAdapter',
  secret: SECRET,
  run: (signal): AsyncIterable<StreamChunk> => {
    const { handle } = scripted(Readable.from([recorded('text-turn.jsonl')]), { exitCode: 0, signal: null })
    return viaSeam(adapterOver(handle), signal)
  },
  failingRun: (): AsyncIterable<StreamChunk> => {
    // A real recorded run whose every request failed authentication.
    const { handle } = scripted(Readable.from([recorded('auth-failure.jsonl')]), { exitCode: 1, signal: null })
    return viaSeam(adapterOver(handle))
  },
  leakingRun: (): AsyncIterable<StreamChunk> => {
    // A CLI that quotes the injected key back in its terminal frame.
    const frames = [
      JSON.stringify({ type: 'system', subtype: 'init', apiKeySource: 'ANTHROPIC_API_KEY' }),
      JSON.stringify({ type: 'result', is_error: true, result: `authentication failed for ${SECRET}`, terminal_reason: 'auth' }),
    ].join('\n')
    const { handle } = scripted(Readable.from([frames]), { exitCode: 1, signal: null })
    return viaSeam(adapterOver(handle))
  },
  openRun: () => {
    const { handle, terminated } = scripted(openPipe(THROUGH_FIRST_CHUNK))
    return { chunks: viaSeam(adapterOver(handle)), released: terminated }
  },
}, { describe, it, expect })
