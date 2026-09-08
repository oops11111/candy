/** DeepSeek HTTP credential validation for Candy provider accounts. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ProviderAccountValidation } from '@deepseek-ai/dsh-provider-accounts'
export declare const name = 'deepseek-credential-check'
export declare const inject: string[]
export interface Config {
  baseURL?: string
  timeoutMs?: number
}
export declare const Config: z<Config>
/** Ask DeepSeek's authenticated model catalog whether a key is usable. */
export declare function checkDeepSeekCredential(secret: Uint8Array, options: {
  baseURL: string
  timeoutMs: number
  fetch?: typeof fetch
}): Promise<ProviderAccountValidation>
export declare function apply(ctx: Context, config: Config): void
//# sourceMappingURL=index.d.ts.map
