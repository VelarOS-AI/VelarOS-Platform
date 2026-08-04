import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { expect, test } from 'bun:test'

const CoreRoot = resolve(import.meta.dir, '..')

test('a closed console pipe cannot crash the logging runtime', async () => {
  const runtimeUrl = pathToFileURL(resolve(CoreRoot, 'src/logger/runtime.ts')).href
  const script = `
    import { LogRuntime } from ${JSON.stringify(runtimeUrl)}
    const runtime = new LogRuntime({ consoleEnabled: true, level: 'debug' })
    const logger = runtime.tag('closed-pipe')
    logger.info('ready')
    const timer = setInterval(() => logger.info('payload', 'x'.repeat(65536)), 1)
    setTimeout(() => {
      clearInterval(timer)
      process.exit(0)
    }, 250)
  `
  const child = spawn(process.execPath, ['--eval', script], {
    cwd: CoreRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await new Promise<void>((done, reject) => {
    child.stdout.once('data', () => {
      child.stdout.destroy()
      child.stderr.destroy()
      done()
    })
    child.once('error', reject)
  })
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (done) => child.once('close', (code, signal) => done({ code, signal }))
  )
  expect(exit).toEqual({ code: 0, signal: null })
})
