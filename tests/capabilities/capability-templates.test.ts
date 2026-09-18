/**
 * 代码模版是给模型看的日常用法示例。只过类型检查不够：结果键取错一个、默认的写法跑不通，模型照着写就跟着错。
 * 这里在真的空间里把每份模版的每个函数都调一遍——系统空间用真的本地内核（真命令、真后台任务、真沙箱，macOS 上用 sips 裁图），
 * 项目空间用真的项目内核加内置语言服务——程序经真的门（检查器 + 隔离子进程）交上去，和模型交程序是同一条路。
 * 断言看的是每个函数交回的东西是不是它说的那个样子、磁盘上是不是真改了，不钉具体文字。
 * 模版横跨能力单元与两个空间，所以测试放在仓库层。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import type { ApprovalPort } from '@velaros-ai/agent/tool-contract'

import type { CodeCapabilityPort, CodeGateReply, MountedCapabilityModule } from '../../packages/code-surface/src/index'
import { codeProgramChecker, createCapabilityPort, createCodeProgramGate, nodeSubprocessCodeRunner } from '../../packages/code-surface/src/index'
import { createProjectSpace, type ProjectCallContext, type ProjectHostPort } from '../../packages/project/src/index'
import { solidPng } from '../../packages/system/spec/support'
import { createLocalSystemKernel, createSystemSpace } from '../../packages/system/src/index'
import { createProjectCodeQuery } from '../../packages/velar/development/index'
import { createProjectKernel, typescriptPlugin } from '../../packages/velar/project/index'

const RepoRoot = resolve(import.meta.dir, '../..')
const canConfine = (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec'))
  || (process.platform === 'linux' && ['/usr/bin/bwrap', '/usr/local/bin/bwrap'].some((path) => existsSync(path)))

/** 一份模版的原文：程序就是它，后面接上这次要调的那几个函数。 */
function template(file: string): string {
  return readFileSync(resolve(RepoRoot, 'packages/velar', file), 'utf8')
}

/** 用户一律点头：这里验的是模版的写法，不是审批。 */
const approval: ApprovalPort = {
  awaitConfirmation: async () => {},
  awaitConfirmationDecision: async () => ({ approved: true, message: null, autoApproved: false }),
}

/** 一个空间在门眼里的样子：挂了哪几件、调用经哪个端口。 */
interface Space {
  modules: readonly MountedCapabilityModule[]
  port: CodeCapabilityPort
}

const gate = createCodeProgramGate({ checker: codeProgramChecker, runner: nodeSubprocessCodeRunner })

/**
 * 像模型那样交一段程序：头一次 import 按需模块时门不执行、先交回声明，模型照着再交一次——这里也再交一次。
 * 检查没过或者程序没跑完就把门的回执整段抛出来，一看就知道是哪一行。
 */
async function runProgram(space: Space, sessionId: string, source: string): Promise<{ values: Record<string, any>; reply: CodeGateReply }> {
  const submit = () => gate.run({ sessionId, program: { source }, modules: space.modules, capabilities: space.port, timeoutMs: 120_000 })
  let reply = await submit()
  if (!reply.outcome.checked && 'needsModules' in reply.outcome) reply = await submit()
  if (!reply.outcome.checked || reply.outcome.result.failed) throw new Error(reply.text)
  return { values: reply.outcome.result.value as Record<string, any>, reply }
}

/** 删临时目录前先核对它确实在系统临时区里：删错目录的代价太大。 */
async function removeTemporary(path: string): Promise<void> {
  const base = await realpath(tmpdir())
  const target = await realpath(path)
  if (!target.startsWith(`${base}${sep}`)) throw new Error(`拒绝删除临时区以外的目录：${target}`)
  await rm(target, { recursive: true, force: true })
}

/** 按「相对路径 → 内容」把一批文件写进 root。 */
async function writeTree(root: string, files: Record<string, string | Buffer>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
}

