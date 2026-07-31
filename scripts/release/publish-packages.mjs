#!/usr/bin/env node
// 单版本火车的发布器:一次把 packages/ 下全部已声明的包按依赖拓扑打包并发到 GitHub Packages。
//
// 从哪读起:发布集合与顺序不在本文件里判——那是 releaseTopology.mjs(唯一事实来源)的活。
// 本文件只负责三件事,顺序不可换:
//   ① **身份**:把这批 tarball 绑死到一个精确的源码身份(HEAD SHA + GITHUB_SHA + refs/tags/v<火车号>)
//      与一棵干净的工作树;
//   ② **打包并验明**:每个包 pack 出**恰好一个** tarball,记下 size + sha256,并断言构建产物真的进了包;
//   ③ **发布那一份已验明的 tarball**(而不是让 registry 重新从工作树打包)。
//
// 关键不变量:发布的字节 == 被记录 sha256 的字节 == 由这个 SHA 的源码构建出来的字节。
// 破坏方式:任何在 ② 与 ③ 之间重新 pack、或者改成 `bun publish`(不带 tarball 路径)直接发目录,
// 都会让 artifact 日志里的 sha256 变成一句无法核对的漂亮话。
//
// 为什么是一份而不是七份:七个源仓各带一份 publish-packages.mjs,并仓后 agent / capabilities /
// core / kernel / memory / ui 六份已经在枚举同一个 packages/、跑同一套校验(纯格式分叉);
// model 那份还是并仓前的单包形态(只发 packages/model),它独有的两条护栏已经并进来:
//   · **tag ref 三元核验**(GITHUB_REF_TYPE / REF_NAME / REF 同时等于那个 tag)——另外六份只把
//     `v${rootManifest.version}` 当标签**写进日志**,从不核验运行时 ref 真的是它;
//   · **publishConfig.access 必须显式声明**——但不钉死成 'restricted'(html-artifacts 声明的是
//     'public'),且改为按各包声明值传 --access,不再像七份旧脚本那样硬写 restricted 覆盖 manifest。
// model 独有的第三条(「包版本 == 仓根 version」)是并仓前的锁步假设,火车形态下不成立,
// 处置理由见 releaseTopology.mjs 文件头。
//
// dry-run 的边界:--dry-run 放行「干净工作树 / GITHUB_SHA / tag ref / NODE_AUTH_TOKEN」四条
// **发布期**前置(七份旧脚本里干净工作树是无条件的,导致本地 dry-run 在有改动时永远跑不起来,
// 而 dry-run 的用处恰恰是改完发布链之后先验一遍)。这四条在真发布路径上一条不减。
//
// 谁核验它:kernel / agent 两域的 check:*-arch「防线:发布身份」按字面标记核对本文件与
// verify-release-ref.mjs、release-packages.yml 三者(rule=release-artifact-identity)。
// 被核验的标记 = git rev-parse / git status --porcelain --untracked-files=all / bun pm pack 的参数 /
// artifact 里的 sourceSha·fileName·sizeBytes·sha256 / publish 的第一参数是 tarballPath。
// 改这些写法要同时改门,别加豁免。

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { collectReleasePackages, ReleaseRegistry } from './releaseTopology.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const dryRun = process.argv.includes('--dry-run')
const skipBuild = process.argv.includes('--skip-build')

const runForOutput = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: process.env })
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with exit code ${result.status}: ${result.stderr.trim()}`,
    )
  }
  return result.stdout.trim()
}
const run = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, env: process.env, stdio: 'inherit' })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`)
  }
}

const { rootManifest, ordered } = await collectReleasePackages(root)
const releaseTag = `v${rootManifest.version}`
const expectedRef = `refs/tags/${releaseTag}`

// —— ① 身份 ——
const sourceSha = runForOutput('git', ['rev-parse', 'HEAD'], root)
if (!/^[a-f0-9]{40}$/u.test(sourceSha)) {
  throw new Error(`Expected a full source commit SHA, received: ${sourceSha}`)
}
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== sourceSha) {
  throw new Error(
    `GITHUB_SHA ${process.env.GITHUB_SHA} does not match checked out source ${sourceSha}`,
  )
}
if (!dryRun && !process.env.GITHUB_SHA) {
  throw new Error('GITHUB_SHA must identify the exact source commit for publishing')
}
const taggedRelease =
  process.env.GITHUB_REF_TYPE === 'tag'
  && process.env.GITHUB_REF_NAME === releaseTag
  && process.env.GITHUB_REF === expectedRef
