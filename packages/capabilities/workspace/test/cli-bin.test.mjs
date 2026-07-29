/**
 * @test-meta
 * title: 工作区可执行入口
 * summary: 发布契约：验证工作区命令行可执行、帮助与版本信息。
 * area: packages
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { test } from 'bun:test'

const cliPath = new URL('../dist/cli.js', import.meta.url)
const cliFilePath = fileURLToPath(cliPath)

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'velaros-workspace-cli-bin-'))
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.writeFile(path.join(root, 'src/index.ts'), 'export const cliValue = 1\n')
  return root
}

async function withFixture(callback) {
  const root = await makeFixture()
  try {
    await callback(root)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

function runCli(args, cwd) {
  return spawnSync(process.execPath, [cliFilePath, ...args], {
    cwd,
    encoding: 'utf8',
  })
}

test('binary read command emits JSON envelope', async () => {
  await withFixture(async (root) => {
    const result = runCli(['read', 'src/index.ts', '--max-bytes', '2000', '--json'], root)
    assert.equal(result.status, 0)
    const parsed = JSON.parse(result.stdout)
    assert.equal(parsed.kind, 'velaros.workspaceCli.read')
    assert.match(parsed.result.content, /cliValue/)
  })
})

test('binary tools list defaults to JSON', async () => {
  await withFixture(async (root) => {
    const result = runCli(['tools', 'list'], root)
    assert.equal(result.status, 0)
    const parsed = JSON.parse(result.stdout)
    assert.equal(parsed.kind, 'velaros.workspaceCli.tools.list')
    assert.ok(parsed.result.tools.length > 0)
  })
})

test('public cli module import is side-effect-free', () => {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', `import ${JSON.stringify(cliPath.href)}`],
    {
      encoding: 'utf8',
    }
  )
  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
})

test('public cli module runner loads workspace runtime on demand', async () => {
  await withFixture(async (root) => {
    await fs.writeFile(path.join(root, 'package.json'), '{"name":"demo"}\n')
    await fs.writeFile(
      path.join(root, 'edit.json'),
      JSON.stringify({
        operations: [
          {
            operation: {
              type: 'json_patch',
              path: 'package.json',
              patches: [{ op: 'add', path: '/nested/value', value: 1 }],
            },
          },
        ],
      })
    )

    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
          import { runWorkspaceCli } from ${JSON.stringify(cliPath.href)}
          const result = await runWorkspaceCli(['commit-edit', '--input', 'edit.json', '--json'], { cwd: ${JSON.stringify(root)} })
          const parsed = JSON.parse(result.text)
          console.log(JSON.stringify({ exitCode: result.exitCode, status: parsed.status, code: parsed.error?.code, editStatus: parsed.result?.status }))
        `,
      ],
      { encoding: 'utf8' }
    )
    assert.equal(result.status, 0)
    assert.equal(result.stderr, '')
    assert.deepEqual(JSON.parse(result.stdout), {
      exitCode: 0,
      status: 'ok',
      editStatus: 'applied',
    })
  })
})

test('binary unknown command returns exit code 2', async () => {
  await withFixture(async (root) => {
    const result = runCli(['not-a-command', '--json'], root)
    assert.equal(result.status, 2)
    const parsed = JSON.parse(result.stderr)
    assert.equal(parsed.error.code, 'UNKNOWN_COMMAND')
  })
})
