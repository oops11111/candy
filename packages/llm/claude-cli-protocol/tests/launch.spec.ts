import { describe, expect, it } from 'vitest'
import {
  claudeCliArguments,
  claudeCliEnvironment,
  initApiKeySource,
  isCredentialIsolated,
  SCRUBBED_ROUTING_VARIABLES,
} from '../src/index.ts'

const ISOLATION = { home: '/srv/candy/pools/abc', apiKey: 'sk-ant-tenant' }

describe('claudeCliArguments', () => {
  it('asks for the stream protocol the translator reads', () => {
    const argv = claudeCliArguments({ prompt: 'hi' })

    expect(argv).toContain('--print')
    expect(argv.join(' ')).toContain('--output-format stream-json')
    expect(argv).toContain('--include-partial-messages')
    // The CLI refuses --print with stream-json unless --verbose is present.
    expect(argv).toContain('--verbose')
  })

  it('confines the run to the injected credential and denies host state', () => {
    const argv = claudeCliArguments({ prompt: 'hi' })

    expect(argv).toContain('--bare')
    expect(argv).toContain('--no-session-persistence')
    expect(argv).toContain('--strict-mcp-config')
    expect(argv.join(' ')).toContain('--permission-prompts none')
  })

  it('leaves the CLI no tools, because the harness executes them', () => {
    const argv = claudeCliArguments({ prompt: 'hi' })

    expect(argv[argv.indexOf('--tools') + 1]).toBe('')
    expect(argv[argv.indexOf('--setting-sources') + 1]).toBe('')
  })

  it('passes the prompt last, as the CLI positional argument', () => {
    expect(claudeCliArguments({ prompt: 'summarize this' }).at(-1)).toBe('summarize this')
  })

  it('passes a prompt that looks like a flag without it being read as one', () => {
    const argv = claudeCliArguments({ prompt: '--help' })

    // argv is passed to the process seam unsplit and never shell-interpreted,
    // so the positional stays positional.
    expect(argv.at(-1)).toBe('--help')
  })

  it('omits the generation choices the caller left to the CLI', () => {
    const argv = claudeCliArguments({ prompt: 'hi' })

    expect(argv).not.toContain('--model')
    expect(argv).not.toContain('--system-prompt')
    expect(argv).not.toContain('--max-budget-usd')
  })

  it('carries the generation choices the caller made', () => {
    const argv = claudeCliArguments({
      prompt: 'hi', model: 'claude-opus-5', systemPrompt: 'be terse', maxBudgetUsd: 0.5,
    })

    expect(argv[argv.indexOf('--model') + 1]).toBe('claude-opus-5')
    expect(argv[argv.indexOf('--system-prompt') + 1]).toBe('be terse')
    expect(argv[argv.indexOf('--max-budget-usd') + 1]).toBe('0.5')
  })

  it.each([[0], [-1], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    'refuses the unusable spend ceiling %s', (maxBudgetUsd) => {
      expect(() => claudeCliArguments({ prompt: 'hi', maxBudgetUsd })).toThrow(RangeError)
    },
  )
})

describe('claudeCliEnvironment', () => {
  it('pins the child to the tenant home and key', () => {
    expect(claudeCliEnvironment(ISOLATION)).toMatchObject({
      HOME: '/srv/candy/pools/abc',
      ANTHROPIC_API_KEY: 'sk-ant-tenant',
    })
  })

  it('tombstones every provider-routing variable', () => {
    const env = claudeCliEnvironment(ISOLATION)

    for (const name of SCRUBBED_ROUTING_VARIABLES) {
      expect(env).toHaveProperty(name)
      expect(env[name]).toBeUndefined()
    }
  })

  it('removes the toggles that would redirect the run off the tenant key', () => {
    const env = claudeCliEnvironment(ISOLATION)

    // Each of these routes the CLI to a cloud provider authenticated with the
    // host's own credentials, which --bare does not govern.
    expect(env).toHaveProperty('CLAUDE_CODE_USE_BEDROCK', undefined)
    expect(env).toHaveProperty('CLAUDE_CODE_USE_VERTEX', undefined)
    expect(env).toHaveProperty('ANTHROPIC_BASE_URL', undefined)
    expect(env).toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN', undefined)
  })

  it('never leaves the tenant key among the tombstones', () => {
    expect(SCRUBBED_ROUTING_VARIABLES).not.toContain('ANTHROPIC_API_KEY')
  })

  it.each([
    ['home', { home: '', apiKey: 'k' }],
    ['apiKey', { home: '/h', apiKey: '' }],
  ])('refuses an empty %s rather than falling back to host identity', (_field, isolation) => {
    expect(() => claudeCliEnvironment(isolation)).toThrow(RangeError)
  })
})

describe('initApiKeySource', () => {
  it('reads the source from an init frame', () => {
    expect(initApiKeySource({ type: 'system', subtype: 'init', apiKeySource: 'ANTHROPIC_API_KEY' }))
      .toBe('ANTHROPIC_API_KEY')
  })

  it.each([
    ['a non-init system frame', { type: 'system', subtype: 'status', apiKeySource: 'ANTHROPIC_API_KEY' }],
    ['a non-system frame', { type: 'result', apiKeySource: 'ANTHROPIC_API_KEY' }],
  ])('answers nothing for %s', (_case, frame) => {
    expect(initApiKeySource(frame)).toBeUndefined()
  })

  it('answers nothing for an init frame whose source is not a string', () => {
    expect(initApiKeySource({ type: 'system', subtype: 'init', apiKeySource: null })).toBeUndefined()
  })
})

describe('isCredentialIsolated', () => {
  it('confirms a run that used the injected key', () => {
    expect(isCredentialIsolated({ type: 'system', subtype: 'init', apiKeySource: 'ANTHROPIC_API_KEY' })).toBe(true)
  })

  it('denies a run that authenticated some other way', () => {
    // "none" is what an ambient OAuth login reports: the run is spending
    // someone other than the tenant.
    expect(isCredentialIsolated({ type: 'system', subtype: 'init', apiKeySource: 'none' })).toBe(false)
  })

  it('distinguishes "not isolated" from "not an answer"', () => {
    expect(isCredentialIsolated({ type: 'result' })).toBeUndefined()
  })
})
