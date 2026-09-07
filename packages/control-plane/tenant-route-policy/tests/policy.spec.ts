import { Context } from '@deepseek-ai/cordis'
import Llm, { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import * as TenantRoutePolicy from '../src/index.ts'
import { TENANT_ROUTE_NOT_ALLOWED, type Config } from '../src/index.ts'

class RecordingAdapter extends LlmAdapter {
  calls: GenerateOptions[] = []

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const session = SessionId('session-managed')
const unmanaged = SessionId('session-unmanaged')
let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

async function boot(config: Config, tenantOf: (id: SessionId) => string | undefined = id => (
  id === session ? 'tenant-alice' : undefined
)): Promise<{ context: Context; adapter: RecordingAdapter }> {
  const context = new Context()
  ctx = context
  await context.plugin(Llm)
  const adapter = new RecordingAdapter()
  context.llm.registerAdapter(['claude-cli', 'codex-cli'], adapter)
  Object.defineProperty(context, 'runScheduler', { value: { tenantOf }, configurable: true })
  TenantRoutePolicy.apply(context, config)
  return { context, adapter }
}

async function call(context: Context, provider: string, model: string, sessionId: SessionId | null = session): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  const options: GenerateOptions = { provider, model, messages: [] }
  if (sessionId !== null) options.sessionId = sessionId
  for await (const chunk of context.llm.stream(options)) chunks.push(chunk)
  return chunks
}

describe('tenant model-route policy', () => {
  it('allows the exact provider/model pair granted to the managed tenant', async () => {
    const { context, adapter } = await boot({
      allowlists: { 'tenant-alice': [{ provider: 'claude-cli', model: 'sonnet' }] },
    })

    const chunks = await call(context, 'claude-cli', 'sonnet')

    expect(chunks).toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
    expect(adapter.calls).toHaveLength(1)
  })

  it('refuses another model on an otherwise-allowed provider before adapter selection', async () => {
    const { context, adapter } = await boot({
      allowlists: { 'tenant-alice': [{ provider: 'claude-cli', model: 'sonnet' }] },
    })

    const chunks = await call(context, 'claude-cli', 'opus')

    expect(chunks).toEqual([{
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          code: TENANT_ROUTE_NOT_ALLOWED,
          message: 'tenant "tenant-alice" is not permitted to use route "claude-cli/opus"',
        },
      },
    }])
    expect(adapter.calls).toHaveLength(0)
  })

  it('refuses another provider even when its model name matches', async () => {
    const { context, adapter } = await boot({
      allowlists: { 'tenant-alice': [{ provider: 'claude-cli', model: 'sonnet' }] },
    })

    await call(context, 'codex-cli', 'sonnet')

    expect(adapter.calls).toHaveLength(0)
  })

  it('checks the final route after Harness routing middleware rewrites it', async () => {
    const { context, adapter } = await boot({
      allowlists: { 'tenant-alice': [{ provider: 'claude-cli', model: 'sonnet' }] },
    })
    context.on('llm/stream', (options, next) => {
      options.model = 'opus'
      return next()
    })

    const [terminal] = await call(context, 'claude-cli', 'sonnet')

    expect(terminal).toMatchObject({
      type: 'finish', reason: { kind: 'error', failure: { code: TENANT_ROUTE_NOT_ALLOWED } },
    })
    expect(adapter.calls).toHaveLength(0)
  })

  it('denies a managed tenant missing from configuration', async () => {
    const { context, adapter } = await boot({ allowlists: {} })

    const [terminal] = await call(context, 'claude-cli', 'sonnet')

    expect(terminal).toMatchObject({
      type: 'finish', reason: { kind: 'error', failure: { code: TENANT_ROUTE_NOT_ALLOWED } },
    })
    expect(adapter.calls).toHaveLength(0)
  })

  it('keeps unmanaged sessions and calls without a session in Harness control', async () => {
    const { context, adapter } = await boot({ allowlists: {} })

    await call(context, 'claude-cli', 'sonnet', unmanaged)
    await call(context, 'claude-cli', 'sonnet', null)

    expect(adapter.calls).toHaveLength(2)
  })

  it('does not let one tenant inherit another tenant route grant', async () => {
    const bobbySession = SessionId('session-bobby')
    const { context, adapter } = await boot({
      allowlists: { 'tenant-alice': [{ provider: 'claude-cli', model: 'sonnet' }] },
    }, id => id === session ? 'tenant-alice' : id === bobbySession ? 'tenant-bobby' : undefined)

    await call(context, 'claude-cli', 'sonnet', session)
    const [terminal] = await call(context, 'claude-cli', 'sonnet', bobbySession)

    expect(adapter.calls).toHaveLength(1)
    expect(terminal).toMatchObject({
      type: 'finish', reason: { kind: 'error', failure: { code: TENANT_ROUTE_NOT_ALLOWED } },
    })
  })
})
