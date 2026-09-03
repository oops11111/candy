/**
 * The lifecycle and secret-handling contract every `dsh-llm` adapter owes its
 * callers, as a suite an adapter's own test file runs against itself.
 *
 * `dsh-llm/invariant` already enforces the chunk grammar — block pairing, one
 * usage, one terminal finish, nothing after it — around every registered
 * provider stream. This suite covers what that validator cannot see: whether a
 * cancelled run settles, whether an abandoned run releases what it started,
 * and whether the credential an adapter holds can reach a caller through the
 * chunks, errors, or diagnostics it produces.
 *
 * The suite assumes nothing about transport. An adapter is described by what
 * it can be asked to do — run normally, be cancelled, fail, be abandoned — and
 * each scenario is supplied by the adapter's own test file, which alone knows
 * how to script its provider.
 *
 * Every stream a subject supplies MUST come from `LlmRuntime.stream()`, not
 * from the adapter's own `stream()`. That is deliberate and load-bearing: the
 * guarantee of exactly one terminal chunk belongs to the runtime, which
 * normalizes an adapter throw into a terminal `error` or `aborted` finish. An
 * adapter is free to throw instead of yielding a finish — `dsh-llm-deepseek`
 * does — so a suite run against a raw adapter would fail conforming adapters
 * and test a contract no caller relies on.
 *
 * @module @deepseek-ai/dsh-llm-adapter-contract
 */

import type { StreamChunk } from '@deepseek-ai/dsh-llm'

/** One run a consumer stops reading part-way through. */
export interface LlmAdapterOpenRun {
  /** The adapter's chunk stream, which does not end on its own. */
  readonly chunks: AsyncIterable<StreamChunk>
  /**
   * Whether the adapter has released what this run started — the process it
   * spawned, the connection it opened.
   */
  readonly released: () => boolean
}

/** One adapter under test, described by the runs its own test file can script. */
export interface LlmAdapterContractSubject {
  /** Name used in the generated test titles. */
  readonly name: string
  /**
   * The secret this adapter holds, verbatim.
   *
   * Every chunk, error message, and nested error property the adapter produces
   * is searched for it. Supply the exact value the adapter was constructed
   * with, never a placeholder: a suite given the wrong string proves nothing.
   */
  readonly secret: string
  /**
   * Start one ordinary run that produces content and finishes normally.
   * @param signal - cancellation the run must honor when the suite supplies one.
   * @returns the stream from `LlmRuntime.stream()`, as a caller receives it.
   */
  readonly run: (signal?: AbortSignal) => AsyncIterable<StreamChunk>
  /**
   * Start one run whose provider fails after the adapter committed to it — a
   * rejected credential, an exhausted quota, a crash.
   * @returns the stream from `LlmRuntime.stream()` for the failing run.
   */
  readonly failingRun: () => AsyncIterable<StreamChunk>
  /**
   * Start one run whose provider produces output and then stops without
   * finishing, standing in for a process or connection still open.
   * @returns the stream from `LlmRuntime.stream()`, and a way to observe
   *   whether the run's resources were released. The observation is polled,
   *   so it may report the release on a later tick — closing a socket does.
   */
  readonly openRun: () => LlmAdapterOpenRun
}

/** One assertion the suite makes; satisfied by vitest's `expect` return value. */
export interface LlmAdapterContractAssertion {
  toBe: (expected: unknown) => void
  toBeGreaterThan: (expected: number) => void
}

/** The test entry points this suite needs, passed in by the caller's spec file. */
export interface LlmAdapterContractHarness {
  describe: (name: string, body: () => void) => void
  it: (name: string, body: () => Promise<void> | void) => void
  expect: (value: unknown) => LlmAdapterContractAssertion
}

/**
 * How long the suite waits for an abandoned run's resources to be released.
 *
 * Release is not always synchronous: terminating a process is, but closing a
 * socket completes on a later tick, so a suite that asserted immediately would
 * fail a conforming adapter. Polling keeps a prompt release fast and still
 * fails — rather than hangs — when release never comes.
 */
const RELEASE_DEADLINE_MS = 2_000
const RELEASE_POLL_MS = 5

