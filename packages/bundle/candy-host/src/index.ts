/** Execute one Candy Host device-management operation and exit. */

import type { Context } from '@deepseek-ai/cordis'
import { DeviceBindingError, DevicePairingError, type HostDeviceBindingView } from '@deepseek-ai/dsh-device-binding'
import type {} from '@deepseek-ai/dsh-cmdline'
import { CANDY_HOST_STARTUP_SERVICE, type CandyHostStartupValues } from './startup.ts'

export const name = 'candy-host-command'
export const inject = ['deviceBinding', CANDY_HOST_STARTUP_SERVICE]

interface Io {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
  exit(code: number): void
}

/** Replaceable process streams used by deterministic command tests. */
export const internals: Pick<Io, 'stdout' | 'stderr'> = {
  stdout: process.stdout,
  stderr: process.stderr,
}

function render(view: HostDeviceBindingView): string {
  return `paired ${view.serverOrigin} as user ${view.userId}, device ${view.deviceId}\n`
}

async function execute(ctx: Context, operation: CandyHostStartupValues, io: Io): Promise<void> {
  switch (operation.operation) {
    case 'pair': {
      const paired = await ctx.deviceBinding.pair(operation.serverOrigin, operation.code, Date.now())
      io.stdout.write(render({
        serverOrigin: paired.serverOrigin,
        userId: paired.userId,
        deviceId: paired.deviceId,
        boundAt: paired.boundAt,
      }))
      return
    }
    case 'status': {
      const binding = await ctx.deviceBinding.describe()
      io.stdout.write(binding === undefined ? 'unpaired\n' : render(binding))
      return
    }
    case 'release':
      await ctx.deviceBinding.release()
      io.stdout.write('released\n')
      return
  }
}

function failure(operation: CandyHostStartupValues['operation'], error: unknown): string {
  if (error instanceof DeviceBindingError || error instanceof DevicePairingError) {
    return `${operation} failed (${error.code})\n`
  }
  // Network libraries often include request URLs and bodies in errors. The
  // one-time code must not become terminal history, so unexpected failures are
  // intentionally classified rather than stringified.
  return `${operation} failed\n`
}

export function apply(ctx: Context): void {
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('candy-host-command: the launcher must provide ctx.appExit before the tree mounts')
  const operation = ctx.get(CANDY_HOST_STARTUP_SERVICE) as CandyHostStartupValues | undefined
  if (operation === undefined) throw new Error('candy-host-command: the startup operation must be injected')
  const io: Io = { ...internals, exit }
  void execute(ctx, operation, io).then(
    () => { io.exit(0) },
    (error: unknown) => { io.stderr.write(failure(operation.operation, error)); io.exit(1) },
  )
}
