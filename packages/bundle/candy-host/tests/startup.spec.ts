/** The Candy Host management command: parsing must never expose the pairing code. */

import { Context } from '@deepseek-ai/cordis'
import { internals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, CANDY_HOST_STARTUP_SERVICE, type CandyHostStartupValues } from '../src/startup.ts'

afterEach(() => {
  internals.stdout = process.stdout
  internals.stderr = process.stderr
})

function parse(args: string[]): { value: CandyHostStartupValues | undefined; output: string; exits: number[] } {
  const ctx = new Context()
  let output = ''
  const exits: number[] = []
  const sink = { write: (chunk: string): boolean => { output += chunk; return true } }
  internals.stdout = sink
  internals.stderr = sink
  provideCmdline(ctx, { args, exit: code => void exits.push(code) })
  apply(ctx)
  return {
    value: ctx.get(CANDY_HOST_STARTUP_SERVICE) as CandyHostStartupValues | undefined,
    output,
    exits,
  }
}

describe('Candy Host command line', () => {
  it('publishes a pair request without printing its one-time code', () => {
    const result = parse(['pair', '--server', 'https://candy.example', '--code', 'ABCD-EFGH'])

    expect(result.value).toEqual({
      operation: 'pair',
      serverOrigin: 'https://candy.example',
      code: 'ABCD-EFGH',
    })
    expect(result.output).not.toContain('ABCD-EFGH')
    expect(result.exits).toEqual([])
  })

  it.each([
    ['status', { operation: 'status' }],
    ['release', { operation: 'release' }],
  ] as const)('publishes the %s operation', (command, expected) => {
    expect(parse([command]).value).toEqual(expected)
  })

  it('rejects an incomplete pair request without echoing the supplied code', () => {
    const result = parse(['pair', '--code', 'ABCD-EFGH'])

    expect(result.value).toBeUndefined()
    expect(result.output).not.toContain('ABCD-EFGH')
    expect(result.exits).toEqual([1])
  })

  it('rejects a pair request without a code', () => {
    const result = parse(['pair', '--server', 'https://candy.example'])

    expect(result.value).toBeUndefined()
    expect(result.output).toContain('--code is required')
    expect(result.exits).toEqual([1])
  })

  it('rejects an invocation without an operation', () => {
    const result = parse([])

    expect(result.value).toBeUndefined()
    expect(result.output).toContain('choose pair, status, or release')
    expect(result.exits).toEqual([1])
  })

  it('prints profile-specific help without publishing an operation', () => {
    const result = parse(['--help'])

    expect(result.output).toContain('dsh --profile candy-host')
    expect(result.value).toBeUndefined()
    expect(result.exits).toEqual([0])
  })
})
