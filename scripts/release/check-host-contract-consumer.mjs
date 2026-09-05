#!/usr/bin/env node
// 用真实 tarball 验证宿主窄端口与浏览器契约；消费目录不继承仓库类型环境。

import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { runGuardedCommand, safePackPackage } from './safe-package-pack.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const fixtureDirectory = path.join(import.meta.dirname, 'fixtures', 'host-contract-consumer')
const packageDirectories = ['agent', 'model', 'computer', 'memory', 'development', 'project', 'core', 'kernel']
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const nodeTypesVersion = manifest.devDependencies?.['@types/node']
if (!nodeTypesVersion) throw new Error('Host contract consumer requires root @types/node declaration')
const bunVersion = (await runGuardedCommand({
  command: 'bun', args: ['--version'], cwd: root, operation: 'Read consumer Bun version',
})).stdout.trim()
if (manifest.packageManager !== `bun@${bunVersion}`) {
  throw new Error(`Host contract consumer requires ${manifest.packageManager}, received bun@${bunVersion}`)
}

const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'velaros-host-contract-consumer-'))
try {
  const tarballDirectory = path.join(temporaryRoot, 'packages')
  const consumerDirectory = path.join(temporaryRoot, 'consumer')
  await mkdir(tarballDirectory)
  await mkdir(consumerDirectory)
  const dependencies = {}
  const packedManifests = []
  for (const directoryName of packageDirectories) {
    const packageDirectory = path.join(root, 'packages', directoryName)
    const packageManifest = JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8'))
    const tarballPath = path.join(tarballDirectory, `${directoryName}.tgz`)
    await safePackPackage({ packageDirectory, filename: tarballPath })
    dependencies[packageManifest.name] = `file:${tarballPath}`
    packedManifests.push(packageManifest)
    console.info(`✓ packed host contract dependency ${packageManifest.name}@${packageManifest.version}`)
  }
  // 每一条第一方运行/类型依赖都必须来自本次打包，避免注册表旧包掩盖候选声明问题。
  for (const packageManifest of packedManifests) {
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const name of Object.keys(packageManifest[field] ?? {})) {
        if (name.startsWith('@velaros-ai/') && !Object.hasOwn(dependencies, name)) {
          throw new Error(`${packageManifest.name} ${field}.${name} is missing from the packed consumer closure`)
        }
      }
    }
  }
  await writeFile(path.join(consumerDirectory, 'package.json'), `${JSON.stringify({
    name: 'velaros-host-contract-consumer',
    private: true,
    type: 'module',
    dependencies: { ...dependencies, '@types/node': nodeTypesVersion },
    overrides: dependencies,
  }, null, 2)}\n`)
  for (const file of [
    'consumer.ts',
    'browser.ts',
    'model-structured-output.ts',
    'runtime.mjs',
    'tsconfig.json',
  ]) {
    await copyFile(path.join(fixtureDirectory, file), path.join(consumerDirectory, file))
  }
  await runGuardedCommand({
    command: 'bun', args: ['install', '--ignore-scripts'], cwd: consumerDirectory,
    operation: 'Install isolated host contract tarballs', stdio: 'inherit',
  })
  await runGuardedCommand({
    command: process.execPath,
    args: [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '--project', 'tsconfig.json'],
    cwd: consumerDirectory, operation: 'Strict NodeNext public host declarations', stdio: 'inherit',
  })
  await runGuardedCommand({
    command: 'bun', args: ['build', './browser.ts', '--target=browser', '--outdir=browser-dist'],
    cwd: consumerDirectory, operation: 'Browser Computer contracts bundle', stdio: 'inherit',
  })
  await runGuardedCommand({
    command: process.execPath, args: ['runtime.mjs'], cwd: consumerDirectory,
    operation: 'Execute packed host runtime contracts', stdio: 'inherit',
  })
  console.info('✓ packed host contracts: isolated install, strict NodeNext declarations, browser bundle and runtime execution')
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