/** 建一个有一次提交、一处未提交改动的 git 仓库。 */
function gitRepo(root: string): void {
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: root, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
}

/** 跑测试、构建、开发服务器这几条命令要的脚本：两个空间里都放一份。 */
const CommandScripts: Record<string, string> = {
  'checks/pass.js': "console.log('3 passing')\n",
  'checks/fail.js': "console.log('2 passing')\nconsole.error('AssertionError: expected 1 to equal 2')\nprocess.exit(1)\n",
  'checks/build.js': "console.log('building…')\nconsole.log('src/a.ts(3,5): error TS2304: Cannot find name x')\nconsole.error('Error: build failed')\nprocess.exit(1)\n",
  'server.js': "console.log('listening on http://localhost:43210')\nsetInterval(() => {}, 1000)\n",
}

/** 同一段 shell 模版在两个空间里各跑一遍：git 仓库在 gitDir。 */
function shellCalls(gitDir: string): string {
  return `
export const passed = await runTests('node checks/pass.js')
export const failed = await runTests('node checks/fail.js')
export const errors = await errorLines('node checks/build.js')
export const git = await gitState('${gitDir}')
export const todos = await findTodos('src')
export const server = await startServer('node server.js')
export const log = 'taskId' in server ? await taskOutput(server.taskId, 5) : server
export const stopped = 'taskId' in server ? await stopTask(server.taskId) : server
export const tool = await afterInstall('node --version')
`
}

/** shell 模版在任何一个空间里都该交回的样子。 */
function expectShellResults(values: Record<string, any>): void {
  expect(values.passed).toMatch(/^通过（\d+ ms）$/)
  expect(values.failed).toMatchObject({ exitCode: 1, timedOut: false })
  expect(values.failed.tail).toContain('AssertionError: expected 1 to equal 2')
  expect(values.errors).toMatchObject({ success: false, count: 2 })
  expect(values.errors.errors).toEqual(['src/a.ts(3,5): error TS2304: Cannot find name x', 'Error: build failed'])
  expect(values.git.branch).toBe('main')
  expect(values.git.changed.join('\n')).toContain('README.md')
  expect(values.git.recent).toHaveLength(1)
  expect(values.git.recent[0]).toEndWith(' init')
  expect(values.todos).toMatchObject({ total: 2, perFile: { 'src/a.ts': 1, 'src/b.ts': 1 } })
  expect(values.todos.first[0]).toMatchObject({ file: 'src/a.ts', line: 2, text: '// TODO: handle empty input' })
  expect(values.server.taskId).toBeString()
  expect(values.server.status).toBe('running')
  expect(values.server.lastLines).toContain('listening on http://localhost:43210')
  expect(values.log).toMatchObject({ status: 'running', lastLines: ['listening on http://localhost:43210'] })
  expect(values.stopped).toMatchObject({ taskId: values.server.taskId, stopped: true })
  expect(values.tool).toMatch(/^v\d+\.\d+\.\d+$/)
}

