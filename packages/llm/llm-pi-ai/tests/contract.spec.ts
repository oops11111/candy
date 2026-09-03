/**
 * The shared `dsh-llm` adapter contract, run against a pi-ai route. Each
 * scenario scripts the mock chat-completions server; the suite owns what the
 * adapter must do with it.
 */

import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { testLlmAdapterContract } from '@deepseek-ai/dsh-llm-adapter-contract'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

const SECRET = 'pi-ai-contract-secret'

afterEach(async () => {
  vi.unstubAllEnvs()
  await closeMockServers()
})

function request(signal?: AbortSignal): GenerateOptions {
  return {
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
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
  vi.stubEnv('PI_CONTRACT_KEY', SECRET)
  const server = await mockServer(script)
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, {
    providers: { deepseek: { apiKeyEnv: 'PI_CONTRACT_KEY', baseURL: server.url } },
  })
  try {
    yield* ctx.llm.stream(request(signal))
  } finally {
    await ctx.fiber.dispose()
  }
}

testLlmAdapterContract({
  name: 'PiAiAdapter',
  secret: SECRET,
  run: signal => streamed([{ events: textEvents }], signal),
  failingRun: () => streamed([{
    status: 401,
    body: '{"error":{"message":"Incorrect API key provided"}}',
  }]),
  openRun: () => {
    let close: (() => boolean) | undefined
    // The first two events open a text block, so a consumer has a chunk to
    // break on while the connection stays open.
    const chunks = (async function* (): AsyncIterable<StreamChunk> {
      vi.stubEnv('PI_CONTRACT_KEY', SECRET)
      const server = await mockServer([{ events: textEvents.slice(0, 2), hold: true }])
      close = () => server.closedResponses > 0
      const ctx = new Context()
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(LlmPiAi, {
        providers: { deepseek: { apiKeyEnv: 'PI_CONTRACT_KEY', baseURL: server.url } },
      })
      try {
        yield* ctx.llm.stream(request())
      } finally {
        await ctx.fiber.dispose()
      }
    })()
    return { chunks, released: () => close?.() === true }
  },
}, { describe, it, expect })
