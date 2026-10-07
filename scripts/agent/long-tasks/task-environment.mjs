import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  chown,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { basename, delimiter, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { validateBaselineIssues } from './regression.mjs'

const execute = promisify(execFile)

// 独占工作根使用执行用户的组；BSD 临时目录的继承组不能改变项目权限测试的语义。
export async function createTaskRoot(prefix = '/private/tmp/vlr-') {
  const directory = await mkdtemp(prefix)
  try {
    if (typeof process.getuid === 'function' && typeof process.getgid === 'function')
      await chown(directory, process.getuid(), process.getgid())
    return directory
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

// 原项目可能在系统临时目录使用固定名称；每次尝试及其派生进程共享自己的临时根。
export async function taskTemporaryEnvironment(taskRoot) {
  const directory = join(taskRoot, 'tmp')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  assert((await lstat(directory)).isDirectory(), 'Task temporary directory must not be a symlink')
  return { TMPDIR: directory, TMP: directory, TEMP: directory }
}

// 评测项目、依赖环境和验收命令在请求模型之前固定；这里只接受工作区内相对路径。
export function taskEnvironment(task) {
  const value = task.environment
  assert(value && typeof value === 'object', 'Task must declare its frozen environment')
  const { project, python, acceptance, regression, preserve, baselineFailure } = value
  const regressionRunner = value.regressionRunner ?? 'pytest'
  const node = value.runtime === 'node'
  assert(value.runtime === undefined || node)
  assert(
    (node
      ? ['mocha-json', 'jest-json', 'ava-tap', 'vitest-json', 'tap-json']
      : ['pytest', 'unittest']
    ).includes(regressionRunner)
  )
  if (regressionRunner === 'unittest') assert.equal(regression.length, 1)
  for (const name of node ? [project] : [project, python])
    assert.match(name, /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u)
  assert.match(acceptance, node ? /^test_[a-zA-Z0-9_]+\.mjs$/u : /^test_[a-zA-Z0-9_]+\.py$/u)
  for (const paths of [regression, preserve]) {
    assert(Array.isArray(paths) && paths.length > 0)
    for (const path of paths) {
      assert.equal(typeof path, 'string')
      assert.match(
        path,
        node && paths === regression
          ? /^[a-zA-Z0-9_.*?-]+(?:\/[a-zA-Z0-9_.*?-]+)*$/u
          : /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/u
      )
      assert(!path.split('/').some((part) => ['.', '..', '.git'].includes(part)))
      assert(!path.startsWith('-'))
    }
    assert.equal(new Set(paths).size, paths.length)
  }
  assert.equal(typeof baselineFailure, 'string')
  assert(baselineFailure.length > 0)
  const result = {
    project,
    ...(node ? { runtime: 'node', regressionEntry: value.regressionEntry } : { python }),
    acceptance,
    regression,
    regressionRunner,
    preserve,
    baselineFailure,
  }
  if (node) {
    assert.equal(python, undefined)
    assert.match(value.regressionEntry, /^[a-zA-Z0-9][a-zA-Z0-9_@.-]*(?:\/[a-zA-Z0-9_@.-]+)*$/u)
    assert(!value.regressionEntry.split('/').some((part) => ['.', '..', '.git'].includes(part)))
    assert(
      !preserve.some((path) => path.split('/')[0] === 'node_modules'),
      'Node dependencies have a separate frozen restoration'
    )
  }
  if (value.build !== undefined) {
    assert(node, 'Project builds are declared for Node tasks')
    assert(value.build && typeof value.build === 'object' && !Array.isArray(value.build))
    assert(Object.keys(value.build).every((name) => ['entry', 'args', 'optional'].includes(name)))
    assert.equal(typeof value.build.entry, 'string')
    assert.match(value.build.entry, /^[a-zA-Z0-9_][a-zA-Z0-9_@.-]*(?:\/[a-zA-Z0-9_@.-]+)*$/u)
    assert(!value.build.entry.split('/').some((part) => ['.', '..', '.git'].includes(part)))
    assert(Array.isArray(value.build.args))
    assert(value.build.args.every((arg) => typeof arg === 'string' && !arg.includes('\0')))
    assert(value.build.optional === undefined || typeof value.build.optional === 'boolean')
    result.build = {
      entry: value.build.entry,
      args: [...value.build.args],
      ...(value.build.optional === undefined ? {} : { optional: value.build.optional }),
    }
  }
  if (value.regressionPreloads !== undefined) {
    assert(node, 'Regression preloads require a Node task')
    assert(Array.isArray(value.regressionPreloads) && value.regressionPreloads.length > 0)
    for (const path of value.regressionPreloads) {
      assert.equal(typeof path, 'string')
      assert.match(path, /^node_modules\/[a-zA-Z0-9_@.-]+(?:\/[a-zA-Z0-9_.-]+)*\.[cm]?js$/u)
      assert(!path.split('/').some((part) => ['.', '..'].includes(part)))
    }
    assert.equal(new Set(value.regressionPreloads).size, value.regressionPreloads.length)
    result.regressionPreloads = [...value.regressionPreloads]
  }
  if (value.regressionPattern !== undefined) {
    assert.equal(regressionRunner, 'unittest')
    assert.match(value.regressionPattern, /^[a-zA-Z0-9_*?][a-zA-Z0-9_.*?-]*\.py$/u)
    result.regressionPattern = value.regressionPattern
  }
  if (value.processEnvironment !== undefined) {
    assert(value.processEnvironment && typeof value.processEnvironment === 'object')
    assert(!Array.isArray(value.processEnvironment))
    for (const [name, setting] of Object.entries(value.processEnvironment)) {
      assert(
        [
          'NO_COLOR',
          'FORCE_COLOR',
          'CLICOLOR',
          'CLICOLOR_FORCE',
          'TERM',
          'TZ',
          'LANG',
          'LC_ALL',
          ...(node ? ['NODE_PATH'] : []),
        ].includes(name)
      )
      assert(setting === null || typeof setting === 'string')
      if (name === 'NODE_PATH' && setting !== null)
        for (const path of setting.split(delimiter)) {
          assert.match(path, /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/u)
          assert(!path.split('/').some((part) => ['.', '..'].includes(part)))
        }
    }
    result.processEnvironment = { ...value.processEnvironment }
  }
  if (value.baselineIssues !== undefined) {
    validateBaselineIssues(value.baselineIssues, regressionRunner)
    result.baselineIssues = value.baselineIssues
  }
  return result
}

// 只应用任务显式冻结的环境；Node 夹具模块路径相对各自工作区，参与者和评分配置相同。
export function applyTaskEnvironment(environment, target = process.env) {
  for (const [name, setting] of Object.entries(environment.processEnvironment ?? {})) {
    if (setting === null) delete target[name]
    else target[name] = setting
  }
}

// 基线、参与者和评分副本共用同一复制语义；相对链接保持相对，不能被改写回冻结源。
export async function copyTaskWorkspace(source, destination, runtime) {
  await cp(source, destination, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (path) =>
      ![
        '.git',
        '.pytest_cache',
        '__pycache__',
        ...(runtime === 'node' ? ['node_modules'] : []),
      ].includes(basename(path)),
  })
}

// 原项目测试可能分散在源码包中；逐层检查目标父目录，拒绝沿代理创建的链接写出评分副本。
export async function restoreTaskPaths(source, destination, paths) {
  for (const path of paths) {
    let parent = destination
    for (const part of path.split('/').slice(0, -1)) {
      parent = join(parent, part)
      const stat = await lstat(parent).catch((error) => {
        if (error.code !== 'ENOENT') throw error
        return null
      })
      assert(
        !stat || (stat.isDirectory() && !stat.isSymbolicLink()),
        'Untrusted restoration parent'
      )
      if (!stat) await mkdir(parent)
    }
    await rm(join(destination, path), { recursive: true, force: true })
    await cp(join(source, path), join(destination, path), {
      recursive: true,
      verbatimSymlinks: true,
    })
  }
}

// 使用项目自身的回归测试入口；新功能验收使用独立测试器。
export function regressionArguments(environment, report) {
  if (environment.runtime === 'node') {
    const runner = {
      'ava-tap': 'ava',
      'jest-json': 'jest',
      'vitest-json': 'vitest',
      'tap-json': 'tap',
    }[environment.regressionRunner]
    return runner
      ? [
          join(import.meta.dirname, `${runner}-runner.mjs`),
          environment.regressionEntry,
          ...environment.regression,
        ]
      : [environment.regressionEntry, '--reporter', 'json', ...environment.regression]
  }
  return environment.regressionRunner === 'unittest'
    ? [
        '-m',
        'unittest',
        'discover',
        '-s',
        environment.regression[0],
        ...(environment.regressionPattern ? ['-p', environment.regressionPattern] : []),
      ]
    : [
        '-m',
        'pytest',
        '-q',
        '--tb=short',
        '-p',
        'no:cacheprovider',
        ...(report ? ['--junitxml', report] : []),
        ...environment.regression,
      ]
}

// NODE_OPTIONS 同时传到测试器派生的 worker；不改变构建、验收或控制器自身的依赖装配。
export function regressionEnvironment(environment, base = process.env, workspace = process.cwd()) {
  const result = { ...base }
  if (environment.regressionPreloads?.length)
    result.NODE_OPTIONS = [
      base.NODE_OPTIONS,
      ...environment.regressionPreloads.map(
        (path) => `--require=${JSON.stringify(resolve(workspace, path))}`
      ),
    ]
      .filter(Boolean)
      .join(' ')
  return result
}

export function acceptanceArguments(environment, grader) {
  return environment.runtime === 'node'
    ? ['--test', '--test-reporter=tap', grader]
    : ['-m', 'pytest', '-q', '--tb=short', '-p', 'no:cacheprovider', grader]
}

// 同时支持根包和 src 布局；验收副本优先于环境中安装的项目包。
export function pythonTaskPath(workspace) {
  return [join(workspace, 'src'), workspace].join(delimiter)
}

// 给独占 venv 绑定当前检出；所有入口（含 Node 派生的 Python）都优先读取本次源码。
export async function bindPythonCheckout(python, workspace) {
  const result = await execute(python, [
    '-c',
    `import json, pathlib, sys, sysconfig
workspace = pathlib.Path(sys.argv[1]).resolve(strict=True)
prefix = pathlib.Path(sys.prefix).resolve()
site = pathlib.Path(sysconfig.get_path('purelib')).resolve()
if sys.prefix == sys.base_prefix or prefix not in site.parents:
    raise RuntimeError('Source binding requires a private virtual environment')
paths = [str(workspace / 'src'), str(workspace)]
target = site / '00-velaros-task-source.pth'
target.write_text('import sys; sys.path[:0] = ' + repr(paths) + '\\n', encoding='utf-8')
print(json.dumps(dict(file=str(target), paths=paths)))`,
    workspace,
  ])
  return JSON.parse(result.stdout)
}

// 执行可安装缺少的工具；每个参与者独占环境，评分继续使用原始冻结环境。
export async function createExecutionEnvironments({ source, taskRoot, participants, task }) {
  const environments = {}
  for (const participant of participants) {
    assert(['scriptact', 'codex'].includes(participant))
    assert(!environments[participant])
    const directory = join(taskRoot, `python-${participant}`)
    await mkdir(directory)
    await cp(source, directory, { recursive: true, verbatimSymlinks: true })
    const python = join(directory, 'bin/python')
    // venv 的激活脚本和命令入口含绝对路径，单纯复制会把 pip 安装写回原环境。
    await execute(join(source, 'bin/python'), ['-m', 'venv', '--without-pip', directory])
    for (const entry of await readdir(join(directory, 'bin'), { withFileTypes: true })) {
      if (!entry.isFile() || /^python[\d.]*$/u.test(entry.name)) continue
      const path = join(directory, 'bin', entry.name)
      const original = await readFile(path, 'utf8')
      const relocated = original.replace(/^#![^\r\n]*\/bin\/python[\d.]*\r?\n/u, `#!${python}\n`)
      if (relocated !== original) await writeFile(path, relocated)
    }
    environments[participant] = { python, prompt: taskPrompt(task, python) }
  }
  return environments
}

// 环境路径是双方唯一不同的任务附加信息；原始任务文本逐字保留。
export function taskPrompt(task, executable) {
  const baseline = task.environment?.baselineIssues
    ?.map((issue) => `${issue.test}: ${issue.reason} (${issue.source}).`)
    .join(' ')
  const tools =
    task.environment?.runtime === 'node'
      ? `Use ${executable} for Node.js; npm and the project's runtime and test dependencies are installed. The checkout's node_modules directory is private to your run; install any missing development tools there.`
      : `Use ${executable} for Python and pytest; the project's runtime and test dependencies are installed. This Python environment is private to your run; install any missing development tools there.`
  const preloads = task.environment?.regressionPreloads?.length
    ? ` For project tests, set NODE_OPTIONS to preload ${task.environment.regressionPreloads.join(', ')} with --require and each file's absolute path in this checkout; this keeps test workers on the project's dependency versions.`
    : ''
  return `${task.prompt}\n\nEnvironment: the repository checkout is your current working directory. ${tools}${preloads} Make source edits only inside this checkout. Do not inspect evaluation infrastructure, other attempts, private state or hidden acceptance tests. Use the development tools available to you and coordinate independent work if useful.${baseline ? `\n\nKnown unchanged-baseline failures: ${baseline} Run the complete suite and report these separately from any new failures. Keep the original tests and warning policy intact.` : ''}`
}
