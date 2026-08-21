import { spawn } from 'node:child_process'

import { VelarosCliError, type VelarosCliNamespaceRunResult, type VelarosCliRunOptions } from './types.js'

const TermelCommandEnvironment = 'VELAROS_TERMEL_COMMAND'

/**
 * Launches the independently distributed Termel product without making the
 * Platform CLI own its runtime, UI, configuration, or credentials.
 */
export async function runTerminalCli(
  argv: string[],
  options: VelarosCliRunOptions,
): Promise<VelarosCliNamespaceRunResult> {
  const command = process.env[TermelCommandEnvironment]?.trim() || 'termel'
  return new Promise<VelarosCliNamespaceRunResult>((resolve, reject) => {
    const child = spawn(command, argv, {
      cwd: options.cwd,
      env: process.env,
      stdio: 'inherit',
    })
    child.once('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new VelarosCliError(
          'TERMEL_NOT_INSTALLED',
          'Termel is not installed. Install @velaros-ai/termel or run the termel command directly.',
          127,
          { command },
        ))
        return
      }
      reject(error)
    })
    child.once('exit', (code, signal) => resolve({
      exitCode: code ?? (signal ? 1 : 0),
      text: '',
    }))
  })
}
