#!/usr/bin/env node
// 单版本火车的发布器:一次把 packages/ 下全部已声明的包按依赖拓扑打包并发到 GitHub Packages。
//
// 从哪读起:发布集合与顺序不在本文件里判——那是 releaseTopology.mjs(唯一事实来源)的活。
// 本文件只负责三件事,顺序不可换:
//   ① **身份**:把这批 tarball 绑死到一个精确的源码身份(HEAD SHA + GITHUB_SHA + 那个 tag 的 ref)
//      与一棵干净的工作树;
//   ② **打包并验明**:每个包 pack 出**恰好一个** tarball,记下 size + sha256,并断言构建产物真的进了包;
//   ③ **发布那一份已验明的 tarball**(而不是让 registry 重新从工作树打包)。
//
// 关键不变量:发布的字节 == 被记录 sha256 的字节 == 由这个 SHA 的源码构建出来的字节。
// 破坏方式:任何在 ② 与 ③ 之间重新 pack、或者改成 `bun publish`(不带 tarball 路径)直接发目录,
// 都会让 artifact 日志里的 sha256 变成一句无法核对的漂亮话。
//
// 这趟发什么,有两个来源,**tag 优先**:
//   · tag = `<包名或目录名>@<版本>` —— 单包发布,范围由 tag 钉死(见 releaseTopology 的
//     resolveReleaseSelection);此时传 --only 直接红,开关不许推翻身份。
//   · tag = `v<火车号>` —— 整列发车,可再用 `--only <名字[,名字…]>` 手动收窄(workflow_dispatch)。
// --only **只做减法,不做豁免**:releaseTopology 的全量校验(声明集 ↔ 磁盘、版本 ↔ bun.lock、
// 平台代、拓扑序)照跑,身份四条前置一条不减,选取发生在校验之后。所以「只发一个包」拿到的
// 仍是一趟验明过的火车,不是绕开火车的小路。
// 为什么需要收窄:火车里绝大多数包版本没动,而 --tolerate-republish 会把「registry 上已有该
// 版本」当成功放过(见 ③ 的注记)——于是一趟全量发车里真正落地的往往只有新包,日志却逐个报
// published。把范围写明,比让人从十几行日志里猜哪一行是真的要诚实。
// 被排除的包逐个列进日志(不许静默收窄);名字写错直接红并列出可选值,不做模糊匹配。
//
// dry-run 的边界:--dry-run 放行「干净工作树 / GITHUB_SHA / tag ref / NODE_AUTH_TOKEN」四条
// **发布期**前置(七份旧脚本里干净工作树是无条件的,导致本地 dry-run 在有改动时永远跑不起来,
// 而 dry-run 的用处恰恰是改完发布链之后先验一遍)。这四条在真发布路径上一条不减。
//
// 谁核验它:kernel / agent 两域的 check:*-arch「防线:发布身份」按字面标记核对本文件与
// verify-release-ref.mjs、release-packages.yml 三者(rule=release-artifact-identity)。
// 被核验的标记 = git rev-parse / git status --porcelain --untracked-files=all / 安全打包入口 /
// artifact 里的 sourceSha·fileName·sizeBytes·sha256 / publish 的第一参数是 tarballPath。
// 改这些写法要同时改门,别加豁免。

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  collectReleasePackages,
  ReleaseRegistry,
  resolveReleaseSelection,
  selectReleasedPackages,
} from './releaseTopology.mjs'
import { safePackPackage } from './safe-package-pack.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const dryRun = process.argv.includes('--dry-run')
const skipBuild = process.argv.includes('--skip-build')

const readOnlySelectors = (argv) => {
  const selectors = []
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--only') continue
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error('--only requires at least one package name, e.g. --only agent-lab')
    }
    for (const entry of value.split(',')) {
      const trimmed = entry.trim()
      if (trimmed) selectors.push(trimmed)
    }
  }
  return selectors
}

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

