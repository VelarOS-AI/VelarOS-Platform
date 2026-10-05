import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { relative, resolve } from 'node:path'

// Vitest 的 JSON 汇总不包含所有未处理异常；保留官方任务树和错误表的可序列化字段。
export function serializeVitest(files, errors, { workspace, finished, cancelled }) {
  const canonical = (path) => {
    try {
      return realpathSync(path)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return resolve(path)
    }
  }
  const errorData = (error) => ({
    message: String(error.message ?? error),
    stack: String(error.stack ?? ''),
  })
  const taskData = (task) => ({
    name: task.name,
    type: task.type,
    mode: task.mode,
    ...(task.result
      ? { result: { state: task.result.state, errors: (task.result.errors ?? []).map(errorData) } }
      : {}),
    ...(task.type === 'suite' ? { tasks: task.tasks.map(taskData) } : {}),
  })
  return {
    runner: 'vitest',
    version: 1,
    finished,
    cancelled,
    files: files.map((file) => ({
      ...taskData(file),
      path: relative(canonical(workspace), canonical(file.filepath)),
    })),
    unhandledErrors: errors.map(errorData),
  }
}

// 按逐例状态计数，保留收集、钩子和未处理异常；运行中、取消或不完整结果不能视作成功。
export function vitestReport(result) {
  const report = JSON.parse(result.stdout)
  assert.equal(report.runner, 'vitest')
  assert.equal(report.version, 1)
  assert.equal(report.finished, 1, 'Expected one completed Vitest run')
  assert.equal(report.cancelled, false, 'Vitest run was cancelled')
  assert(Array.isArray(report.files))
  assert(Array.isArray(report.unhandledErrors))
  const cases = []
  const occurrences = new Map()
  const counts = { passed: 0, failed: 0, skipped: 0, errors: 0 }
  function record(name, kind, errors = []) {
    assert(Array.isArray(errors))
    for (const error of errors) {
      assert.equal(typeof error.message, 'string')
      assert.equal(typeof error.stack, 'string')
    }
    const occurrence = (occurrences.get(name) ?? 0) + 1
    occurrences.set(name, occurrence)
    counts[kind ?? 'passed']++
    cases.push({
      id: `${name}::${occurrence}`,
      outcomes: kind
        ? [
            {
              kind: { failed: 'failure', skipped: 'skipped', errors: 'error' }[kind],
              message: errors.map((error) => error.message).join('\n'),
              text: errors.map((error) => error.stack).join('\n'),
            },
          ]
        : [],
    })
  }
  function visit(task, file, names, inheritedMode, parentFailed = false) {
    assert.equal(typeof task.name, 'string')
    assert(['suite', 'test'].includes(task.type), 'Unknown Vitest task type')
    assert(['run', 'only', 'skip', 'todo'].includes(task.mode), 'Unknown Vitest task mode')
    const mode = ['skip', 'todo'].includes(inheritedMode) ? inheritedMode : task.mode
    const notRun = parentFailed && !task.result && !['skip', 'todo'].includes(mode)
    const state = notRun ? 'fail' : (task.result?.state ?? mode)
    assert(['pass', 'fail', 'skip', 'todo'].includes(state), 'Incomplete Vitest task')
    assert(!['skip', 'todo'].includes(mode) || ['skip', 'todo'].includes(state))
    const errors = task.result?.errors ?? []
    assert(Array.isArray(errors))
    assert(!errors.length || state === 'fail', 'Successful Vitest task contains errors')
    const name = `${file}::${names.join(' ')}`
    if (task.type === 'test') {
      if (notRun) {
        record(name, 'errors', [
          { message: 'Test did not run after a parent suite error', stack: '' },
        ])
        return true
      }
      record(name, state === 'pass' ? null : state === 'fail' ? 'failed' : 'skipped', errors)
      return state === 'fail'
    }
    assert(Array.isArray(task.tasks))
    if (errors.length) record(`${name} [suite error]`, 'errors', errors)
    let failed = errors.length > 0
    for (const child of task.tasks)
      failed =
        visit(child, file, [...names, child.name], mode, parentFailed || errors.length > 0) ||
        failed
    assert(state !== 'pass' || !failed, 'Successful Vitest suite contains failures')
    if (state === 'fail' && !failed) {
      record(`${name} [suite error]`, 'errors', [{ message: 'Vitest suite failed', stack: '' }])
      failed = true
    }
    return failed
  }
  const files = new Set()
  for (const file of report.files) {
    assert.equal(typeof file.path, 'string')
    assert(file.path && !files.has(file.path), 'Duplicate Vitest file')
    assert.equal(file.type, 'suite')
    files.add(file.path)
    visit(file, file.path, [], undefined)
  }
  for (const error of report.unhandledErrors) record('[unhandled error]', 'errors', [error])
  return {
    cases,
    summary: {
      exitCode: result.exitCode,
      ...counts,
      summary: `${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped, ${counts.errors} errors`,
      failures: cases
        .filter((item) => item.outcomes.some((outcome) => outcome.kind !== 'skipped'))
        .map((item) => item.id),
    },
  }
}
