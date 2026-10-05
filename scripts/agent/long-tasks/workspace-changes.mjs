import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)

// 从任务起点核对最终工作树，包含模型自行提交、暂存与未暂存的改动。
export async function workspaceChanges(workspace, baseline) {
  const git = async (...args) =>
    (await execute('git', args, { cwd: workspace, maxBuffer: 8_000_000 })).stdout
  let source = 'recorded-baseline'
  if (!baseline) {
    const roots = (await git('rev-list', '--max-parents=0', 'HEAD')).trim().split('\n')
    assert.equal(roots.length, 1, 'Task baseline must have one root commit')
    baseline = roots[0]
    assert.equal(
      (await git('show', '-s', '--format=%s', baseline)).trim(),
      'Frozen task baseline',
      'Historical task root must be the evaluator baseline'
    )
    source = 'verified-historical-root'
  }
  assert(
    /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(baseline),
    'Expected a full baseline commit identity'
  )
  const head = (await git('rev-parse', 'HEAD')).trim()
  const [changed, added, untracked] = await Promise.all([
    git('diff', '--no-ext-diff', '--no-renames', '--numstat', '--diff-filter=MDT', baseline, '--'),
    git(
      'diff',
      '--no-ext-diff',
      '--no-renames',
      '--name-only',
      '-z',
      '--diff-filter=A',
      baseline,
      '--'
    ),
    git('ls-files', '--others', '--exclude-standard', '-z'),
  ])
  const createdPaths = [
    ...new Set([...added.split('\0'), ...untracked.split('\0')].filter(Boolean)),
  ].sort()
  return {
    changed,
    created: createdPaths.length ? createdPaths.join('\n') + '\n' : '',
    changeAccounting: {
      baseline,
      head,
      source,
      changedFiles: changed.trim() ? changed.trim().split('\n').length : 0,
      createdFiles: createdPaths.length,
      includesCommittedChanges: true,
      // 与旧计数一样，只计 Git 可见产物；忽略文件和产物的业务相关性不在此推断。
      scope: 'baseline tracked changes and all non-ignored created paths',
    },
  }
}
