import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { NodeRuntimePackagePrefix } from '../src/contract/constants'
import { createNodeCodeRunner } from '../src/impl/NodeCodeRunner'
import type { CodeRunRequest } from '../src/types/runner'
import { executeNativeNode } from '../src/utils/native-process'

// executeNativeNode / nodeSubprocessCodeRunner 的进程组宿主仅支持 POSIX。
const it = test.skipIf(process.platform === 'win32')
// 老版 Bun 没有 HTTP connection 处理器；明确拒绝，不静默悬挂等待。
const unsupportedBridge =
  process.platform === 'win32' &&
  !!process.versions.bun &&
  createServer().listenerCount('connection') === 0

const request = (source: string, extra: Partial<CodeRunRequest> = {}): CodeRunRequest => ({
  source,
  modules: {},
  blobs: {},
  input: null,
  operations: {},
  timeoutMs: 1000,
  ...extra,
})
const noCalls = async () => ({})
const log = () => {}

async function installPackage(root: string, name: string, version: string) {
  const directory = join(root, 'node_modules', name)
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({
      name: 'aliased-original',
      version,
      type: 'module',
      exports: {
        '.': { import: './index.mjs', require: './index.cjs' },
        './feature': { import: './feature.mjs', require: './feature.cjs' },
      },
    })
  )
  for (const stem of ['index', 'feature']) {
    await writeFile(
      join(directory, `${stem}.mjs`),
      `export const value=${JSON.stringify(version)};`
    )
    await writeFile(join(directory, `${stem}.cjs`), `exports.value=${JSON.stringify(version)};`)
  }
  await writeFile(join(directory, 'README.md'), `Installed ${version}`)
}
async function fixture(run: (cwd: string, directory: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'native-script-test-'))
  const cwd = join(root, 'workspace')
  await mkdir(cwd)
  try {
    await run(cwd, join(root, 'runs'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('INV-28 宿主 Node 进程注入与回收', () => {
  test.skipIf(unsupportedBridge)('能力目录准备中取消会停止后续写入并释放租约，不启动进程', () =>
    fixture(async (cwd, directory) => {
      const controller = new AbortController()
      let released = 0
      let authorized = 0
      let launched = 0
      const runner = createNodeCodeRunner({
        cwd,
        directory,
        acquireRuntime: async () => ({
          environment: { id: 'preparation', packages: [], skills: [] },
          release: async () => {
            released++
          },
        }),
        authorize: async () => {
          authorized++
        },
        execute: async () => {
          launched++
          return { exitCode: 0, signal: null, stdout: '', stderr: '' }
        },
      })
      const result = await runner.run(
        request('', {
          operations: { demo: ['read'], later: ['read'] },
          host: {
            sessionId: 'preparation',
            executionId: 'cancel',
            modules: {
              demo: {
                summary: '取消发生在实际能力声明准备时',
                get declarations() {
                  controller.abort()
                  return "declare module 'velaros:demo' { export function read(): Promise<string> }"
                },
              },
            },
          },
        }),
        noCalls,
        log,
        controller.signal
      )
      expect(result).toMatchObject({ ok: false, error: { code: 'ABORTED' } })
      expect(result.process).toBeUndefined()
      expect({ released, authorized, launched }).toEqual({
        released: 1,
        authorized: 0,
        launched: 0,
      })
      const [run] = await readdir(directory)
      expect(await readdir(join(directory, run!, 'host'))).toEqual(['bridge.mjs'])
    })
  )

  test.skipIf(unsupportedBridge)('准备阶段超时通知租约获取并回收迟到租约', () =>
    fixture(async (cwd, directory) => {
      let released = 0
      let launched = 0
      const runner = createNodeCodeRunner({
        cwd,
        directory,
        acquireRuntime: async (signal) => {
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true })
          )
          return {
            environment: { id: 'late-preparation', packages: [], skills: [] },
            release: async () => {
              released++
            },
          }
        },
        execute: async () => {
          launched++
          return { exitCode: 0, signal: null, stdout: '', stderr: '' }
        },
      })
      const result = await runner.run(request('', { timeoutMs: 30 }), noCalls, log)
      expect(result).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } })
      expect(result.error?.message).toContain('准备')
      expect(result.process).toBeUndefined()
      expect({ released, launched }).toEqual({ released: 1, launched: 0 })
    })
  )

  it('Execa 启动文件、Node 子进程和并发孙进程继承同一授权包，磁盘脚本保持原生解析', () =>
    fixture(async (root, directory) => {
      const cwd = join(root, '有 空格')
      await mkdir(cwd)
      await writeFile(
        join(cwd, 'saved.mjs'),
        "import {read} from 'velaros:demo'; console.log(JSON.stringify(await read({from:'file'})))"
      )
      await writeFile(
        join(cwd, '__velaros_program__.mjs'),
        "import {read} from 'velaros:demo'; console.log(JSON.stringify(await read({from:'disk'})))"
      )
      await writeFile(
        join(cwd, 'fork.mjs'),
        "import {read} from 'velaros:demo'; process.send(await read({from:'fork'}))"
      )
      const runner = createNodeCodeRunner({ cwd, directory, execute: executeNativeNode })
      const calls: unknown[] = []
      const dispatch = async (call: { input: unknown }) => {
        calls.push(call.input)
        return { value: call.input }
      }
      const shell = await runner.run(
        request(
          "import {execa} from 'execa';console.log((await execa(process.execPath,['saved.mjs'])).stdout)",
          {
            input: undefined,
            operations: { demo: ['read'] },
          }
        ),
        dispatch,
        log
      )
      expect(shell).toMatchObject({ ok: true })
      expect(shell.process?.stdout).toContain('file')
      const children = await runner.run(
        request(
          "import {execFile} from 'node:child_process'; import {promisify} from 'node:util'; await Promise.all(['saved.mjs','__velaros_program__.mjs'].map(async file=>console.log((await promisify(execFile)(process.execPath,[file])).stdout)))",
          { operations: { demo: ['read'] }, timeoutMs: 3000 }
        ),
        dispatch,
        log
      )
      expect(children.ok).toBe(true)
      expect(children.process?.stdout).toContain('disk')
      expect(calls.map((value) => JSON.stringify(value)).sort()).toEqual([
        '{"from":"disk"}',
        '{"from":"file"}',
        '{"from":"file"}',
      ])
      const forked = await runner.run(
        request(
          "import {fork} from 'node:child_process'; const child=fork('fork.mjs'); await new Promise((resolve,reject)=>{child.on('message', value=>console.log(JSON.stringify(value)));child.on('exit',code=>code ? reject(new Error(String(code))) : resolve());child.on('error',reject)})",
          { operations: { demo: ['read'] }, timeoutMs: 3000 }
        ),
        dispatch,
        log
      )
      expect(forked).toMatchObject({ ok: true })
      expect(forked.process?.stdout).toContain('fork')
      const denied = await runner.run(
        request(
          "import {execa} from 'execa';console.log((await execa(process.execPath,['saved.mjs'])).stdout)",
          { input: undefined }
        ),
        dispatch,
        log
      )
      expect(denied.ok).toBe(false)
      expect(denied.process?.stderr).toContain('PERMISSION')
      expect(calls.length).toBe(4)
    }))
  test('预取消和审批拒绝均不启动进程', () =>
    fixture(async (cwd, directory) => {
      let launches = 0
      const runner = createNodeCodeRunner({
        cwd,
        directory,
        authorize: async () => {
          throw new Error('denied')
        },
        execute: async () => {
          launches++
          throw new Error('unexpected')
        },
      })
      expect(
        (await runner.run(request('console.log(1)'), noCalls, log, AbortSignal.abort())).error?.code
      ).toBe('ABORTED')
      expect((await runner.run(request('console.log(1)'), noCalls, log)).error?.message).toContain(
        'denied'
      )
      expect(launches).toBe(0)
    }))
  test('注入的进程收束失败不能报告成功', () =>
    fixture(async (cwd, directory) => {
      const runner = createNodeCodeRunner({
        cwd,
        directory,
        execute: async () => ({
          exitCode: 0,
          signal: null,
          stdout: 'partial',
          stderr: '',
          cleanupIncomplete: true,
        }),
      })
      const result = await runner.run(request(''), noCalls, log)
      expect(result.ok).toBe(false)
      expect(result.error?.code).toBe('RUNNER_CRASHED')
      expect(result.process?.stdout).toBe('partial')
    }))
  it('真实 Node 同步失败、输出与 Execa heredoc 使用同一进程口', () =>
    fixture(async (cwd, directory) => {
      const runner = createNodeCodeRunner({ cwd, directory, execute: executeNativeNode })
      const result = await runner.run(
        request(
          "import {execaCommand} from 'execa';console.log((await execaCommand(\"cat <<'EOF' > note.txt\\n$notExpanded `literal`\\nEOF\\ncat note.txt\",{shell:true})).stdout)",
          {
            input: undefined,
          }
        ),
        noCalls,
        log
      )
      expect(result.ok).toBe(true)
      expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('$notExpanded `literal`\n')
      const failed = await runner.run(
        request("console.log('before');throw new Error('failed')"),
        noCalls,
        log
      )
      expect(failed.error?.message).toBe('failed')
      expect(failed.process?.stdout).toContain('before')
    }))
  it('超时后回收同一进程组中的子进程', () =>
    fixture(async (cwd, directory) => {
      const runner = createNodeCodeRunner({ cwd, directory, execute: executeNativeNode })
      const result = await runner.run(
        request(
          "import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync('pid.txt',String(child.pid));setInterval(()=>{},1000)",
          { timeoutMs: 500 }
        ),
        noCalls,
        log
      )
      expect(result.error?.code).toBe('TIMEOUT')
      const pid = Number(await readFile(join(cwd, 'pid.txt'), 'utf8'))
      expect(() => process.kill(pid, 0)).toThrow()
    }))
  it('输出在异常和 CPU 超时后仍保留，不会被 catch 隐藏非法输出', () =>
    fixture(async (cwd, directory) => {
      const runner = createNodeCodeRunner({ cwd, directory, execute: executeNativeNode })
      for (const tail of ["throw new Error('failed')", 'while(true){}']) {
        const result = await runner.run(
          request(`import {output} from 'velaros';output({n:42});${tail}`, { timeoutMs: 300 }),
          noCalls,
          log
        )
        expect(result.ok).toBe(false)
        expect(result.output?.blocks[0]?.value).toEqual({ n: 42 })
      }
    }))
})

