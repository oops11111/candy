/**
 * The shared `dsh-llm` adapter contract, run against the DeepSeek route.
 * Each scenario scripts the mock chat-completions server; the suite owns what
 * the adapter must do with it.
 */

import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import type { PreparedDeepSeekLlmApiExtensions } from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { testLlmAdapterContract } from '@deepseek-ai/dsh-llm-adapter-contract'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import { DeepSeekAdapter } from '../src/adapter.ts'
import { resolveAdapterOptions } from '../src/index.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

const SECRET = 'sk-deepseek-contract-secret'
const TEST_USER_ID = '00000000-0000-4000-8000-000000000001' as AnonymousUserId
/** The registry's empty preparation: no lifecycle-owned request fields. */
function noExtensions(): Promise<PreparedDeepSeekLlmApiExtensions> {
  return Promise.resolve({ fields: {}, accept: () => Promise.resolve() })
}

afterEach(async () => { await closeMockServers() })

function adapterFor(baseURL: string): DeepSeekAdapter {
  return new DeepSeekAdapter({
    options: () => resolveAdapterOptions({ baseURL }),
    resolveApiKey: () => Promise.resolve(SECRET),
    resolveUserId: () => TEST_USER_ID,
    prepareExtensions: noExtensions,
  })
}

function request(signal?: AbortSignal): GenerateOptions {
  return {
    provider: 'deepseek-official',
    model: 'deepseek-chat',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'say ok' }], source: { kind: 'user' } })],
    ...signal === undefined ? {} : { signal },
  }
}

/**
 * Start a scripted server and stream one request through the seam, which is
 * where the contract holds: the runtime, not the adapter, guarantees a
 * terminal chunk for a run that throws.
 */
async function* streamed(
  script: Parameters<typeof mockServer>[0],
  signal?: AbortSignal,
): AsyncIterable<StreamChunk> {
  const server = await mockServer(script)
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['deepseek-official'], adapterFor(server.url))
  try {
    yield* ctx.llm.stream(request(signal))
  } finally {
    await ctx.fiber.dispose()
  }
}

testLlmAdapterContract({
  name: 'DeepSeekAdapter',
  secret: SECRET,
  run: signal => streamed([{ kind: 'sse', events: textEvents }], signal),
  failingRun: () => streamed([{
    kind: 'http-error',
    status: 401,
    body: '{"error":{"message":"Authentication Fails"}}',
  }]),
  openRun: () => {
    let released = false
    // The first two events open a text block, so a consumer has a chunk to
    // break on while the connection stays open.
    const chunks = streamed([{
      kind: 'hold',
      events: textEvents.slice(0, 2),
      onRelease: () => { released = true },
    }])
    return { chunks, released: () => released }
  },
}, { describe, it, expect })
