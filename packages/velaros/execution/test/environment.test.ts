import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, spyOn, test } from 'bun:test'

import { ShellEnvironment } from '../impl/local/ShellEnvironment'
import { shellProcessManager } from '../impl/local/ShellProcessManager'
import type { ShellResolverApi } from '../impl/local/ShellResolver'
import { createShellEnvironment } from '../local'
import type { ResolvedShell } from '../types/local'
import { parseLoginEnvironment } from '../utils/environment'
import { isRegularFile } from '../utils/shells'

/** 用显式环境形成固定的已自检描述，供代次与关闭测试。 */
function resolved(env: NodeJS.ProcessEnv): ResolvedShell {
  return {
    env,
    shellPath: 'shell',
    kind: 'cmd',
    name: 'CMD',
    readiness: 'ready',
    version: '1',
    recommendation: null,
  }
}

/** Windows 读取入口可以受控兑现，其他行为只返回同一份环境。 */
function resolver(load: ShellResolverApi['refreshWindowsEnvironment']): ShellResolverApi {
  return {
    refreshWindowsEnvironment: load,
    resolve: (options) => resolved(options?.env ?? {}),
    resolveReady: async (options) => resolved(options?.env ?? {}),
    resolveCommand: async (name) => ({ name, available: false, path: null, kind: null }),
    inspectPath: async () => [],
  }
}

test('login output isolates startup noise and preserves multiline and equals-sign values', () => {
  const result = parseLoginEnvironment(
    'banner=ignored\n\0marker\0PATH=/tools\0VALUE=a=b\nc\0__proto__=value\0',
    'marker'
  )
  expect(result).toEqual({ PATH: '/tools', VALUE: 'a=b\nc', ['__proto__']: 'value' })
  expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
  expect(() => parseLoginEnvironment('PATH=/tools\0', 'marker')).toThrow('不完整')
  expect(() => parseLoginEnvironment('\0marker\0PATH=/tools', 'marker')).toThrow('不完整')
})

