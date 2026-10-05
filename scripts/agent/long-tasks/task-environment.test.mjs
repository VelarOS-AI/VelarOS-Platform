import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import {
  createExecutionEnvironments,
  createTaskRoot,
  copyTaskWorkspace,
  bindPythonCheckout,
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

test('workspace copies preserve relative and dangling links without writing back into earlier copies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'velaros-copy-isolation-'))
  try {
    const source = join(directory, 'source')
    const participant = join(directory, 'participant')
    const judge = join(directory, 'judge')
    await mkdir(join(source, 'fixtures/data'), { recursive: true })
    await writeFile(join(source, 'fixtures/data/file'), 'original')
    await symlink('data', join(source, 'fixtures/link'))
    await symlink('missing', join(source, 'fixtures/dangling'))
    for (const name of ['.git', '.pytest_cache', '__pycache__', 'node_modules']) {
      await mkdir(join(source, name))
      await writeFile(join(source, name, 'marker'), name)
    }
    await copyTaskWorkspace(source, participant, 'node')
    await copyTaskWorkspace(participant, judge, 'node')
    for (const copy of [participant, judge]) {
      assert.equal(await readlink(join(copy, 'fixtures/link')), 'data')
      assert.equal(await readlink(join(copy, 'fixtures/dangling')), 'missing')
      assert.equal(await readFile(join(copy, 'fixtures/link/file'), 'utf8'), 'original')
      for (const name of ['.git', '.pytest_cache', '__pycache__', 'node_modules'])
        await assert.rejects(stat(join(copy, name)), { code: 'ENOENT' })
    }
    await writeFile(join(participant, 'fixtures/link/file'), 'participant')
    await rm(join(judge, 'fixtures/link/file'))
    assert.equal(await readFile(join(source, 'fixtures/data/file'), 'utf8'), 'original')
    assert.equal(await readFile(join(participant, 'fixtures/data/file'), 'utf8'), 'participant')
    await assert.rejects(stat(join(judge, 'fixtures/data/file')), { code: 'ENOENT' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('new task roots use the process ownership without changing their parent directory', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'velaros-task-parent-'))
  const before = await stat(parent)
  try {
    const root = await createTaskRoot(join(parent, 'isolated-'))
    const created = await stat(root)
    assert(created.isDirectory())
    if (typeof process.getuid === 'function') {
      assert.equal(created.uid, process.getuid())
      assert.equal(created.gid, process.getgid())
    }
    const after = await stat(parent)
    assert.equal(after.uid, before.uid)
    assert.equal(after.gid, before.gid)
    assert.equal(after.mode, before.mode)
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

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

test('participant imports use its checkout even when a different project version is installed', async (t) => {
  const execute = promisify(execFile)
  const root = await realpath(await mkdtemp(join(tmpdir(), 'velaros-source-binding-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'frozen')
  await execute('python3', ['-m', 'venv', '--without-pip', source])
  const site = (
    await execute(join(source, 'bin/python'), [
      '-c',
      "import sysconfig; print(sysconfig.get_path('purelib'))",
    ])
  ).stdout.trim()
  await writeFile(join(site, 'shadow_fixture.py'), "value = 'installed'\n")
  const environments = await createExecutionEnvironments({
    source,
    taskRoot: root,
    participants: ['scriptact', 'codex'],
    task: { prompt: 'Work in the checkout.' },
  })
  for (const [participant, value] of Object.entries(environments)) {
    const workspace = join(root, participant, 'project')
    await mkdir(join(workspace, 'src'), { recursive: true })
    await mkdir(join(workspace, 'tools'))
    await writeFile(join(workspace, 'src/shadow_fixture.py'), `value = '${participant}'\n`)
    const before = await execute(
      value.python,
      ['-c', 'import shadow_fixture; print(shadow_fixture.value)'],
      { cwd: workspace }
    )
    assert.equal(before.stdout.trim(), 'installed')
    const binding = await bindPythonCheckout(value.python, workspace)
    assert(binding.file.startsWith(join(root, `python-${participant}`)))
    // 换到子目录仍能看到源码，且更换工作区后不会去另一个参与者的检出中导入。
    const after = await execute(
      process.execPath,
      [
        '-e',
        `const {execFileSync}=require('node:child_process');process.stdout.write(execFileSync(process.argv[1],['-c','import shadow_fixture; print(shadow_fixture.value); print(shadow_fixture.__file__)']));`,
        value.python,
      ],
      { cwd: join(workspace, 'tools') }
    )
    assert.equal(after.stdout.trim(), `${participant}\n${join(workspace, 'src/shadow_fixture.py')}`)
  }
  const original = await execute(join(source, 'bin/python'), [
    '-c',
    'import shadow_fixture; print(shadow_fixture.value)',
  ])
  assert.equal(original.stdout.trim(), 'installed')
  await assert.rejects(bindPythonCheckout('python3', root), /private virtual environment/u)
})
