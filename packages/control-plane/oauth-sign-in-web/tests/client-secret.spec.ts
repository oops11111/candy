/**
 * The OIDC client secret is read once per code exchange, from the credential
 * seam when a deployment composes one and from the process environment when it
 * does not. These cases pin both sources and the loud absence between them.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { afterEach, describe, expect, it } from 'vitest'
import { clientSecretLoader } from '../src/index.ts'

const ENV = 'CANDY_TEST_OIDC_CLIENT_SECRET'

/** Restore the variable this suite writes, whichever case wrote it. */
function clearEnv(): void {
  delete process.env.CANDY_TEST_OIDC_CLIENT_SECRET
}

afterEach(clearEnv)

/** The one credential operation this loader performs, as a service. */
async function withCredentials(ctx: Context, value: string | undefined): Promise<void> {
  class Stub extends Service {
    constructor(inner: Context) {
      super(inner, 'credentials')
    }

    resolve(ref: CredentialRef): Promise<{ value: string; source: 'file' } | undefined> {
      expect(ref).toBe(credentialRef(ENV))
      return Promise.resolve(value === undefined ? undefined : { value, source: 'file' })
    }
  }
  await ctx.plugin(Stub as never, {} as never)
}

describe('loading the OIDC client secret', () => {
  it('reads the credential service when one is composed', async () => {
    const ctx = new Context()
    await withCredentials(ctx, 'from-the-vault')
    process.env[ENV] = 'from-the-environment'

    expect(await clientSecretLoader(ctx, ENV)()).toBe('from-the-vault')
  })

  it('reads the environment when no credential service answers', async () => {
    // A deployment that injects the secret as an environment variable composes
    // no credential provider, and must still be able to sign a person in.
    const ctx = new Context()
    process.env[ENV] = 'from-the-environment'

    expect(await clientSecretLoader(ctx, ENV)()).toBe('from-the-environment')
  })

  it('falls through to the environment when the service holds nothing', async () => {
    const ctx = new Context()
    await withCredentials(ctx, undefined)
    process.env[ENV] = 'from-the-environment'

    expect(await clientSecretLoader(ctx, ENV)()).toBe('from-the-environment')
  })

  it.each(['', undefined])('fails loudly rather than exchanging with a blank secret (%s)', async (value) => {
    const ctx = new Context()
    if (value === undefined) clearEnv()
    else process.env[ENV] = value

    await expect(clientSecretLoader(ctx, ENV)()).rejects.toThrow(/is not configured/)
  })

  it('resolves again on every exchange, so a rotation reaches the next sign-in', async () => {
    const ctx = new Context()
    const load = clientSecretLoader(ctx, ENV)
    process.env[ENV] = 'first'
    expect(await load()).toBe('first')

    process.env[ENV] = 'rotated'

    expect(await load()).toBe('rotated')
  })
})
