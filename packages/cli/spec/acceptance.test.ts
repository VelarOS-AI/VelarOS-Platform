/**
 * `velaros` 命令行的验收测试：每一条对应 spec/invariants.md 里的一个编号。
 * 库面只经根入口（源码）验，装出来的命令壳经 `bin/velaros.mjs` 与 `dist/` 验——那是用户真正跑的那条路径。
 */

import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'bun:test'

import {
  createVelarosCliRouter,
  velarosCli,
  VelarosCliEnvelope,
  type VelarosCliErrorEnvelope,
  VelarosCliExitCodes,
  type VelarosCliSuccessEnvelope,
} from '../src/exports/index'

const packageRoot = new URL('../', import.meta.url)
const binaryPath = fileURLToPath(new URL('bin/velaros.mjs', packageRoot))
const builtEntryUrl = new URL('dist/exports/index.js', packageRoot).href

/** 把 `--json` 的文本读成成功信封。 */
function readSuccess(text: string): VelarosCliSuccessEnvelope {
  return JSON.parse(text) as VelarosCliSuccessEnvelope
}

/** 把 `--json` 的文本读成失败信封。 */
function readError(text: string): VelarosCliErrorEnvelope {
  return JSON.parse(text) as VelarosCliErrorEnvelope
}

describe('路由与失败语义', () => {
  test('INV-1 未知的命名空间收成失败信封，退出码 2，不向宿主抛', async () => {
    const result = await velarosCli.run(['quality', 'select', '--json'])

    expect(result.exitCode).toBe(VelarosCliExitCodes.usage)
    const envelope = readError(result.text)
    expect(envelope.status).toBe('error')
    expect(envelope.error.code).toBe('UNKNOWN_NAMESPACE')
    expect(envelope.error.details.namespace).toBe('quality')
  })

  test('INV-1 命名空间抛出的异常收成 EXECUTION_ERROR，退出码 1', async () => {
    const router = createVelarosCliRouter({
      namespaces: {
        acme: () => {
          throw new Error('部署脚本炸了')
        },
      },
    })

    const result = await router.run(['acme', 'deploy', '--json'])

    expect(result.exitCode).toBe(VelarosCliExitCodes.failure)
    const envelope = readError(result.text)
    expect(envelope.error.code).toBe('EXECUTION_ERROR')
    expect(envelope.error.message).toContain('部署脚本炸了')
  })

  test('INV-1 已删除的 agent 命名空间和产品命名空间一样，都只是未注册', async () => {
    const result = await velarosCli.run(['agent', 'status', '--json'])

    expect(result.exitCode).toBe(VelarosCliExitCodes.usage)
    expect(readError(result.text).error.code).toBe('UNKNOWN_NAMESPACE')
  })
})

describe('命名空间集合', () => {
  test('INV-2 默认实例只带内置的 terminal，集合按字典序且构造后冻结', async () => {
    expect(velarosCli.listNamespaces()).toEqual(['terminal'])
    expect(Object.isFrozen(velarosCli.listNamespaces())).toBe(true)

    const help = await velarosCli.run(['help', '--json'])
    expect(readSuccess(help.text).result).toEqual({ namespaces: ['terminal'] })
  })

  test('INV-2 产品注册的命名空间与内置的并存，参数去掉第一段后原样交过去', async () => {
    const calls: Array<{ argv: readonly string[], cwd: Optional<string> }> = []
    const router = createVelarosCliRouter({
      namespaces: {
        browser: (argv, options) => {
          calls.push({ argv, cwd: options.cwd })
          return { exitCode: VelarosCliExitCodes.ok, text: '浏览器就绪\n' }
        },
      },
    })

    const result = await router.run(['browser', 'open', 'https://example.com'], {
      cwd: '/tmp/project',
    })

    expect(result.exitCode).toBe(VelarosCliExitCodes.ok)
    expect(result.text).toBe('浏览器就绪\n')
    expect(calls).toEqual([{ argv: ['open', 'https://example.com'], cwd: '/tmp/project' }])
    expect(router.listNamespaces()).toEqual(['browser', 'terminal'])
  })

  test('INV-2 内置集可以整组关掉，组出一个只有产品命令的最小命令行', async () => {
    let clock = 100
    const router = createVelarosCliRouter({
      includeBuiltinNamespaces: false,
      now: () => clock++,
      resolveDefaultCwd: () => '/embedded/application',
      namespaces: {
        custom: () => ({ exitCode: VelarosCliExitCodes.ok, text: '自定义命令就绪\n' }),
      },
    })

    expect(router.listNamespaces()).toEqual(['custom'])
    const envelope = readSuccess((await router.run(['help', '--json'])).text)
    expect(envelope.result).toEqual({ namespaces: ['custom'] })
    expect(envelope.cwd).toBe('/embedded/application')
    expect(envelope.durationMs).toBe(1)
  })
})

