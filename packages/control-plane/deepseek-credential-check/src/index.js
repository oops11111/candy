import z from '@deepseek-ai/schemastery';
export const name = 'deepseek-credential-check';
export const inject = ['providerCredentialChecks'];
const DEFAULT_BASE_URL = 'https://api.deepseek.com';
export const Config = z.object({
    baseURL: z.string().default(DEFAULT_BASE_URL),
    timeoutMs: z.number().min(1).max(60_000).default(10_000),
});
/** Ask DeepSeek's authenticated model catalog whether a key is usable. */
export async function checkDeepSeekCredential(secret, options) {
    let apiKey;
    try {
        apiKey = new TextDecoder('utf-8', { fatal: true }).decode(secret).trim();
    }
    catch {
        return { valid: false, reason: 'invalid-credential' };
    }
    if (apiKey.length === 0)
        return { valid: false, reason: 'invalid-credential' };
    try {
        const response = await (options.fetch ?? fetch)(`${options.baseURL.replace(/\/$/, '')}/models`, {
            method: 'GET',
            headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
            signal: AbortSignal.timeout(options.timeoutMs),
        });
        if (response.ok)
            return { valid: true };
        if (response.status === 401 || response.status === 403) {
            return { valid: false, reason: 'invalid-credential' };
        }
        return { valid: false, reason: 'provider-unavailable' };
    }
    catch {
        return { valid: false, reason: 'provider-unavailable' };
    }
}
export function apply(ctx, config) {
    const resolved = { baseURL: config.baseURL ?? DEFAULT_BASE_URL, timeoutMs: config.timeoutMs ?? 10_000 };
    ctx.providerCredentialChecks.register('deepseek-api', secret => checkDeepSeekCredential(secret, resolved));
}
//# sourceMappingURL=index.js.map