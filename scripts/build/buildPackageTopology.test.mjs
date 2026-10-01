import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'build-proof-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const runner = join(root, 'scripts/build/buildPackageTopology.mjs')
  await mkdir(dirname(runner), { recursive: true })
  await copyFile(new URL('./buildPackageTopology.mjs', import.meta.url), runner)
  const bin = join(root, 'bin')
  await mkdir(bin)
  await writeFile(join(bin, 'bun'), '#!/bin/sh\nmkdir -p dist\ncp source.js dist/index.js\n')
  await chmod(join(bin, 'bun'), 0o755)
  for (const name of ['core', 'app']) {
    const directory = join(root, 'packages', name)
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({
        name: `@velaros-ai/${name}`,
        scripts: { build: 'fixture' },
        dependencies: name === 'app' ? { '@velaros-ai/core': 'workspace:*' } : {},
      })
    )
    await writeFile(join(directory, 'source.js'), `export const name = '${name}'`)
  }
  execFileSync(process.execPath, [runner], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  })
  const { withVerifiedPackageBuilds } = await import(pathToFileURL(runner).href)
  return {
    root,
    verify: (consume = async (proof) => proof) => withVerifiedPackageBuilds(['app'], consume),
  }
}

test('pack proof verifies the real build dependency closure and excludes concurrent builds', async (t) => {
  const { root, verify } = await fixture(t)
  const proof = await verify(async (proof) => {
    assert.equal(
      await readFile(join(root, '.velaros-workspace/package-build.lock'), 'utf8'),
      `${process.pid}\n`
    )
    await assert.rejects(verify(), /正在运行/)
    return proof
  })
  assert.deepEqual(Object.keys(proof), ['@velaros-ai/core', '@velaros-ai/app'])
  assert.match(proof['@velaros-ai/app'].outputFingerprint, /^[a-f0-9]{64}$/)
  await assert.rejects(readFile(join(root, '.velaros-workspace/package-build.lock')), {
    code: 'ENOENT',
  })
})

test('pack rejects stale source, stale output and changed dependencies', async (t) => {
  for (const changed of [
    'packages/app/source.js',
    'packages/app/dist/index.js',
    'packages/core/source.js',
  ]) {
    await t.test(changed, async (t) => {
      const { root, verify } = await fixture(t)
      await writeFile(join(root, changed), 'changed')
      await assert.rejects(verify(), /Stale or unverified build/)
    })
  }
})

test('pack rejects edits during consumption and releases the lock after failure', async (t) => {
  const { root, verify } = await fixture(t)
  await assert.rejects(
    verify(async () => {
      await writeFile(join(root, 'packages/app/source.js'), 'changed while packing')
    }),
    /Stale or unverified build/
  )
  await assert.rejects(readFile(join(root, '.velaros-workspace/package-build.lock')), {
    code: 'ENOENT',
  })
})
