/**
 * Gate for provider-adapter contract coverage. Every package that implements
 * the `dsh-llm` adapter seam runs the shared contract suite, or carries an
 * explicit, justified exemption below.
 *
 * The suite is what holds the seam's cross-adapter promises — one terminal
 * chunk, release on abandonment, and a credential kept out of what callers
 * see. An adapter that does not run it keeps none of them, and the gap is
 * invisible: the package's own tests pass, and the suite reports only on the
 * adapters that opted in.
 */

import { globSync, readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'

const root = resolve(import.meta.dirname, '..')

/** How a package declares it serves the seam. */
const IMPLEMENTS_ADAPTER = /\bextends\s+LlmAdapter\b|\bimplements\s+LlmAdapter\b/

/** How a package declares it runs the shared suite. */
const RUNS_CONTRACT = /\btestLlmAdapterContract\b/

/**
 * Packages that implement the seam without owing the provider contract.
 * Reasons are reviewable policy: a new adapter cannot silently inherit one.
 */
export const ADAPTERS_WITHOUT_CONTRACT: Readonly<Record<string, string>> = {
  'packages/test-support/llm-replay': 'Keyless snapshot replay for tests; it reaches no provider and holds no credential, so the contract has nothing to measure.',
}

/** Result of auditing adapter contract coverage. */
export interface AdapterContractAudit {
  /** Packages found implementing the adapter seam. */
  readonly adapters: number
  /** Adapters running the shared contract suite. */
  readonly covered: number
  /** Adapters covered by an explicit no-contract policy. */
  readonly exempt: number
  /** Actionable contract violations. */
  readonly violations: readonly string[]
}

/** Normalize one filesystem glob result to repository slash form. */
function normalize(path: string): string {
  return path.split(sep).join('/')
}

/** The `packages/<group>/<name>` prefix one file belongs to. */
function packageOf(path: string): string {
  return path.split('/').slice(0, 3).join('/')
}

/**
 * Audit every seam implementation for shared-contract coverage.
 * @param scanRoot - repository root to scan; defaults to this repository.
 * @param exemptions - packages excused from the contract, with the reason;
 *   defaults to this repository's policy.
 * @returns the counts and every violation found.
 */
export function auditAdapterContracts(
  scanRoot: string = root,
  exemptions: Readonly<Record<string, string>> = ADAPTERS_WITHOUT_CONTRACT,
): AdapterContractAudit {
  const sources = globSync('packages/*/*/src/**/*.ts', { cwd: scanRoot }).map(normalize)
  const adapters = new Set<string>()
  for (const file of sources) {
    if (IMPLEMENTS_ADAPTER.test(readFileSync(resolve(scanRoot, file), 'utf8'))) adapters.add(packageOf(file))
  }

  const tests = globSync('packages/*/*/tests/**/*.ts', { cwd: scanRoot }).map(normalize)
  const covered = new Set<string>()
  for (const file of tests) {
    if (RUNS_CONTRACT.test(readFileSync(resolve(scanRoot, file), 'utf8'))) covered.add(packageOf(file))
  }

  const violations: string[] = []
  let running = 0
  let exempt = 0
  for (const adapter of [...adapters].sort()) {
    const reason = exemptions[adapter]
    if (covered.has(adapter)) {
      running += 1
      if (reason !== undefined) {
        violations.push(`${adapter}: runs the contract suite but remains exempt; remove the stale exemption`)
      }
      continue
    }
    if (reason !== undefined) {
      exempt += 1
      continue
    }
    violations.push(
      `${adapter}: implements LlmAdapter without running testLlmAdapterContract;`
      + ' add a contract spec or a justified ADAPTERS_WITHOUT_CONTRACT entry',
    )
  }

  for (const adapter of Object.keys(exemptions)) {
    if (!adapters.has(adapter)) {
      violations.push(`${adapter}: exempt from the adapter contract but implements no adapter; remove the entry`)
    }
  }

  return { adapters: adapters.size, covered: running, exempt, violations }
}

/** Run the repository audit as a standalone gate. */
function main(): void {
  const audit = auditAdapterContracts()
  if (audit.violations.length > 0) {
    console.error('verify-llm-adapter-contract: provider-adapter contract violations found:')
    for (const violation of audit.violations) console.error(`  ${violation}`)
    process.exit(1)
  }
  console.log(
    `verify-llm-adapter-contract: ${String(audit.adapters)} adapter(s) checked`
    + ` (${String(audit.covered)} running the contract, ${String(audit.exempt)} explicitly exempt), all conform.`,
  )
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) main()
