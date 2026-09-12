/** One-shot host management over the real durable device binding. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { DeviceId, UserId } from '@deepseek-ai/dsh-control-plane'
import DeviceBinding from '@deepseek-ai/dsh-device-binding'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, internals } from '../src/index.ts'
import { CANDY_HOST_STARTUP_SERVICE, type CandyHostStartupValues } from '../src/startup.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.unstubAllGlobals()
  internals.stdout = process.stdout
  internals.stderr = process.stderr
  while (cleanups.length > 0) await cleanups.pop()?.()
})

async function boot(): Promise<Context> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-candy-host-command-'))
  const ctx = new Context()
  const credentials = ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  await credentials
  const binding = ctx.plugin(DeviceBinding)
  await binding
  cleanups.push(async () => {
    await binding.dispose()
    await credentials.dispose()
    await rm(dir, { recursive: true, force: true })
  })
  return ctx
}

const exitListeners = new WeakMap<Context, (code: number) => void>()

async function run(ctx: Context, operation: CandyHostStartupValues): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  internals.stdout = { write: (chunk) => { out += chunk; return true } }
  internals.stderr = { write: (chunk) => { err += chunk; return true } }
  if (ctx.get('appExit') === undefined) {
    ctx.provide('appExit', (code) => { exitListeners.get(ctx)?.(code) })
  }
  ctx.provide(CANDY_HOST_STARTUP_SERVICE, operation)
  const code = await new Promise<number>((resolve) => {
    exitListeners.set(ctx, resolve)
    apply(ctx)
  })
  exitListeners.delete(ctx)
  return { code, out, err }
}

describe('Candy Host device-management command', () => {
  it('pairs through the existing binding and prints no token or code', async () => {
    const ctx = await boot()
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      userId: UserId('user-alice'),
      deviceId: DeviceId('device-one'),
      label: 'Studio desktop',
      token: 'issued-secret-token',
    }), { status: 201, headers: { 'content-type': 'application/json' } })))

    const result = await run(ctx, {
      operation: 'pair', serverOrigin: 'https://candy.example', code: 'ABCD-EFGH',
    })

    expect(result).toMatchObject({ code: 0, err: '' })
    expect(result.out).toContain('https://candy.example')
    expect(result.out).toContain('device-one')
    expect(result.out).not.toContain('issued-secret-token')
    expect(result.out).not.toContain('ABCD-EFGH')
  })

  it('reports status without the token', async () => {
    const ctx = await boot()
    await ctx.deviceBinding.bind({
      serverOrigin: 'https://candy.example',
      userId: UserId('user-alice'),
      deviceId: DeviceId('device-one'),
      token: 'stored-secret-token',
    }, Date.now())

    const status = await run(ctx, { operation: 'status' })
    expect(status).toMatchObject({ code: 0, err: '' })
    expect(status.out).toContain('device-one')
    expect(status.out).not.toContain('stored-secret-token')
    expect(await ctx.deviceBinding.read()).toBeDefined()
  })

  it('reports an unpaired host without creating a binding', async () => {
    const ctx = await boot()

    expect(await run(ctx, { operation: 'status' }))
      .toEqual({ code: 0, out: 'unpaired\n', err: '' })
    expect(await ctx.deviceBinding.read()).toBeUndefined()
  })

  it('releases only on the explicit operation', async () => {
    const ctx = await boot()
    await ctx.deviceBinding.bind({
      serverOrigin: 'https://candy.example',
      userId: UserId('user-alice'),
      deviceId: DeviceId('device-one'),
      token: 'stored-secret-token',
    }, Date.now())

    const released = await run(ctx, { operation: 'release' })
    expect(released).toEqual({ code: 0, out: 'released\n', err: '' })
    expect(await ctx.deviceBinding.read()).toBeUndefined()
  })

  it('does not echo a pairing code through an unexpected network failure', async () => {
    const ctx = await boot()
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(
      new Error('request body contained ABCD-EFGH and https://candy.example/private'),
    ))

    const result = await run(ctx, {
      operation: 'pair', serverOrigin: 'https://candy.example', code: 'ABCD-EFGH',
    })

    expect(result).toEqual({ code: 1, out: '', err: 'pair failed\n' })
    expect(await ctx.deviceBinding.read()).toBeUndefined()
  })

  it('classifies binding and exchange refusals without revealing the code', async () => {
    const invalidOrigin = await boot()
    const first = await run(invalidOrigin, {
      operation: 'pair', serverOrigin: 'not-an-origin', code: 'ABCD-EFGH',
    })
    expect(first).toEqual({ code: 1, out: '', err: 'pair failed (invalid-origin)\n' })

    const rejectedCode = await boot()
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(undefined, { status: 400 })))
    const second = await run(rejectedCode, {
      operation: 'pair', serverOrigin: 'https://candy.example', code: 'ABCD-EFGH',
    })
    expect(second).toEqual({ code: 1, out: '', err: 'pair failed (rejected)\n' })
  })

  it('fails startup when launcher or parsed operation is absent', () => {
    expect(() => { apply(new Context()) }).toThrow('must provide ctx.appExit')

    const ctx = new Context()
    ctx.provide('appExit', () => {})
    expect(() => { apply(ctx) }).toThrow('startup operation must be injected')
  })
})