describe('系统空间里的模版', () => {
  let root = ''
  let space: Space
  let dispose: () => Promise<void> = async () => {}

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'velar-templates-system-')))
    await writeTree(root, {
      ...CommandScripts,
      '.zshrc': "export PATH=/usr/bin\nalias ll='ls -l'\nexport EDITOR=nano\n",
      'logs/app.log': 'INFO start\nERROR a\nINFO x\nERROR b\nWARN y\nERROR c\n',
      'settings.json': '{\n  "theme": "light"\n}\n',
      'notes/a.md': 'oldName is here\n',
      'notes/b.md': 'nothing\noldName again, oldName\n',
      'repo/README.md': 'hello\n',
      'src/a.ts': 'export const a = 1\n// TODO: handle empty input\n',
      'src/b.ts': '// FIXME: slow\nexport const b = 2\n',
      'site/src/index.ts': 'const a = 1\n',
      'site/scripts/fix.js': "const fs = require('node:fs')\nfs.writeFileSync('src/index.ts', 'const a = 2\\n')\nfs.writeFileSync('src/new.ts', 'export const b = 1\\n')\n",
      'site/scripts/fail.js': "console.error('migration failed')\nprocess.exit(3)\n",
      'small.png': solidPng(200, 100),
      'shot.png': solidPng(3000, 1600),
    })
    gitRepo(join(root, 'repo'))
    await writeFile(join(root, 'repo/README.md'), 'hello, world\n')
    const kernel = createLocalSystemKernel({ cwd: root })
    const system = createSystemSpace({ host: kernel, resolveCall: (signal) => ({ abortSignal: signal ?? new AbortController().signal, approval, sessionId: 'templates' }) })
    space = { modules: system.modules, port: createCapabilityPort(system.operations) }
    dispose = async () => {
      for (const sandbox of kernel.listSandboxes()) await kernel.discardSandbox(sandbox.id)
      await kernel.dispose()
    }
  })

  afterAll(async () => {
    await dispose()
    if (root) await removeTemporary(root)
  })

  test('velar:files：看、找、批量读、改一行、删几行、改 JSON、新建、几个文件一起改、撤回', async () => {
    const { values } = await runProgram(space, 'files', `${template('files/template.js')}
export const shown = await showFile('.zshrc')
export const grep = await grepFile('logs/app.log', /error/i, 2)
export const many = await readMany(['.zshrc', 'missing.cfg'])
export const setExisting = await setLine('.zshrc', /^export EDITOR=/, 'export EDITOR=vim')
export const setAppended = await setLine('.zshrc', /^export PAGER=/, 'export PAGER=less')
export const deleted = await deleteLines('.zshrc', /^alias ll=/)
export const json = await updateJson('settings.json', 'theme', 'dark')
export const created = await createFile('bin/hello.sh')
export const replaced = await replaceInFiles(['notes/a.md', 'notes/b.md'], 'oldName', 'newName')
export const replacedOnDisk = typeof replaced === 'string' ? replaced : (await read({ files: [{ path: 'notes/b.md' }] })).files
export const reverted = typeof replaced === 'string' ? replaced : await revert(replaced.changeId)
`)
    expect(values.shown).toBe("1: export PATH=/usr/bin\n2: alias ll='ls -l'\n3: export EDITOR=nano")
    expect(values.grep).toEqual({ total: 3, last: ['4: ERROR b', '6: ERROR c'] })
    // 读到的那项交回解析过的路径（系统空间里是绝对路径），读不了的那项照传入的原样。
    expect(relative(root, values.many[0].path)).toBe('.zshrc')
    expect(values.many[0].text).toBe("export PATH=/usr/bin\nalias ll='ls -l'\nexport EDITOR=nano")
    expect(values.many[1].path).toBe('missing.cfg')
    expect(values.many[1].error).toBeString()
    for (const name of ['setExisting', 'setAppended', 'deleted', 'json', 'created']) expect(values[name].changeId, name).toBeString()
    expect(await readFile(join(root, '.zshrc'), 'utf8')).toBe('export PATH=/usr/bin\nexport EDITOR=vim\nexport PAGER=less\n')
    expect(JSON.parse(await readFile(join(root, 'settings.json'), 'utf8'))).toEqual({ theme: 'dark' })
    expect(values.created.files[0]).toMatchObject({ created: true })
    expect(await readFile(join(root, 'bin/hello.sh'), 'utf8')).toBe('#!/bin/sh\necho hello\n')
    expect(values.replaced.changed.map((path: string) => relative(root, path))).toEqual(['notes/a.md', 'notes/b.md'])
    expect(values.replacedOnDisk[0].lines).toEqual([[1, 'nothing'], [2, 'newName again, newName']])
    // 撤回之后两个文件都回到改之前。
    expect(values.reverted.files).toHaveLength(2)
    expect(await readFile(join(root, 'notes/b.md'), 'utf8')).toBe('nothing\noldName again, oldName\n')
  }, 180_000)

  test('velar:shell：跑测试、筛错误、看 git、rg 找东西、起后台服务再停掉、刷新环境', async () => {
    const { values } = await runProgram(space, 'shell', `${template('shell/template.js')}${shellCalls('repo')}`)
    expectShellResults(values)
  }, 180_000)

  test.skipIf(!canConfine)('velar:sandbox：镜像里试命令、失败就丢、看差量、只落回一部分、镜像里重新构建、丢掉', async () => {
    const { values } = await runProgram(space, 'sandbox', `${template('sandbox/template.js')}
export const failedRun = await rehearse('node scripts/fail.js', 'site')
export const tried = await rehearse('node scripts/fix.js', 'site')
export const changes = 'id' in tried ? await showChanges(tried.id, ['src/index.ts']) : tried
export const applied = 'id' in tried ? await applyAndClean(tried.id, ['src/new.ts']) : tried
export const built = await rehearseBuild('node scripts/fix.js', 'site')
const again = await rehearse('node scripts/fix.js', 'site')
export const thrown = 'id' in again ? await throwAway(again.id) : again
`)
    expect(values.failedRun).toMatchObject({ failed: true, exitCode: 3 })
    expect(values.failedRun.tail).toContain('migration failed')
    expect(values.tried).toMatchObject({ created: ['src/new.ts'], modified: ['src/index.ts'], deleted: [] })
    expect(values.changes).toContain('── src/index.ts')
    expect(values.changes).toContain('+const a = 2')
    expect(values.applied).toMatchObject({ created: ['src/new.ts'], modified: [], deleted: [] })
    // 只落回了点名的那一个：源目录里的 index.ts 没动。
    expect(await readFile(join(root, 'site/src/new.ts'), 'utf8')).toBe('export const b = 1\n')
    expect(await readFile(join(root, 'site/src/index.ts'), 'utf8')).toBe('const a = 1\n')
    expect(values.built).toMatchObject({ success: true })
    expect(values.thrown).toMatchObject({ removed: true })
  }, 180_000)

  test.skipIf(process.platform !== 'darwin')('velar:images：看一张、几张一起看（看不了的单独失败）、放大一块', async () => {
    const { values, reply } = await runProgram(space, 'images', `${template('images/template.js')}
export const one = await look('small.png')
export const both = await compare(['small.png', 'missing.png'])
export const zoomed = await zoom('shot.png', 3000, 1600)
`)
    expect(relative(root, values.one.path)).toBe('small.png')
    expect(values.one).toMatchObject({ width: 200, height: 100, sent: { width: 200, height: 100 } })
    expect(values.both[0]).toEndWith('small.png：200×100')
    expect(values.both[1]).toStartWith('missing.png：')
    expect(values.zoomed[0]).toMatchObject({ width: 3000, height: 1600 })
    expect(values.zoomed[0].sent.width).toBeLessThanOrEqual(1500)
    // 图不在返回值里：跟在结果后面交给模型看，看了几张就有几张。
    expect(reply.images).toHaveLength(3)
  }, 180_000)
})

