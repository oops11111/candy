import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, LlmError, type GenerateOptions, type Message, type ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { projectRequest, UNSUPPORTED_REQUEST_CODE } from '../src/index.ts'

function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'claude-cli',
    model: 'claude-opus-5',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'say ok' }], source: { kind: 'user' } })],
    ...overrides,
  }
}

/** Assert a refusal that names its reason, rather than a silently dropped option. */
function expectRefusal(options: GenerateOptions, reason: RegExp): void {
  try {
    projectRequest(options)
    expect.unreachable('the request must be refused')
  } catch (error) {
    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).code).toBe(UNSUPPORTED_REQUEST_CODE)
    expect((error as LlmError).message).toMatch(reason)
  }
}

describe('projectRequest', () => {
  it('projects a single-turn request onto an invocation', () => {
    expect(projectRequest(request({ system: 'be terse' }))).toEqual({
      prompt: 'say ok',
      systemPrompt: 'be terse',
      model: 'claude-opus-5',
      effort: undefined,
      maxBudgetUsd: undefined,
    })
  })

  it('joins the turn\'s text blocks in order', () => {
    const messages: Message[] = [createUserMessage({
      content: [{ type: 'text', text: 'say ' }, { type: 'text', text: 'ok' }],
      source: { kind: 'user' },
    })]

    expect(projectRequest(request({ messages })).prompt).toBe('say ok')
  })

  it('applies the deployment\'s spend ceiling', () => {
    expect(projectRequest(request(), 0.5).maxBudgetUsd).toBe(0.5)
  })

  it.each([['low'], ['medium'], ['high'], ['xhigh'], ['max']])('accepts the %s effort', (effort) => {
    const reasoningEffort = brandString<ReasoningEffortId>(effort)

    expect(projectRequest(request({ reasoningEffort })).effort).toBe(effort)
  })

  it('refuses an effort minted for another adapter rather than dropping it', () => {
    expectRefusal(request({ reasoningEffort: brandString<ReasoningEffortId>('off') }), /reasoning effort "off"/)
  })
})

describe('a request the CLI cannot carry', () => {
  it('refuses a conversation, because the CLI replays no assistant history', () => {
    const messages: Message[] = [
      createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }),
      createUserMessage({ content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } }),
    ]

    expectRefusal(request({ messages }), /cannot replay assistant history/)
  })

  it('refuses an empty conversation', () => {
    expectRefusal(request({ messages: [] }), /one user message/)
  })

  it('refuses a lone non-user message', () => {
    const messages = [{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }] as unknown as Message[]

    expectRefusal(request({ messages }), /must be a user message/)
  })

  it('refuses non-text content, naming the block that stopped it', () => {
    const messages = [{
      role: 'user',
      content: [{ type: 'text', text: 'look' }, { type: 'image', attachment: {} }],
    }] as unknown as Message[]

    expectRefusal(request({ messages }), /not a image block/)
  })

  it.each([
    ['a blank prompt', { messages: [createUserMessage({ content: [{ type: 'text', text: '  ' }], source: { kind: 'user' } })] }, /must not be empty/],
    ['tool schemas', { tools: [{ name: 't', description: 'd', parameters: {} }] }, /no caller-supplied tool schemas/],
    ['an output cap', { maxTokens: 100 }, /no output-token cap flag/],
    ['a temperature', { temperature: 0.5 }, /no temperature flag/],
    ['stop sequences', { stop: ['END'] }, /no stop-sequence flag/],
  ])('refuses %s', (_case, overrides, reason) => {
    expectRefusal(request(overrides), reason)
  })

  it('accepts the empty forms of the options it otherwise refuses', () => {
    // An empty list is the seam saying "none", not a request for a flag that
    // does not exist, so it must not be refused.
    expect(() => projectRequest(request({ tools: [], stop: [] }))).not.toThrow()
  })
})
