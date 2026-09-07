/** Regression coverage for provider-adapter contract enforcement. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { auditAdapterContracts } from './verify-llm-adapter-contract.ts'

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-adapter-contract-'))
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true })
  })
  return root
}

function write(root: string, path: string, source: string): void {
  const absolute = join(root, path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, source)
}

/** One package implementing the seam, with the contract spec it may or may not have. */
function adapter(root: string, name: string, runsContract: boolean): void {
  write(root, `packages/llm/${name}/src/adapter.ts`, 'export class X extends LlmAdapter {}\n')
  if (runsContract) {
    write(root, `packages/llm/${name}/tests/contract.spec.ts`, 'testLlmAdapterContract({ harness })\n')
  }
}

describe('provider-adapter contract coverage', () => {
  it('accepts an adapter that runs the shared suite', () => {
    const root = fixture()
    adapter(root, 'llm-covered', true)

    expect(auditAdapterContracts(root, {})).toMatchObject({ adapters: 1, covered: 1, violations: [] })
  })

  it('rejects an adapter that implements the seam without running it', () => {
    const root = fixture()
    adapter(root, 'llm-bare', false)

    const audit = auditAdapterContracts(root, {})

    expect(audit.violations).toEqual([
      'packages/llm/llm-bare: implements LlmAdapter without running testLlmAdapterContract;'
      + ' add a contract spec or a justified ADAPTERS_WITHOUT_CONTRACT entry',
    ])
  })

  it('rejects an exemption an adapter has outgrown', () => {
    // A package that started keyless and later reached a provider must lose
    // its exemption rather than keep one nothing re-examines.
    const root = fixture()
    adapter(root, 'llm-outgrown', true)
    const exemptions = { 'packages/llm/llm-outgrown': 'keyless once' }

    expect(auditAdapterContracts(root, exemptions).violations)
      .toEqual(['packages/llm/llm-outgrown: runs the contract suite but remains exempt; remove the stale exemption'])
  })

  it('rejects an exemption for a package that implements no adapter', () => {
    const root = fixture()
    const exemptions = { 'packages/llm/llm-gone': 'removed in a refactor' }

    expect(auditAdapterContracts(root, exemptions).violations)
      .toEqual(['packages/llm/llm-gone: exempt from the adapter contract but implements no adapter; remove the entry'])
  })

  it('counts an exempt adapter without demanding a contract', () => {
    const root = fixture()
    adapter(root, 'llm-keyless', false)
    const exemptions = { 'packages/llm/llm-keyless': 'reaches no provider' }

    expect(auditAdapterContracts(root, exemptions))
      .toMatchObject({ adapters: 1, covered: 0, exempt: 1, violations: [] })
  })
})