test('shell candidate probes distinguish files, directories and expected missing paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'velaros-shell-probe-'))
  try {
    const executable = join(directory, 'candidate')
    await writeFile(executable, 'test')
    expect(isRegularFile(executable)).toBe(true)
    expect(isRegularFile(directory)).toBe(false)
    expect(isRegularFile(join(directory, 'missing'))).toBe(false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('concurrent reads share a load, return copies, and refresh isolates listener failures', async () => {
  let loads = 0
  let source = '/first'
  const environment = new ShellEnvironment(
    { platform: 'win32', env: () => ({ VELAROS_SHELL_PATH: 'configured' }) },
    resolver(async () => {
      loads++
      return { env: { PATH: source }, revision: source, refreshed: true }
    })
  )
  try {
    const [first, second] = await Promise.all([
      environment.getEnvironment(),
      environment.getEnvironment(),
    ])
    expect(loads).toBe(1)
    first.PATH = 'changed by caller'
    expect(second.PATH).toBe('/first')
    expect(second.VELAROS_SHELL_PATH).toBe('configured')
    let notified = 0
    environment.subscribe(() => {
      throw new Error('subscriber failed')
    })
    const unsubscribe = environment.subscribe(() => {
      notified++
    })
    source = '/second'
    await environment.refresh()
    expect(loads).toBe(2)
    expect(notified).toBe(1)
    expect((await environment.resolveShell()).env.PATH).toBe('/second')
    unsubscribe()
    await environment.refresh()
    expect(notified).toBe(1)
  } finally {
    await environment.dispose()
  }
})

test('default path uses the ready shell until refresh while explicit environments resolve independently', async () => {
  let source = 'first'
  const shells = resolver(async () => ({
    env: { PATH: source },
    revision: source,
    refreshed: true,
  }))
  shells.resolveReady = async (options) => ({
    ...resolved(options?.env ?? {}),
    shellPath: `ready-${options?.env?.PATH}`,
  })
  const resolve = spyOn(shells, 'resolve')
  const environment = new ShellEnvironment({ platform: 'win32' }, shells)
  try {
    await environment.getEnvironment()
    expect(environment.getShellPath()).toBe('ready-first')
    expect(environment.getShellPath()).toBe('ready-first')
    expect(resolve).not.toHaveBeenCalled()
    expect(environment.getShellPath({ PATH: 'explicit' })).toBe('shell')
    expect(resolve).toHaveBeenCalledTimes(1)
    source = 'second'
    await environment.refresh()
    expect(environment.getShellPath()).toBe('ready-second')
    expect(resolve).toHaveBeenCalledTimes(1)
  } finally {
    resolve.mockRestore()
    await environment.dispose()
  }
  expect(() => environment.getShellPath()).toThrow()
})

test('older refreshes cannot overwrite newer environments or publish stale notifications', async () => {
  const resolveLoads: Array<(env: NodeJS.ProcessEnv) => void> = []
  const environment = new ShellEnvironment(
    { platform: 'win32' },
    resolver(
      () =>
        new Promise((resolve) => {
          resolveLoads.push((env) => resolve({ env, revision: env.PATH!, refreshed: true }))
        })
    )
  )
  const revisions: number[] = []
  environment.subscribe(() => revisions.push(environment.getRevision()))
  const old = environment.refresh()
  const current = environment.refresh()
  resolveLoads[1]({ PATH: '/new' })
  await current
  resolveLoads[0]({ PATH: '/old' })
  await old
  try {
    expect((await environment.getEnvironment()).PATH).toBe('/new')
    expect((await environment.resolveShell()).env.PATH).toBe('/new')
    expect(revisions).toEqual([2])
  } finally {
    await environment.dispose()
  }
})

test('a listener starting another refresh stops notification of the superseded generation', async () => {
  const environment = new ShellEnvironment(
    { platform: 'win32' },
    resolver(async () => ({ env: {}, revision: '', refreshed: true }))
  )
  let next: Promise<NodeJS.ProcessEnv> | undefined
  const notifications: number[] = []
  const unsubscribe = environment.subscribe(() => {
    unsubscribe()
    next = environment.refresh()
  })
  environment.subscribe(() => {
    notifications.push(environment.getRevision())
  })
  try {
    await environment.refresh()
    await next
    expect(notifications).toEqual([2])
  } finally {
    await environment.dispose()
  }
})

test('dispose cancels active loading, drains all generations, and closes future admission', async () => {
  let stopped = 0
  const environment = new ShellEnvironment(
    { platform: 'win32' },
    resolver(
      (_env, _platform, signal) =>
        new Promise((_resolve, reject) => {
          signal!.addEventListener(
            'abort',
            () => {
              stopped++
              reject(signal!.reason)
            },
            { once: true }
          )
        })
    )
  )
  const pending = Promise.allSettled([environment.refresh(), environment.refresh()])
  const closing = environment.dispose()
  expect(environment.dispose()).toBe(closing)
  await closing
  expect(stopped).toBe(2)
  expect((await pending).map((item) => item.status)).toEqual(['rejected', 'rejected'])
  await expect(environment.getEnvironment()).rejects.toHaveProperty('name', 'AbortError')
  expect(() => environment.subscribe(() => {})).toThrow()
})

test('one caller can cancel its wait while another receives the shared environment', async () => {
  let complete!: () => void
  let loads = 0
  const environment = new ShellEnvironment(
    { platform: 'win32' },
    resolver(
      () =>
        new Promise((resolve) => {
          loads++
          complete = () => resolve({ env: { PATH: '/shared' }, revision: '', refreshed: true })
        })
    )
  )
  const controller = new AbortController()
  const cancelled = environment.getEnvironment(controller.signal)
  const retained = environment.getEnvironment()
  const result = Promise.allSettled([cancelled])
  controller.abort()
  try {
    expect(await result).toEqual([{ status: 'rejected', reason: controller.signal.reason }])
    expect(loads).toBe(1)
    complete()
    expect((await retained).PATH).toBe('/shared')
  } finally {
    complete()
    await environment.dispose()
  }
})

test.skipIf(process.platform === 'win32')(
  'timed-out capture reaps its process before a fallback environment is returned',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'shell-environment-timeout-'))
    const script = join(directory, 'shell')
    await writeFile(script, '#!/usr/bin/env node\nsetInterval(() => {}, 1000)\n')
    await chmod(script, 0o700)
    let pid: number | undefined
    const manage = shellProcessManager.manage.bind(shellProcessManager)
    const observer = spyOn(shellProcessManager, 'manage').mockImplementation((child, options) => {
      pid ??= child.pid
      return manage(child, options)
    })
    const environment = createShellEnvironment({
      env: () => ({ ...process.env, SHELL: script }),
      captureTimeoutMs: 100,
    })
    try {
      await environment.getEnvironment()
      expect(pid).toBeGreaterThan(0)
      expect(() => process.kill(pid!, 0)).toThrow()
    } finally {
      observer.mockRestore()
      await environment.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  },
  5000
)

test.each([undefined, 'configured'])(
  'Windows shell self-check does not pin shared environment; explicit selection=%s',
  async (selected) => {
    const host = { Path: 'C:\\tools', ...(selected ? { VELAROS_SHELL_PATH: selected } : {}) }
    const base = resolver(async () => ({
      env: { Path: 'C:\\refreshed' },
      revision: 'new',
      refreshed: true,
    }))
    const environment = new ShellEnvironment(
      { platform: 'win32', env: () => host },
      {
        ...base,
        resolveReady: async (options) =>
          resolved({
            ...options?.env,
            VELAROS_SHELL_PATH: 'auto-selected',
            VELAROS_SHELL_READY: '1',
          }),
      }
    )
    try {
      for (let i = 0; i < 2; i++) {
        const snapshot = i ? await environment.refresh() : await environment.getEnvironment()
        expect(snapshot.Path).toBe('C:\\refreshed')
        expect(snapshot.VELAROS_SHELL_PATH).toBe(selected)
        expect(snapshot.VELAROS_SHELL_READY).toBeUndefined()
        expect((await environment.resolveShell()).env.VELAROS_SHELL_PATH).toBe('auto-selected')
      }
      expect(host.Path).toBe('C:\\tools')
    } finally {
      await environment.dispose()
    }
  }
)
