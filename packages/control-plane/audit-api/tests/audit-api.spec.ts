import { PassThrough } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { UserId, UserSessionId } from '@deepseek-ai/dsh-control-plane'
import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

async function request(role: 'member' | 'administrator') {
  const ctx = new Context()
  let route: { handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void } | undefined
  const recorded: unknown[] = []
  ctx.provide('webServer', { register: (value: typeof route) => { route = value; return () => {} } } as never)
  ctx.provide('controlPlaneStore', {
    authenticateUserSession: async () => ({ id: UserSessionId('s'), userId: UserId('admin'), role, identity: { issuer: 'i', subject: 's' }, createdAt: 1, expiresAt: Number.MAX_SAFE_INTEGER }),
    verifyUserSessionCsrf: () => true,
    recordAudit: async (...args: unknown[]) => { recorded.push(args) },
  } as never)
  ctx.provide('runScheduler', {
    auditsOfTenant: () => [{ at: 1, event: 'started', action: 'run', outcome: 'ok' }],
    auditsOfRuntime: () => [{ at: 2, event: 'refused', action: 'assertion', outcome: 'invalid' }],
  } as never)
  apply(ctx, { publicOrigin: 'https://candy.example', auditRetention: 7 })
  const req = new PassThrough() as unknown as IncomingMessage
  req.method = 'GET'; req.headers = { host: 'candy.example', cookie: '__Host-candy-session=x' }
  const answer: { status?: number; body: string | undefined } = { body: undefined }
  const res = { writeHead: (status: number) => { answer.status = status }, end: (body?: string) => { answer.body = body } }
  await route?.handler(req, res as unknown as ServerResponse)
  await ctx.fiber.dispose()
  return { answer, recorded }
}

describe('administrator audit window', () => {
  it('refuses members and returns both retained windows to administrators', async () => {
    expect((await request('member')).answer.status).toBe(403)
    const admin = await request('administrator')
    expect(admin.answer.status).toBe(200)
    expect(JSON.parse(admin.answer.body ?? '{}')).toMatchObject({ retention: 7, completeHistory: false, tenant: [{ at: 1 }], runtime: [{ at: 2 }] })
  })
})
