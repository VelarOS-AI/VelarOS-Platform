#!/usr/bin/env node
// 本机发布身份预检：在质量门与真发布之前，把「从哪个官方 tag 发布什么」钉死。
//
// 挡什么：发布到 GitHub Packages 不可逆（同一版本号不能重发成别的内容）。因此预检同时
// 核验发布集合、manifest 与 bun.lock 版本、平台代、官方 origin、干净工作树，以及本地和
// 远端 tag 对象/peeled commit 都精确指向当前 HEAD。它只接受显式 --local-tag，不读取任何
// 托管运行器身份变量，也不会安装、构建或发布。

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

import {
  assertLocalReleaseIdentity,
  parseReleaseArguments,
} from './local-release-identity.mjs'
import { collectReleasePackages, resolveReleaseSelection } from './releaseTopology.mjs'

const repoRoot = resolve(import.meta.dirname, '../..')
const { dryRun, skipBuild, localTag, onlySelectors } = parseReleaseArguments(
  process.argv.slice(2),
)
if (dryRun || skipBuild || onlySelectors.length > 0) {
  throw new Error('release:verify accepts exactly one local tag and no publication selectors')
}

const runForOutput = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with exit code ${result.status}: ${result.stderr.trim()}`,
    )
  }
  return result.stdout.trim()
}

const { rootManifest, platformGeneration, ordered } = await collectReleasePackages(repoRoot)
const selection = resolveReleaseSelection(rootManifest, ordered, localTag)
if (selection.kind === 'unknown') {
  throw new Error(`Unknown local release tag ${localTag}: ${selection.reason}`)
}
const identity = assertLocalReleaseIdentity({
  root: repoRoot,
  tag: localTag,
  repository: rootManifest.repository,
  runForOutput,
})

console.info(`✓ release source: ${identity.sourceSha}`)
console.info(`✓ release tag: ${identity.tag}`)
console.info(`✓ release repository: ${identity.repository}`)
console.info(`✓ platform generation: ${platformGeneration}`)
console.info(
  `✓ release contents: ${selection.kind} — ${selection.packages.length} of ${ordered.length} declared packages`,
)
for (const item of selection.packages) {
  console.info(`  · ${item.manifest.name}@${item.manifest.version}`)
}
