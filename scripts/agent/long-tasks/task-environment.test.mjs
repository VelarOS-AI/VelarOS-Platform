import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import {
  createExecutionEnvironments,
  pythonTaskPath,
  regressionArguments,
  restoreTaskPaths,
  taskEnvironment,
} from './task-environment.mjs'

const environment = {
  project: 'example',
  python: 'python-example',
  acceptance: 'test_example_acceptance.py',
  regression: ['tests/unit', 'tests/integration'],
  preserve: ['tests', 'pyproject.toml'],
  baselineFailure: 'Feature is not implemented',
}

test('task configuration supports different repositories and src imports without changing the evaluator', () => {
  assert.deepEqual(taskEnvironment({ environment }), { ...environment, regressionRunner: 'pytest' })
  assert.equal(
    pythonTaskPath('/workspace/example'),
    [join('/workspace/example', 'src'), '/workspace/example'].join(delimiter)
  )
})

test('regression uses each project test runner with a bounded directory selection', () => {
  const config = taskEnvironment({
    environment: { ...environment, regression: ['tests'], regressionRunner: 'unittest' },
  })
  assert.deepEqual(regressionArguments(config), ['-m', 'unittest', 'discover', '-s', 'tests'])
  assert.deepEqual(regressionArguments(taskEnvironment({ environment })), [
    '-m',
    'pytest',
    '-q',
    '--tb=short',
    '-p',
    'no:cacheprovider',
    'tests/unit',
    'tests/integration',
  ])
  assert.throws(() =>
    taskEnvironment({ environment: { ...environment, regressionRunner: 'unittest' } })
  )
  assert.throws(() =>
    taskEnvironment({ environment: { ...environment, regressionRunner: 'shell' } })
  )
})

test('grader restoration cannot select the checkout root, git metadata or another directory', () => {
  for (const path of ['.', '..', '../other', '/tmp', '.git', 'tests/../source', '-force'])
    assert.throws(() => taskEnvironment({ environment: { ...environment, preserve: [path] } }))
  assert.throws(() =>
    taskEnvironment({ environment: { ...environment, regression: ['../outside'] } })
  )
  assert.throws(() => taskEnvironment({ environment: { ...environment, regression: ['-c'] } }))
  assert.throws(() => taskEnvironment({ environment: { ...environment, project: '../outside' } }))
  assert.throws(() =>
    taskEnvironment({ environment: { ...environment, acceptance: '../hidden.py' } })
  )
})

test('nested test restoration preserves edited code and refuses a symlink parent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'velaros-test-restore-'))
  const source = join(root, 'source')
  const judge = join(root, 'judge')
  const outside = join(root, 'outside')
  try {
    await mkdir(join(source, 'pkg/tests'), { recursive: true })
    await mkdir(join(judge, 'pkg'), { recursive: true })
    await mkdir(outside)
    await writeFile(join(source, 'pkg/tests/test_api.py'), 'frozen test')
    await writeFile(join(judge, 'pkg/api.py'), 'changed implementation')
    await writeFile(join(outside, 'sentinel'), 'keep')
    await restoreTaskPaths(source, judge, ['pkg/tests'])
    assert.equal(await readFile(join(judge, 'pkg/api.py'), 'utf8'), 'changed implementation')
    assert.equal(await readFile(join(judge, 'pkg/tests/test_api.py'), 'utf8'), 'frozen test')
    await rm(join(judge, 'pkg'), { recursive: true })
    await symlink(outside, join(judge, 'pkg'))
    await assert.rejects(
      restoreTaskPaths(source, judge, ['pkg/tests']),
      /Untrusted restoration parent/u
    )
    assert.equal(await readFile(join(outside, 'sentinel'), 'utf8'), 'keep')
    await assert.rejects(readFile(join(outside, 'tests/test_api.py')), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('participant Python commands install only into their own environment while grading dependencies stay frozen', async () => {
  const execute = promisify(execFile)
  const root = await realpath(await mkdtemp(join(tmpdir(), 'velaros-python-isolation-')))
  const source = join(root, 'frozen')
  try {
    await execute('python3', ['-m', 'venv', '--without-pip', source])
    await writeFile(
      join(source, 'bin', 'install-fixture'),
      `#!${join(source, 'bin/python')}\nimport pathlib, sys\npathlib.Path(sys.prefix, 'installed-fixture').write_text('installed')\n`,
      { mode: 0o755 }
    )
    const task = { prompt: 'Complete the entire project task.' }
    const environments = await createExecutionEnvironments({
      source,
      taskRoot: root,
      participants: ['scriptact', 'codex'],
      task,
    })
    await execute(join(root, 'python-scriptact/bin/install-fixture'))
    assert.equal(
      await readFile(join(root, 'python-scriptact/installed-fixture'), 'utf8'),
      'installed'
    )
    await assert.rejects(readFile(join(source, 'installed-fixture')), { code: 'ENOENT' })
    await assert.rejects(readFile(join(root, 'python-codex/installed-fixture')), { code: 'ENOENT' })
    for (const [participant, value] of Object.entries(environments)) {
      const prefix = (
        await execute(value.python, ['-c', 'import sys; print(sys.prefix)'])
      ).stdout.trim()
      assert.equal(prefix, join(root, `python-${participant}`))
      assert(value.prompt.startsWith(task.prompt + '\n\n'))
      assert((await readFile(join(prefix, 'bin/activate'), 'utf8')).includes(prefix))
    }
    assert.equal(
      environments.scriptact.prompt.replace(environments.scriptact.python, '<python>'),
      environments.codex.prompt.replace(environments.codex.python, '<python>')
    )
    await assert.rejects(
      createExecutionEnvironments({ source, taskRoot: root, participants: ['scriptact'], task }),
      { code: 'EEXIST' }
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
