/**
 * The shared `dsh-llm` adapter contract, run against the Claude CLI route.
 * Each scenario scripts a CLI process; the suite owns what the adapter must do
 * with it.
 */

import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { testLlmAdapterContract } from '@deepseek-ai/dsh-llm-adapter-contract'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it } from 'vitest'
import { ClaudeCliAdapter } from '../src/index.ts'

const SECRET = 'sk-ant-contract-secret'

function recorded(name: string): string {
  return readFileSync(fileURLToPath(
    new URL(`../../claude-cli-protocol/tests/fixtures/${name}`, import.meta.url),
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

function adapterOver(handle: SubprocessHandle): ClaudeCliAdapter {
  return new ClaudeCliAdapter({
    executable: '/usr/bin/claude',
    cwd: '/workspace',
    isolation: { home: '/srv/candy/pools/abc', apiKey: SECRET },
    graceMs: 5_000,
    maxOutputBytes: 1_000_000,
    spawn: () => handle,
    requireCredentialIsolation: false,
  })
}

function request(signal?: AbortSignal): GenerateOptions {
  return {
    provider: 'claude-cli',
    model: 'claude-opus-5',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'say ok' }], source: { kind: 'user' } })],
    ...signal === undefined ? {} : { signal },
  }
}

/**
 * Stream through the seam, which is where the contract holds: the runtime, not
 * the adapter, guarantees a terminal chunk for a run that throws.
 */
async function* viaSeam(adapter: ClaudeCliAdapter, signal?: AbortSignal): AsyncIterable<StreamChunk> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['claude-cli'], adapter)
  try {
    yield* ctx.llm.stream(request(signal))
  } finally {
    await ctx.fiber.dispose()
  }
}

/** Frames through the first that produces a chunk, so a consumer has one to break on. */
const THROUGH_FIRST_CHUNK = recorded('text-turn.jsonl').split('\n').slice(0, 8).join('\n') + '\n'

testLlmAdapterContract({
  name: 'ClaudeCliAdapter',
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
  openRun: () => {
    const { handle, terminated } = scripted(openPipe(THROUGH_FIRST_CHUNK))
    return { chunks: viaSeam(adapterOver(handle)), released: terminated }
  },
}, { describe, it, expect })
