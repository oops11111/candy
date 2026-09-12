/** Parse the one-shot Candy Host device-management command. */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

export const name = 'candy-host-startup'
export const inject = ['cmdlineArgs']
/** Cordis service name carrying the parsed one-shot Host operation. */
export const CANDY_HOST_STARTUP_SERVICE = 'candyHostStartup'

/** A validated one-shot operation selected by the Candy Host command line. */
export type CandyHostStartupValues =
  | { readonly operation: 'pair'; readonly serverOrigin: string; readonly code: string }
  | { readonly operation: 'status' }
  | { readonly operation: 'release' }

interface PairOptions {
  server?: string
  code?: string
}

function command(): Command {
  const program = new Command()
    .name('dsh --profile candy-host')
    .description('Manage this Windows Harness Host binding to a Candy deployment.')
    .helpOption('-h, --help', 'show this help')

  program.command('pair')
    .description('exchange a one-time code and bind this host')
    .option('--server <https-origin>', 'Candy deployment origin')
    .option('--code <pairing-code>', 'one-time code shown in Candy')
    .action((_options: PairOptions, invoked: Command) => {
      const options = invoked.opts<PairOptions>()
      // Do not use commander's requiredOption: its diagnostic repeats the
      // complete option token, which would echo a one-time code in adjacent
      // argv on some wrappers. These fixed messages carry no submitted value.
      if (options.server === undefined) invoked.error('error: --server is required')
      if (options.code === undefined) invoked.error('error: --code is required')
      program.setOptionValue('resolved', {
        operation: 'pair', serverOrigin: options.server, code: options.code,
      } satisfies CandyHostStartupValues)
    })

  program.command('status')
    .description('show the non-secret binding identity')
    .action(() => { program.setOptionValue('resolved', { operation: 'status' } satisfies CandyHostStartupValues) })

  program.command('release')
    .description('remove this host binding; pairing is required before it can serve again')
    .action(() => { program.setOptionValue('resolved', { operation: 'release' } satisfies CandyHostStartupValues) })

  program.action(() => { program.error('error: choose pair, status, or release') })
  return program
}

export function apply(ctx: Context): void {
  const program = command()
  parseCmdline(ctx, program)
  const resolved = program.getOptionValue('resolved') as CandyHostStartupValues | undefined
  if (resolved !== undefined) ctx.provide(CANDY_HOST_STARTUP_SERVICE, resolved)
}
