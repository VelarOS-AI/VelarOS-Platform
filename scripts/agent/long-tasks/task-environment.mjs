import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'

import { validateBaselineIssues } from './regression.mjs'

const execute = promisify(execFile)

// 评测项目、依赖环境和验收命令在请求模型之前固定；这里只接受工作区内相对路径。
export function taskEnvironment(task) {
  const value = task.environment
  assert(value && typeof value === 'object', 'Task must declare its frozen environment')
  const { project, python, acceptance, regression, preserve, baselineFailure } = value
  const regressionRunner = value.regressionRunner ?? 'pytest'
  assert(['pytest', 'unittest'].includes(regressionRunner))
  if (regressionRunner === 'unittest') assert.equal(regression.length, 1)
  for (const name of [project, python]) assert.match(name, /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u)
  assert.match(acceptance, /^test_[a-zA-Z0-9_]+\.py$/u)
  for (const paths of [regression, preserve]) {
    assert(Array.isArray(paths) && paths.length > 0)
    for (const path of paths) {
      assert.equal(typeof path, 'string')
      assert.match(path, /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/u)
      assert(!path.split('/').some((part) => ['.', '..', '.git'].includes(part)))
      assert(!path.startsWith('-'))
    }
    assert.equal(new Set(paths).size, paths.length)
  }
  assert.equal(typeof baselineFailure, 'string')
  assert(baselineFailure.length > 0)
  const result = {
    project,
    python,
    acceptance,
    regression,
    regressionRunner,
    preserve,
    baselineFailure,
  }
  if (value.regressionPattern !== undefined) {
    assert.equal(regressionRunner, 'unittest')
    assert.match(value.regressionPattern, /^[a-zA-Z0-9_*?][a-zA-Z0-9_.*?-]*\.py$/u)
    result.regressionPattern = value.regressionPattern
  }
  if (value.baselineIssues !== undefined) {
    validateBaselineIssues(value.baselineIssues, regressionRunner)
    result.baselineIssues = value.baselineIssues
  }
  return result
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

// 使用项目自身的回归测试入口；新功能验收单独使用 pytest。
export function regressionArguments(environment, report) {
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

// 同时支持根包和 src 布局；验收副本优先于环境中安装的项目包。
export function pythonTaskPath(workspace) {
  return [join(workspace, 'src'), workspace].join(delimiter)
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
export function taskPrompt(task, python) {
  const baseline = task.environment?.baselineIssues
    ?.map((issue) => `${issue.test}: ${issue.reason} (${issue.source}).`)
    .join(' ')
  return `${task.prompt}\n\nEnvironment: the repository checkout is your current working directory. Use ${python} for Python and pytest; the project's runtime and test dependencies are installed. This Python environment is private to your run; install any missing development tools there. Make source edits only inside this checkout. Do not inspect evaluation infrastructure, other attempts, private state or hidden acceptance tests. Use the development tools available to you and coordinate independent work if useful.${baseline ? `\n\nKnown unchanged-baseline failures: ${baseline} Run the complete suite and report these separately from any new failures. Keep the original tests and warning policy intact.` : ''}`
}
