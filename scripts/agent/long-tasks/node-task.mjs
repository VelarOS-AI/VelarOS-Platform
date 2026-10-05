import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { cp, lstat, readFile, readdir, readlink } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)

// 依赖指纹包含文件内容、执行权限和链接原文；链接只能指向本任务副本内部。
export async function nodeDependencyState(workspace, node) {
  const hash = createHash('sha256')
  let files = 0
  async function visit(path) {
    const stat = await lstat(path)
    const name = relative(workspace, path)
    hash.update(JSON.stringify([name, stat.mode & 0o777]))
    if (stat.isSymbolicLink()) {
      const target = await readlink(path)
      const location = relative(workspace, resolve(path, '..', target))
      assert(
        !isAbsolute(target) && location !== '..' && !location.startsWith(`..${sep}`),
        'Dependency link escapes checkout'
      )
      hash.update(JSON.stringify(['link', target]))
      files++
    } else if (stat.isDirectory()) {
      hash.update('directory')
      for (const entry of (await readdir(path)).sort()) await visit(join(path, entry))
    } else {
      assert(stat.isFile(), 'Unsupported dependency entry')
      hash.update(JSON.stringify(['file', stat.size]))
      for await (const chunk of createReadStream(path)) hash.update(chunk)
      files++
    }
  }
  await visit(join(workspace, 'node_modules'))
  return {
    node,
    nodeVersion: (await execute(node, ['--version'])).stdout.trim(),
    npmVersion: (await execute('npm', ['--version'])).stdout.trim(),
    nodeSha256: createHash('sha256')
      .update(await readFile(node))
      .digest('hex'),
    dependencySha256: hash.digest('hex'),
    files,
  }
}

// 独立实体副本允许参与者安装工具；评分副本始终从冻结源恢复依赖。
export async function copyNodeDependencies(source, destination) {
  const path = join(destination, 'node_modules')
  await assert.rejects(lstat(path), { code: 'ENOENT' }, 'Dependency destination must be new')
  await cp(join(source, 'node_modules'), path, {
    recursive: true,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
  })
}

// 项目测试可向 stdout 打印诊断；只提取一个完整的官方 JSON reporter 文档。
function mochaDocument(stdout) {
  const starts = [...stdout.matchAll(/^\{\s*"stats"\s*:/gmu)]
  assert.equal(starts.length, 1, 'Expected one complete Mocha JSON report')
  const start = starts[0].index
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = start; index < stdout.length; index++) {
    const char = stdout[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
    } else if (char === '"') quoted = true
    else if (char === '{') depth++
    else if (char === '}' && --depth === 0) return JSON.parse(stdout.slice(start, index + 1))
  }
  assert.fail('Incomplete Mocha JSON report')
}

// 使用 Mocha 的完整 JSON 报告核对计数与逐例清单，拒绝空套件、矛盾统计和遗漏用例。
export function mochaReport(result, workspace) {
  const report = mochaDocument(result.stdout)
  const outcomes = new Map()
  for (const [field, kind] of [
    ['passes', null],
    ['failures', 'failure'],
    ['pending', 'skipped'],
  ]) {
    assert(Array.isArray(report[field]))
    assert.equal(report.stats[field], report[field].length)
    for (const item of report[field]) {
      const key = JSON.stringify(item)
      const values = outcomes.get(key) ?? []
      values.push(
        kind ? [{ kind, message: item.err?.message ?? '', text: item.err?.stack ?? '' }] : []
      )
      outcomes.set(key, values)
    }
  }
  assert.equal(report.stats.tests, report.tests.length)
  const occurrences = new Map()
  function nextId(item) {
    assert.equal(typeof item.fullTitle, 'string')
    const name = `${item.file ? relative(workspace, item.file) : ''}::${item.fullTitle}`
    const occurrence = (occurrences.get(name) ?? 0) + 1
    occurrences.set(name, occurrence)
    return `${name}::${occurrence}`
  }
  const cases = report.tests.map((item) => {
    const values = outcomes.get(JSON.stringify(item))
    assert(values?.length, 'Mocha test missing from outcomes')
    return { id: nextId(item), outcomes: values.shift() }
  })
  // before/after hook 失败会进入 failures，但不会发出 test-end，因而不在 tests 数组中。
  for (const [key, values] of outcomes)
    for (const value of values) {
      assert(
        value.length === 1 && value[0].kind === 'failure',
        'Mocha outcome missing from test inventory'
      )
      cases.push({ id: nextId(JSON.parse(key)), outcomes: value })
    }
  return {
    cases,
    summary: {
      exitCode: result.exitCode,
      passed: report.passes.length,
      failed: report.failures.length,
      skipped: report.pending.length,
      errors: 0,
      summary: `${report.passes.length} passed, ${report.failures.length} failed, ${report.pending.length} skipped`,
      failures: cases
        .filter((item) => item.outcomes.some((value) => value.kind === 'failure'))
        .map((item) => item.id),
    },
  }
}

// Node 自带测试器的 TAP 尾部是固定计数；崩溃或无测试不能被当作验收成功。
export function nodeTestSummary(result) {
  const text = result.stdout ?? ''
  const count = (name) => Number(text.match(new RegExp(`^# ${name} (\\d+)$`, 'mu'))?.[1] ?? 0)
  const tests = count('tests')
  const passed = count('pass'),
    failed = count('fail'),
    skipped = count('skipped'),
    todo = count('todo')
  const errors =
    count('cancelled') +
    (tests > 0 && tests === passed + failed + skipped + todo + count('cancelled') ? 0 : 1)
  return {
    exitCode: result.exitCode,
    passed,
    failed,
    skipped: skipped + todo,
    errors,
    summary: `${passed} passed, ${failed} failed, ${skipped + todo} skipped, ${errors} errors`,
    failures: text.split('\n').filter((line) => /^not ok /u.test(line)),
  }
}