if (!dryRun && !taggedRelease) {
  throw new Error(`Publishing requires the exact release tag ${expectedRef}`)
}
const workingTreeStatus = runForOutput(
  'git',
  ['status', '--porcelain', '--untracked-files=all'],
  root,
)
if (workingTreeStatus && !dryRun) {
  throw new Error(`Release artifacts require a clean working tree:\n${workingTreeStatus}`)
}
if (!dryRun && !process.env.NODE_AUTH_TOKEN) {
  throw new Error('NODE_AUTH_TOKEN is required to publish packages')
}
if (!dryRun && skipBuild) {
  throw new Error('--skip-build is a dry-run shortcut; a real publish must pack freshly built output')
}

console.info(`${dryRun ? 'dry-run' : 'release'} ${releaseTag} from ${sourceSha}`)
console.info(`registry: ${ReleaseRegistry}`)
console.info(`publish order (${ordered.length} packages, dependencies first):`)
ordered.forEach((item, index) => {
  console.info(
    `  ${String(index + 1).padStart(2, ' ')}. ${item.manifest.name}@${item.manifest.version}  (packages/${item.directoryName}, access=${item.manifest.publishConfig.access})`,
  )
})
if (workingTreeStatus && dryRun) {
  console.warn(
    `! dry-run over a dirty working tree (${workingTreeStatus.split('\n').length} entries); a real publish refuses this`,
  )
}
if (skipBuild) {
  console.warn('! --skip-build: packing whatever dist/ is already on disk, not a fresh build')
}

// —— ② 打包并验明 ——
// 先整仓构建再逐包 pack:包间是拓扑依赖,单包构建拿不到上游 dist。build:package 是给将来
// 「只构建发布面」留的钩子,现在仓根没有它,回落到 build(scripts/build/buildPackageTopology.mjs)。
if (!skipBuild) {
  run('bun', ['run', rootManifest.scripts?.['build:package'] ? 'build:package' : 'build'], root)
}

for (const item of ordered) {
  const packDirectory = await mkdtemp(path.join(tmpdir(), 'velaros-release-pack-'))
  try {
    run('bun', ['pm', 'pack', '--destination', packDirectory, '--ignore-scripts'], item.directory)
    const tarballs = (await readdir(packDirectory)).filter((file) => file.endsWith('.tgz'))
    if (tarballs.length !== 1) {
      throw new Error(`${item.manifest.name} produced ${tarballs.length} package tarballs`)
    }

    const tarballPath = path.join(packDirectory, tarballs[0])
    const bytes = await readFile(tarballPath)
    // 空壳断言:GitHub Packages 上同一版本号发出去就钉死了,发成「有 package.json、没 dist」
    // 的空包无法撤回重发。形态照 scripts/ui/checks/packageContracts.mjs 已验证的 tar -tzf 做法,
    // 从 ui 一个包推广到全部 15 个。只断言 dist(声明在 files 里的其它目录未必存在——
    // 例如 workspace 的 files 列了 examples 但磁盘上没有,那是 npm 的合法 no-op,断言它会假红)。
    const tarballEntries = runForOutput('tar', ['-tzf', tarballPath], root).split('\n')
    if (!tarballEntries.includes('package/package.json')) {
      throw new Error(`${item.manifest.name} tarball is missing package/package.json`)
    }
    if (
      item.manifest.files?.includes('dist')
      && !tarballEntries.some((entry) => entry.startsWith('package/dist/'))
    ) {
      throw new Error(`${item.manifest.name} tarball ships no dist/ output; run the build first`)
    }

    const artifact = {
      name: item.manifest.name,
      version: item.manifest.version,
      sourceSha,
      releaseTag,
      fileName: tarballs[0],
      sizeBytes: (await stat(tarballPath)).size,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
    console.info(`release artifact: ${JSON.stringify(artifact)}`)

    // —— ③ 发布那一份已验明的 tarball ——
    const publishArgs = [
      'publish',
      tarballPath,
      '--registry',
      ReleaseRegistry,
      '--access',
      item.manifest.publishConfig.access,
      '--tolerate-republish',
      '--ignore-scripts',
    ]
    if (dryRun) publishArgs.push('--dry-run')
    run('bun', publishArgs, root)
  } finally {
    await rm(packDirectory, { recursive: true, force: true })
  }
}

console.info(`${dryRun ? '✓ dry-run' : '✓ released'} ${ordered.length} packages at ${releaseTag}`)
