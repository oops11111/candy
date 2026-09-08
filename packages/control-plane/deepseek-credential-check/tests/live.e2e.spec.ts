import { describe, expect, it } from 'vitest'
import { checkDeepSeekCredential } from '../src/index.ts'

const key = process.env.DEEPSEEK_API_KEY
describe.skipIf(key === undefined)('DeepSeek live credential check', () => {
  it('accepts the configured real key without exposing it', async () => {
    const result = await checkDeepSeekCredential(new TextEncoder().encode(key ?? ''), {
      baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com', timeoutMs: 15_000,
    })
    expect(result).toEqual({ valid: true })
    expect(JSON.stringify(result)).not.toContain(key)
  })
})