/** Wait until `observed` reports true, or the deadline passes. */
async function awaitRelease(observed: () => boolean): Promise<boolean> {
  const deadline = Date.now() + RELEASE_DEADLINE_MS
  while (!observed()) {
    if (Date.now() >= deadline) return false
    await new Promise(resolve => setTimeout(resolve, RELEASE_POLL_MS))
  }
  return true
}

/** Read one stream to its end. */
async function drain(chunks: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const collected: StreamChunk[] = []
  for await (const chunk of chunks) collected.push(chunk)
  return collected
}

/**
 * Flatten one value into every piece of text a caller could read off it.
 *
 * Errors carry their message, name, stack and cause; objects and arrays are
 * walked. A leak hides in whichever of those an adapter did not think about,
 * so the search covers all of them rather than the message alone.
 * @param value - anything the adapter produced or threw.
 * @param seen - cycle guard for the walk.
 * @returns every reachable string, joined.
 */
function searchableText(value: unknown, seen = new Set<unknown>()): string {
  if (typeof value === 'string') return value
  if (typeof value !== 'object' || value === null || seen.has(value)) return ''
  seen.add(value)
  const parts: string[] = []
  if (value instanceof Error) {
    parts.push(value.message, value.name, value.stack ?? '', searchableText(value.cause, seen))
  }
  for (const entry of Object.values(value)) parts.push(searchableText(entry, seen))
  return parts.join(' ')
}

/**
 * Run the adapter lifecycle and secret-handling contract against one adapter.
 *
 * Call it from the adapter package's own spec file, passing that file's
 * `describe`, `it`, and `expect` so the generated cases report as its tests.
 * @param subject - the adapter under test and the runs its spec file scripts.
 * @param harness - the caller's test entry points.
 */
export function testLlmAdapterContract(
  subject: LlmAdapterContractSubject,
  harness: LlmAdapterContractHarness,
): void {
  const { describe, it, expect } = harness

  describe(`${subject.name} honors the adapter lifecycle contract`, () => {
    it('finishes a normal run with exactly one terminal chunk', async () => {
      const chunks = await drain(subject.run())

      expect(chunks.filter(chunk => chunk.type === 'finish').length).toBe(1)
      expect(chunks.at(-1)?.type).toBe('finish')
    })

    it('finishes a failing run rather than ending the stream bare', async () => {
      // A stream that merely stops leaves the caller unable to tell a refusal
      // from an empty answer, so a failure is still a terminal chunk.
      const chunks = await drain(subject.failingRun())

      expect(chunks.at(-1)?.type).toBe('finish')
    })

    it('settles a run cancelled before it starts', async () => {
      const controller = new AbortController()
      controller.abort()

      const chunks = await drain(subject.run(controller.signal))

      expect(chunks.at(-1)?.type).toBe('finish')
    })

    it('settles a run cancelled while it streams', async () => {
      const controller = new AbortController()
      const collected: StreamChunk[] = []

      for await (const chunk of subject.run(controller.signal)) {
        collected.push(chunk)
        controller.abort()
      }

      expect(collected.at(-1)?.type).toBe('finish')
    })

    it('releases the run a consumer stops reading', async () => {
      // Breaking out of the loop closes the adapter's generator part-way
      // through. Whatever it started — a process, a connection — is live at
      // that moment, and nothing else will reap it.
      const open = subject.openRun()

      for await (const _chunk of open.chunks) break

      expect(await awaitRelease(open.released)).toBe(true)
    })
  })

  describe(`${subject.name} keeps its credential out of what callers see`, () => {
    it('emits no chunk carrying the secret', async () => {
      const chunks = await drain(subject.run())

      expect(chunks.length).toBeGreaterThan(0)
      expect(searchableText(chunks).includes(subject.secret)).toBe(false)
    })

    it('reports a failure without the secret in it', async () => {
      // A failure is where a leak is likeliest: provider errors quote the
      // request, and the request carried the credential.
      const chunks = await drain(subject.failingRun())

      expect(searchableText(chunks).includes(subject.secret)).toBe(false)
    })

    it('throws no error carrying the secret', async () => {
      let thrown: unknown
      try {
        await drain(subject.failingRun())
      } catch (error) {
        thrown = error
      }

      expect(searchableText(thrown).includes(subject.secret)).toBe(false)
    })
  })
}