describe('项目空间里的模版', () => {
  let root = ''
  let space: Space
  let dispose: () => Promise<void> = async () => {}

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'velar-templates-project-')))
    await writeTree(root, {
      ...CommandScripts,
      'README.md': 'demo\n',
      'package.json': '{\n  "name": "demo",\n  "type": "module"\n}\n',
      'tsconfig.json': '{\n  "compilerOptions": { "strict": true, "target": "es2022", "module": "esnext", "moduleResolution": "bundler" },\n  "include": ["src"]\n}\n',
      'src/user.ts': 'export class UserService {\n  find(id: string) {\n    return { id }\n  }\n}\n',
      'src/index.ts': "import { UserService } from './user.js'\n\nexport function loadSettings() {\n  return { debug: false }\n}\n\nexport const service = new UserService()\nexport const settings = loadSettings()\n",
      'src/app.ts': "import { loadSettings } from './index.js'\n\nexport function useSettings() {\n  return loadSettings()\n}\n\nexport const current = useSettings()\n",
      'src/view.tsx': "import { useSettings } from './app.js'\n\nexport const view = useSettings()\n",
      'src/service.ts': 'export function run() {\n  return oldCall(1)\n}\n\nfunction oldCall(n: number) {\n  return n\n}\n',
      'src/config.ts': 'export const retries = 3\n',
      'src/old-name.ts': 'export class OldName {}\n',
      'src/feature.test.ts': "import { run } from './service.js'\n\nexport const ok = run() === 1\n",
      'src/broken.ts': "export const count: number = 'three'\n",
      'src/a.ts': 'export const a = 1\n// TODO: handle empty input\n',
      'src/b.ts': '// FIXME: slow\nexport const b = 2\n',
    })
    gitRepo(root)
    await writeFile(join(root, 'README.md'), 'demo, changed\n')
    const commands = createLocalSystemKernel({ cwd: root })
    const kernel = await createProjectKernel({ root, plugins: [typescriptPlugin()] })
    // 代码图谱没接：语言服务类查询走内置实现，图谱类的如实报 UNAVAILABLE。
    const queryCode = createProjectCodeQuery({ isAvailable: () => false, query: async () => ({}) })
    const host: ProjectHostPort = {
      getRootPath: () => root,
      kernel: async () => kernel,
      prepareMutation: async () => ({ approved: true, message: '已授权' }),
      queryCode,
      runCommand: (command, options, allowDangerous, abortSignal) => commands.runCommand(command, options, allowDangerous, abortSignal),
      listBackgroundTasks: (options) => commands.listBackgroundTasks(options),
      refreshShellEnvironment: () => commands.refreshShellEnvironment(),
      terminateBackgroundTask: (request) => commands.terminateBackgroundTask(request),
    }
    const context: ProjectCallContext = { abortSignal: new AbortController().signal, project: host, approval, sessionId: 'templates' }
    const project = createProjectSpace({ resolveCall: () => context })
    space = { modules: project.modules, port: createCapabilityPort(project.operations) }
    dispose = () => commands.dispose()
  })

  afterAll(async () => {
    await dispose()
    if (root) await removeTemporary(root)
  })

  test('velar:code：大纲、定义与引用、按文件数引用、改之前的波及面、改完的报错、要图后端的分析', async () => {
    const { values } = await runProgram(space, 'code', `${template('project/code-template.js')}
export const shape = await outline('src/user.ts')
export const users = await whoUses('UserService')
export const counts = await referenceCounts('UserService')
export const radius = await blastRadius('src/user.ts', 'UserService')
export const errors = await errorsIn('src/broken.ts')
export const cycles = await dependencyCycles()
`)
    expect(values.shape.symbols.join('\n')).toContain('UserService')
    expect(values.users.declaration).toMatchObject({ startLine: 1 })
    expect(values.users.candidates).toBe(1)
    expect(JSON.stringify(values.users.references)).toContain('src/index.ts')
    expect(values.counts.total).toBeGreaterThanOrEqual(1)
    expect(values.counts.perFile['src/index.ts']).toBeGreaterThanOrEqual(1)
    expect(JSON.stringify(values.radius.importers)).toContain('src/index.ts')
    expect(values.errors.errors).toHaveLength(1)
    expect(values.errors.errors[0]).toContain('src/broken.ts:1')
    expect(values.cycles).toBe('没有代码图谱后端')
  }, 180_000)

  test('velar:project：看文件与函数、批量读、目录与找文件、汇总用处、改几处、失败看原因、新建并引用、改名、全项目改名、看差量与撤销', async () => {
    const { values } = await runProgram(space, 'project', `${template('project/template.js')}
export const file = await showFile('src/user.ts')
export const fn = await showFunction('loadSettings', 'src')
export const configs = await readConfigs(['package.json', 'tsconfig.json', 'missing.json'])
export const layout = await tree('.', 2)
export const tests = await findFiles('src', '*.test.ts')
export const usage = await whereUsed('useSettings')
export const edited = await editFile('src/service.ts', 'oldCall(', 'newCall(')
export const retried = await replaceOnce('src/config.ts', 'const retries = 3', 'const retries = 5')
export const missed = await replaceOnce('src/config.ts', 'const retries = 3', 'const retries = 7')
export const added = await addModule('src/index.ts', 'src/cache.ts')
export const moved = await renameFile('src/old-name.ts', 'src/new-name.ts', 'OldName', 'NewName')
export const renamed = await renameEverywhere('loadSettings', 'readSettings')
export const reviewed = typeof renamed === 'string' ? renamed : await review(renamed.changeRef)
export const reverted = typeof renamed === 'string' ? renamed : await revert(renamed.changeRef)
`)
    expect(values.file).toStartWith('1: export class UserService {\n2:   find(id: string) {')
    expect(values.fn.path).toBe('src/index.ts')
    expect(values.fn.fileRef).toStartWith('view:')
    expect(values.fn.text).toStartWith('3: export function loadSettings() {')
    expect(values.configs.files.map((file: { path: string }) => file.path)).toEqual(['package.json', 'tsconfig.json'])
    expect(values.configs.issues).toEqual([expect.objectContaining({ path: 'missing.json', code: 'TARGET_NOT_FOUND' })])
    expect(values.layout.split('\n')).toEqual(expect.arrayContaining(['src/', 'src/user.ts', 'package.json']))
    // 版本库内部不是项目文件：看目录结构时不该冒出来。
    expect(values.layout).not.toContain('.git')
    expect(values.tests).toEqual(['src/feature.test.ts'])
    expect(values.usage).toEqual({ total: 4, perFile: { 'src/app.ts': 2, 'src/view.tsx': 2 } })
    expect(values.edited).toMatchObject({ changed: true, changedFiles: ['src/service.ts'] })
    expect(await readFile(join(root, 'src/service.ts'), 'utf8')).toStartWith("import { newCall } from './calls.js'\nexport function run() {\n  return newCall(1)\n}")
    expect(values.retried).toMatchObject({ changed: true })
    expect(await readFile(join(root, 'src/config.ts'), 'utf8')).toBe('export const retries = 5\n')
    // 同一处已经改过了：再改就找不到原文，程序拿到的是原因码和说明，不是一个崩掉的程序。
    expect(values.missed.code).toBe('TARGET_NOT_FOUND')
    expect(values.missed.message).toBeString()
    expect([...values.added.changedFiles].sort()).toEqual(['src/cache.ts', 'src/index.ts'])
    expect(await readFile(join(root, 'src/index.ts'), 'utf8')).toStartWith("import { cache } from './cache.js'\n")
    expect(existsSync(join(root, 'src/old-name.ts'))).toBe(false)
    expect(await readFile(join(root, 'src/new-name.ts'), 'utf8')).toBe('export class NewName {}\n')
    expect([...values.renamed.changedFiles].sort()).toEqual(['src/app.ts', 'src/index.ts'])
    expect(values.reviewed.status).toBe('applied')
    expect(values.reviewed.diff).toContain('+export function readSettings() {')
    // 撤销之后改名整次回去了。
    expect(values.reverted.changedFiles).toHaveLength(2)
    expect(await readFile(join(root, 'src/app.ts'), 'utf8')).toContain('return loadSettings()')
  }, 180_000)

  test('velar:shell：同一份模版在项目里照样跑得通', async () => {
    const { values } = await runProgram(space, 'shell', `${template('shell/template.js')}${shellCalls('.')}`)
    expectShellResults(values)
  }, 180_000)
})
