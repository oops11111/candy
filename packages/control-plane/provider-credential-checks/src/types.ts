/**
 * What a provider integration contributes to the credential-check registry.
 * @module @deepseek-ai/dsh-provider-credential-checks/src/types
 */

import type { ProviderAccountValidation } from '@deepseek-ai/dsh-provider-accounts'

/**
 * How one provider's credential is checked.
 *
 * It receives the opened secret and answers a verdict. It is given no
 * endpoint, returns no provider response body, and its diagnostic is the only
 * text that reaches a client.
 * @param secret - the opened credential, held only for this call.
 * @returns whether the credential authenticates, and why not when it does not.
 */
export type ProviderCredentialCheck = (secret: Uint8Array) => Promise<ProviderAccountValidation>