const assertRegistryManifest = (item, tarballPath) => {
  const packedManifest = JSON.parse(
    runForOutput('tar', ['-xOf', tarballPath, 'package/package.json'], root),
  )
  if (packedManifest.name !== item.manifest.name || packedManifest.version !== item.manifest.version) {
    throw new Error(
      `${item.manifest.name} tarball identity is ${packedManifest.name}@${packedManifest.version}, expected ${item.manifest.name}@${item.manifest.version}`,
    )
  }

  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [dependency, specification] of Object.entries(packedManifest[field] ?? {})) {
      if (typeof specification === 'string' && specification.startsWith('workspace:')) {
        throw new Error(
          `${item.manifest.name} tarball contains non-installable ${field}.${dependency}=${specification}`,
        )
      }
    }
  }
}

// 全量校验先跑完(声明集 ↔ 磁盘、版本 ↔ bun.lock、平台代、拓扑序),再谈这趟发几节车厢。
const { rootManifest, platformGeneration, ordered } = await collectReleasePackages(root)
// 范围有两个来源,tag 优先:tag 是这次发布的身份,--only 只是 workflow_dispatch 手动收窄时用。
// 单包 tag 已经把「发哪个包、发哪个版本」钉死,再让 --only 覆盖它等于让开关推翻身份。
const tagSelection = resolveReleaseSelection(rootManifest, ordered, process.env.GITHUB_REF_NAME)
const onlySelectors = readOnlySelectors(process.argv)
const selected = selectReleasedPackages(
  rootManifest,
  ordered,
  // 本地 dry-run 没有 GitHub ref，沿用完整火车作为模拟身份；真发布仍在下方 taggedRelease
  // 硬门要求精确 tag，不能借这个回退绕过发布身份。
  tagSelection.kind === 'unknown' ? `v${rootManifest.version}` : process.env.GITHUB_REF_NAME,
  onlySelectors,
).packages
const releaseTag = tagSelection.kind === 'unknown' ? `v${rootManifest.version}` : tagSelection.tag
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
console.info(`platform generation: ${platformGeneration}`)
console.info(`validated ${ordered.length} declared packages; publishing ${selected.length}`)
console.info(`publish order (${selected.length} packages, dependencies first):`)
selected.forEach((item, index) => {
  console.info(
    `  ${String(index + 1).padStart(2, ' ')}. ${item.manifest.name}@${item.manifest.version}  (packages/${item.directoryName}, access=${item.manifest.publishConfig.access})`,
  )
})
// 收窄了就得说清收窄掉什么、以及被谁收窄:静默的范围缩减看起来和「全都发了」一模一样。
const narrowedBy = tagSelection.kind === 'package' ? `tag ${tagSelection.tag}` : '--only'
for (const item of ordered) {
  if (selected.includes(item)) continue
  console.info(`  - skipped by ${narrowedBy}: ${item.manifest.name}@${item.manifest.version}`)
}
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

for (const item of selected) {
  const packDirectory = await mkdtemp(path.join(tmpdir(), 'velaros-release-pack-'))
  try {
    await safePackPackage({
      destination: packDirectory,
      packageDirectory: item.directory,
      stdio: 'inherit',
    })
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
    // 工作树清单应继续用 workspace:* 保证单仓一致性；注册表清单则必须是普通版本号。
    // 这道门检查真正将要发布的 tarball，防止有人绕过 bun 的 workspace 重写或换回目录发布，
    // 造出 registry 接受、消费者却因 EUNSUPPORTEDPROTOCOL 无法安装的永久坏版本。
    assertRegistryManifest(item, tarballPath)
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
      // registry 上已有该版本时不报错。代价是这一步会变成静默 no-op:日志照样往下走,
      // 而那个版本的字节仍是上一次发的。所以「改了内容却没改版本号」永远不会被这里拦住——
      // 拦它的是版本号纪律,不是发布器。想确认某次真的落地了,看 registry 上该版本的时间戳。
      '--tolerate-republish',
      '--ignore-scripts',
    ]
    if (dryRun) publishArgs.push('--dry-run')
    run('bun', publishArgs, root)
  } finally {
    await rm(packDirectory, { recursive: true, force: true })
  }
}

console.info(
  `${dryRun ? '✓ dry-run' : '✓ released'} ${selected.length} of ${ordered.length} declared packages at ${releaseTag}`,
)
