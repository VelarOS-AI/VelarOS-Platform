#!/usr/bin/env node
// 发布身份预检:在跑质量门与真发布之前,先把「这次发布是什么」钉死。
//
// 挡什么:发布 16 个包到 GitHub Packages 不可逆(同一版本号不能重发成别的内容)。所以在花掉
// build + check 的时间之前,先在这里失败掉三类问题:
//   ① 发布内容——collectReleasePackages 核对发布集合与 velaros.domainPackages、以及各包
//      manifest 版本与 bun.lock 是否一致(见 releaseTopology.mjs 的不变量 ①②);
//   ② 源码身份——GITHUB_SHA 必须是 40 位完整 commit;
//   ③ 触发身份——只认 push / workflow_dispatch,且 ref 必须是精确的 refs/tags/v<仓根火车版本号>。
// ① 先跑不是因为它更重要,而是 expectedTag 要从同一次仓根 manifest 读取里取(那次读顺带就把
// 发布集合校验完了);三条都是硬门,任何一条不成立都在 build 之前就退出。
//
// 谁核验它:kernel / agent 两域的 check:*-arch「防线:发布身份」按字面标记核对本文件与
// publish-packages.mjs、release-packages.yml 三者(rule=release-artifact-identity)。
// 下面 expectedTag / eventName / refType / ref / refName 五处判据是被逐条核验的标记,改写法要同时改门。

import { resolve } from 'node:path'

import { collectReleasePackages, resolveReleaseSelection } from './releaseTopology.mjs'

const repoRoot = resolve(import.meta.dirname, '../..')
const { rootManifest, platformGeneration, ordered } = await collectReleasePackages(repoRoot)
const eventName = process.env.GITHUB_EVENT_NAME
const ref = process.env.GITHUB_REF
const refType = process.env.GITHUB_REF_TYPE
const refName = process.env.GITHUB_REF_NAME
const sourceSha = process.env.GITHUB_SHA
const selection = resolveReleaseSelection(rootManifest, ordered, refName)

if (!sourceSha || !/^[a-f0-9]{40}$/u.test(sourceSha)) {
  throw new Error('GITHUB_SHA must identify the exact 40-character source commit')
}

// ref 与 refName 必须互相印证:两者都来自环境变量,只信其中一个等于把身份判据交给
// 单一可伪造输入。tag 形态本身由 resolveReleaseSelection 判(整列 v<火车号> 或 <包>@<版本>)。
if (
  !['push', 'workflow_dispatch'].includes(eventName)
  || refType !== 'tag'
  || ref !== `refs/tags/${refName}`
  || selection.kind === 'unknown'
) {
  throw new Error(
    `Package releases require a tag naming what ships (${selection.reason ?? 'ref is not a tag'}); received ${eventName ?? 'unknown'} ${ref ?? 'unknown'}`,
  )
}

console.info(`✓ release source: ${sourceSha}`)
console.info(`✓ release ref: ${ref}`)
console.info(`✓ platform generation: ${platformGeneration}`)
console.info(
  `✓ release contents: ${selection.kind} — ${selection.packages.length} of ${ordered.length} declared packages`,
)
for (const item of selection.packages) {
  console.info(`  · ${item.manifest.name}@${item.manifest.version}`)
}
