/**
 * Where provider integrations say whether one stored credential still
 * authenticates.
 *
 * Checking a credential means talking to that provider, which only the
 * integration for it knows how to do. This registry is the seam between the
 * two: a management API asks for a verdict and never learns the endpoint, the
 * request, or the response body, and an integration answers without knowing
 * which tenant or account the secret came from.
 *
 * A provider nothing registered for answers `unsupported-provider`, which is
 * what a deployment that composed no integration should report — not that the
 * credential is invalid, which it has no way to know.
 *
 * @module @deepseek-ai/dsh-provider-credential-checks
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { AnonymousEntries } from '@deepseek-ai/dsh-scope'
import type { ProviderKind } from '@deepseek-ai/dsh-control-plane'
import type { ProviderAccountValidation } from '@deepseek-ai/dsh-provider-accounts'

export type { ProviderCredentialCheck } from './types.ts'

import type { ProviderCredentialCheck } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    providerCredentialChecks: ProviderCredentialChecks
  }
}

/** The registry one deployment's provider integrations contribute to. */
export default class ProviderCredentialChecks extends Service {
  private readonly checks = new Map<ProviderKind, AnonymousEntries<ProviderCredentialCheck>>()

  constructor(ctx: Context) {
    super(ctx, 'providerCredentialChecks')
  }

  /**
   * Register how one provider's credential is checked.
   * @param provider - the provider this check speaks for.
   * @param check - answers whether one secret authenticates, and nothing else.
   * @returns the disposer removing the registration.
   */
  register(provider: ProviderKind, check: ProviderCredentialCheck): () => void {
    const entries = this.checks.get(provider) ?? new AnonymousEntries<ProviderCredentialCheck>()
    this.checks.set(provider, entries)
    // oxlint-disable-next-line typescript/no-misused-promises -- synchronous cleanup; direct return preserves disposer identity
    return this.ctx.effect(() => entries.append(check), 'providerCredentialChecks.register()')
  }

  /**
   * Ask whether one credential authenticates with its provider.
   *
   * The first registration for a provider answers. A deployment composes one
   * integration per provider, and a second would be two opinions about one
   * fact with no rule for choosing between them.
   * @param provider - the account's provider.
   * @param secret - the opened credential, held only for this call.
   * @returns the verdict, or `unsupported-provider` when nothing is registered.
   */
  async check(provider: ProviderKind, secret: Uint8Array): Promise<ProviderAccountValidation> {
    const [first] = [...this.checks.get(provider)?.values() ?? []]
    if (first === undefined) return { valid: false, reason: 'unsupported-provider' }
    return first(secret)
  }
}