describe('输出信封', () => {
  test('INV-3 成功信封的 kind 是 velaros.cli.<命名空间>.<子命令>，版本取自常量表', async () => {
    const help = await velarosCli.run(['help', '--json'])
    const envelope = readSuccess(help.text)

    expect(envelope.schemaVersion).toBe(VelarosCliEnvelope.schemaVersion)
    expect(envelope.kind).toBe('velaros.cli.root.help')
    expect(envelope.status).toBe('ok')
    expect(envelope.namespace).toBe('root')
    expect(envelope.command).toBe('help')
  })

  test('INV-3 失败信封的 kind 恒为 velaros.cli.error，不带 --json 时给「错误码: 说明」一行', async () => {
    const jsonResult = await velarosCli.run(['not-a-namespace', '--json'])
    expect(readError(jsonResult.text).kind).toBe(VelarosCliEnvelope.errorKind)

    const textResult = await velarosCli.run(['not-a-namespace'])
    expect(textResult.text.startsWith('UNKNOWN_NAMESPACE: ')).toBe(true)
    expect(textResult.text.endsWith('\n')).toBe(true)
  })

  test('INV-4 帮助与报错都是中文，命令名与错误码原样夹在里面', async () => {
    const help = await velarosCli.run([])
    expect(help.text).toContain('VelarOS 命令行')
    expect(help.text).toContain('用法：')
    expect(help.text).toContain('  terminal ...')

    const failure = await velarosCli.run(['quality'])
    expect(failure.text).toContain('未知的命名空间：quality')
    expect(failure.text).toContain('UNKNOWN_NAMESPACE')
  })
})

describe('terminal 命名空间', () => {
  test('INV-5 命令名取 VELAROS_TERMEL_COMMAND，命名空间之后的参数原样按序转交', async () => {
    const result = await velarosCli.run(['terminal', '-e', 'process.exit(Number(process.argv[1]))', '7'], {
      environment: { VELAROS_TERMEL_COMMAND: process.execPath },
    })

    expect(result.text).toBe('')
    expect(result.exitCode).toBe(7)
  })

  test('INV-5 找不到 Termel 时给 TERMEL_NOT_INSTALLED，退出码 127', async () => {
    const result = await velarosCli.run(['terminal', '--json'], {
      environment: { VELAROS_TERMEL_COMMAND: 'velaros-termel-这个命令不存在' },
    })

    expect(result.exitCode).toBe(VelarosCliExitCodes.commandNotFound)
    const envelope = readError(result.text)
    expect(envelope.error.code).toBe('TERMEL_NOT_INSTALLED')
    expect(envelope.error.message).toContain('VELAROS_TERMEL_COMMAND')
  })

  test('INV-6 子进程的退出码原样透出，本包不改写', async () => {
    const result = await velarosCli.run(['terminal', '-e', 'process.exit(3)'], {
      environment: { VELAROS_TERMEL_COMMAND: process.execPath },
    })

    expect(result.exitCode).toBe(3)
  })

  test('INV-6 子进程被信号杀死时报 128 加信号号', async () => {
    const result = await velarosCli.run(
      ['terminal', '-e', "process.kill(process.pid, 'SIGTERM')"],
      { environment: { VELAROS_TERMEL_COMMAND: process.execPath } },
    )

    expect(result.exitCode).toBe(VelarosCliExitCodes.signalBase + 15)
  })
})

describe('可执行入口', () => {
  test('INV-8 import 根入口不产生任何输出，src 下没有副作用', () => {
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', `import ${JSON.stringify(builtEntryUrl)}`],
      { encoding: 'utf8' },
    )

    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
  })

  test('INV-9 包根的 bin/velaros.mjs 可直接执行，velaros help 给中文帮助与退出码 0', () => {
    if (process.platform !== 'win32') {
      expect(statSync(binaryPath).mode & 0o111).not.toBe(0)
    }

    const result = process.platform === 'win32'
      ? spawnSync(process.execPath, [binaryPath, 'help'], { encoding: 'utf8' })
      : spawnSync(binaryPath, ['help'], { encoding: 'utf8' })

    expect(result.status).toBe(VelarosCliExitCodes.ok)
    expect(result.stdout).toContain('VelarOS 命令行')
    expect(result.stdout).toContain('terminal ...')
    expect(result.stdout).not.toContain('agent ...')
    expect(result.stderr).toBe('')
  })

  test('INV-9 命令壳把退出码交回进程：未知命名空间退 2、失败文本走 stderr', () => {
    const result = spawnSync(binaryPath, ['not-a-namespace'], { encoding: 'utf8' })

    expect(result.status).toBe(VelarosCliExitCodes.usage)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('UNKNOWN_NAMESPACE')
  })
})