describe('INV-46 显式宿主 npm 安装与工作区包身份', () => {
  it('工作区旧版 CJS 与宿主 Execa 独立导入，目录保留两种实际身份', () =>
    fixture(async (cwd, directory) => {
      const local = join(cwd, 'node_modules', 'execa')
      await mkdir(local, { recursive: true })
      await writeFile(
        join(local, 'package.json'),
        JSON.stringify({ name: 'execa', version: '5.0.0', main: 'index.cjs' })
      )
      await writeFile(join(local, 'index.cjs'), 'module.exports=()=>"workspace";')
      const runner = createNodeCodeRunner({ cwd, directory, execute: executeNativeNode })
      const result = await runner.run(
        request(
          `
        import local from 'execa';
        import {execa} from 'velaros:npm/execa';
        import {readFileSync} from 'node:fs';
        const pkg=JSON.parse(readFileSync(process.env.VELAROS_HOST_DIR+'/index.json','utf8')).packages.find(p=>p.name==='execa');
        export default {local:local(),host:(await execa(process.execPath,['-e','process.stdout.write("42")'],{stdin:'ignore'})).stdout,pkg};
      `,
          { timeoutMs: 3000 }
        ),
        noCalls,
        log
      )
      expect(result).toMatchObject({
        ok: true,
        value: {
          local: 'workspace',
          host: '42',
          pkg: { source: 'workspace', version: '5.0.0', runtimeImport: 'velaros:npm/execa' },
        },
      })
      const pkg = (
        result.value as {
          pkg: { runtimeVersion: string; runtimePackageJson: string; runtimeReadme: string }
        }
      ).pkg
      expect(pkg.runtimeVersion).not.toBe('5.0.0')
      expect(JSON.parse(await readFile(pkg.runtimePackageJson, 'utf8')).version).toBe(
        pkg.runtimeVersion
      )
      expect(await readFile(pkg.runtimeReadme, 'utf8')).toContain('execa')
      const bare = await runner.run(
        request("import {execa} from 'execa'; export default typeof execa;"),
        noCalls,
        log
      )
      expect(bare.ok).toBe(false)
      expect(bare.process?.stderr).toContain('execa')
    }))

  it('作用域别名、公开子路径、ESM/CJS 子进程使用同一宿主快照', () =>
    fixture(async (cwd, directory) => {
      const host = join(cwd, 'host')
      for (const name of ['tool-alias', '@tools/alias']) {
        await installPackage(cwd, name, 'workspace')
        await installPackage(host, name, 'host')
      }
      await writeFile(
        join(cwd, 'child.mjs'),
        "import {value} from 'velaros:npm/@tools/alias/feature';console.log(value);"
      )
      await writeFile(
        join(cwd, 'child.cjs'),
        "console.log(require('velaros:npm/tool-alias').value,require('velaros:npm/@tools/alias/feature').value);"
      )
      const runner = createNodeCodeRunner({
        cwd,
        directory,
        execute: executeNativeNode,
        runtime: {
          id: 'alias-host',
          packages: ['tool-alias', '@tools/alias'].map((name) => ({
            name,
            version: 'host',
            directory: host,
          })),
          skills: [],
        },
      })
      const result = await runner.run(
        request(
          `
        import {value as local} from '@tools/alias';
        import {value as host} from 'velaros:npm/tool-alias';
        import {value as feature} from 'velaros:npm/@tools/alias/feature';
        import {execFileSync} from 'node:child_process';
        export default {local,host,feature,esm:execFileSync(process.execPath,['child.mjs'],{encoding:'utf8'}).trim(),cjs:execFileSync(process.execPath,['child.cjs'],{encoding:'utf8'}).trim()};
      `,
          { timeoutMs: 3000 }
        ),
        noCalls,
        log
      )
      expect(result).toMatchObject({
        ok: true,
        value: { local: 'workspace', host: 'host', feature: 'host', esm: 'host', cjs: 'host host' },
      })
      const hidden = await runner.run(
        request("import 'velaros:npm/@tools/alias/private';"),
        noCalls,
        log
      )
      expect(hidden).toMatchObject({ ok: false, error: { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' } })
    }))

  it('未授权安装和路径越界拒绝，能力与组合包不能覆盖宿主命名空间', () =>
    fixture(async (cwd, directory) => {
      let launches = 0
      const runner = createNodeCodeRunner({
        cwd,
        directory,
        execute: async (...args) => {
          launches++
          return executeNativeNode(...args)
        },
      })
      for (const suffix of [
        'uninstalled',
        'execa/../yaml',
        'execa/%2e%2e/yaml',
        'execa//index.js',
        'execa/./index.js',
        'execa/index.js?x',
        'execa/index.js#x',
      ]) {
        const result = await runner.run(
          request(`import ${JSON.stringify(NodeRuntimePackagePrefix + suffix)};`),
          noCalls,
          log
        )
        expect(result).toMatchObject({ ok: false, error: { code: 'PERMISSION' } })
      }
      const dispatched = launches
      for (const specifier of ['velaros:npm/execa', 'velaros:npm/unknown', 'npm/execa']) {
        const result = await runner.run(
          request('', { operations: { [specifier]: ['run'] } }),
          noCalls,
          log
        )
        expect(result).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
      }
      const combination = await runner.run(
        request('', { packages: [{ specifier: 'velaros:npm/execa', exports: {} }] }),
        noCalls,
        log
      )
      expect(combination).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
      expect(launches).toBe(dispatched)
    }))

  it('后续执行获取新租约，显式导入与目录版本同步，旧租约正常释放', () =>
    fixture(async (cwd, directory) => {
      const roots = ['one', 'two'].map((version) => join(cwd, version))
      for (const [index, root] of roots.entries())
        await installPackage(root, 'tool-alias', String(index + 1))
      let acquired = 0
      let released = 0
      const runner = createNodeCodeRunner({
        cwd,
        directory,
        execute: executeNativeNode,
        acquireRuntime: async () => {
          const index = acquired++
          return {
            environment: {
              id: String(index),
              packages: [
                { name: 'tool-alias', version: String(index + 1), directory: roots[index]! },
              ],
              skills: [],
            },
            binDirectories: [],
            release: async () => {
              released++
            },
          }
        },
      })
      for (const value of ['1', '2']) {
        const result = await runner.run(
          request(
            "import {value} from 'velaros:npm/tool-alias';import {readFileSync} from 'node:fs';const pkg=JSON.parse(readFileSync(process.env.VELAROS_HOST_DIR+'/index.json','utf8')).packages.find(p=>p.name==='tool-alias');export default {value,version:pkg.runtimeVersion};"
          ),
          noCalls,
          log
        )
        expect(result).toMatchObject({ ok: true, value: { value, version: value } })
      }
      expect(acquired).toBe(2)
      expect(released).toBe(2)
    }))
})

// 传输测试注入受控宿主端口，不依赖默认运行器的 POSIX 进程组；Windows 也必须实跑。
function bridgeRequest(socketPath: string, token: string, body: string, path = '/') {
  return new Promise<string>((resolve, reject) => {
    const socket = connect(socketPath)
    let response = ''
    socket.setEncoding('utf8')
    socket.setTimeout(2000, () => socket.destroy(new Error('bridge request timed out')))
    socket.on('error', reject)
    socket.on('data', (chunk) => {
      response += chunk
    })
    socket.on('end', () => resolve(response))
    socket.on('connect', () =>
      socket.write(
        `POST ${path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${token}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
      )
    )
  })
}

test.skipIf(unsupportedBridge)(
  'preparation deadline excludes approval and preserves host wait clock suspension',
  () =>
    fixture(async (cwd, directory) => {
      const runner = createNodeCodeRunner({
        cwd,
        directory,
        authorize: async (_request, signal) => {
          await Bun.sleep(1100)
          expect(signal.aborted).toBe(false)
        },
        execute: async (input, _output, signal) => {
          const reply = await bridgeRequest(
            input.environment.VELAROS_HOST_SOCKET!,
            input.environment.VELAROS_HOST_TOKEN!,
            JSON.stringify({ namespace: 'demo', operation: 'read', input: null })
          )
          expect(reply).toContain('200 OK')
          expect(signal.aborted).toBe(false)
          return { exitCode: 0, signal: null, stdout: '', stderr: '' }
        },
      })
      const outcome = await runner.run(
        request('', { operations: { demo: ['read'] }, timeoutMs: 1000 }),
        async (_call, holdClock) => {
          const release = holdClock()
          await Bun.sleep(1100)
          release()
          return { value: 'ready' }
        },
        log
      )
      expect(outcome.ok).toBe(true)
    })
)

test.skipIf(unsupportedBridge)(
  'local capability bridge validates authorization, handles concurrent calls and closes idle connections',
  () =>
    fixture(async (cwd, directory) => {
      let calls = 0
      let socketPath = ''
      let idleClosed: Promise<void> | undefined
      const runner = createNodeCodeRunner({
        cwd,
        directory,
        execute: async (input) => {
          socketPath = input.environment.VELAROS_HOST_SOCKET!
          const token = input.environment.VELAROS_HOST_TOKEN!
          const body = JSON.stringify({ namespace: 'demo', operation: 'read', input: 'hello' })
          expect(await bridgeRequest(socketPath, 'wrong-token', body)).toContain('403')
          expect(await bridgeRequest(socketPath, token, body, '/unknown')).toContain('403')
          expect(await bridgeRequest(socketPath, token, '{}')).toContain('403')
          expect(await bridgeRequest(socketPath, token, '{')).toContain('400')
          const responses = await Promise.all(
            Array.from({ length: 16 }, () => bridgeRequest(socketPath, token, body))
          )
          for (const response of responses) {
            expect(response).toContain('200 OK')
            expect(response).toContain('hello')
          }
          expect(
            await bridgeRequest(socketPath, token, JSON.stringify({ value: 42 }), '/result')
          ).toContain('200 OK')
          const idle = connect(socketPath)
          idleClosed = new Promise<void>((resolve) => idle.once('close', () => resolve()))
          await new Promise<void>((resolve, reject) => {
            idle.once('connect', resolve)
            idle.once('error', reject)
          })
          return { exitCode: 0, signal: null, stdout: '', stderr: '' }
        },
      })
      const outcome = await runner.run(
        request('', { operations: { demo: ['read'] }, timeoutMs: 5000 }),
        async (call) => {
          calls++
          return { value: call.input }
        },
        log
      )
      expect(outcome).toMatchObject({ ok: true, value: 42 })
      expect(calls).toBe(16)
      await idleClosed
      await expect(bridgeRequest(socketPath, '', '{}')).rejects.toThrow()
    })
)

test.skipIf(unsupportedBridge)(
  'local capability bridge cancels pending calls and closes sockets at timeout',
  () =>
    fixture(async (cwd, directory) => {
      let pending: Promise<string> | undefined
      const runner = createNodeCodeRunner({
        cwd,
        directory,
        execute: async (input, _output, signal) => {
          pending = bridgeRequest(
            input.environment.VELAROS_HOST_SOCKET!,
            input.environment.VELAROS_HOST_TOKEN!,
            JSON.stringify({ namespace: 'demo', operation: 'hang', input: null })
          )
          // 连接被取消时可能以 EOF 或 reset 结束；两种情况都必须被回收。
          pending.catch(() => {})
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true })
          )
          return { exitCode: null, signal: null, stdout: '', stderr: '', aborted: true }
        },
      })
      const outcome = await runner.run(
        request('', { operations: { demo: ['hang'] }, timeoutMs: 1000 }),
        () => new Promise(() => {}),
        log
      )
      expect(outcome).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } })
      expect(outcome.pendingCalls).toHaveLength(1)
      await pending?.catch(() => {})
    })
)

test.skipIf(process.platform !== 'win32')(
  'default POSIX executor refuses Windows rather than launching an unowned process',
  () => {
    expect(() =>
      executeNativeNode(
        { source: "throw new Error('must not run')", cwd: process.cwd(), environment: {} },
        log,
        new AbortController().signal
      )
    ).toThrow(expect.objectContaining({ code: 'UNAVAILABLE' }))
  }
)

test.skipIf(!unsupportedBridge)(
  'unsupported Bun HTTP connection handler refuses before host execution',
  () =>
    fixture(async (cwd, directory) => {
      let launched = false
      const runner = createNodeCodeRunner({
        cwd,
        directory,
        execute: async () => {
          launched = true
          throw new Error('must not launch')
        },
      })
      const outcome = await runner.run(request(''), noCalls, log)
      expect(outcome).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } })
      expect(outcome.error?.message).toContain('HTTP')
      expect(launched).toBe(false)
    })
)
