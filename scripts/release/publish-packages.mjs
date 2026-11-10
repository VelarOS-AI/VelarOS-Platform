#!/usr/bin/env node
// 单版本火车的发布器:一次把 packages/ 下全部已声明的包按依赖拓扑打包并发到 GitHub Packages。
//
// 从哪读起:发布集合与顺序不在本文件里判——那是 releaseTopology.mjs(唯一事实来源)的活。
// 本文件只负责三件事,顺序不可换:
//   ① **身份**:把这批 tarball 绑死到精确 HEAD 与干净工作树。显式 --local-tag 核对
//      官方 origin 的实际远端 tag，并在发布器内运行完整质量门；
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
//   · tag = `v<火车号>` —— 整列发车,可再用 `--only <名字[,名字…]>` 手动收窄。
// --only **只做减法,不做豁免**:releaseTopology 的全量校验(声明集 ↔ 磁盘、版本 ↔ bun.lock、
// 平台代、拓扑序)照跑,身份四条前置一条不减,选取发生在校验之后。所以「只发一个包」拿到的
// 仍是一趟验明过的火车,不是绕开火车的小路。
// 为什么需要收窄:火车里绝大多数包版本没动,而 --tolerate-republish 会把「registry 上已有该
// 版本」当成功放过(见 ③ 的注记)——于是一趟全量发车里真正落地的往往只有新包,日志却逐个报
// published。把范围写明,比让人从十几行日志里猜哪一行是真的要诚实。
// 被排除的包逐个列进日志(不许静默收窄);名字写错直接红并列出可选值,不做模糊匹配。
//
// dry-run 的边界:--dry-run 放行「干净工作树 / 本地与远端 tag 身份 / NODE_AUTH_TOKEN」三条
// **发布期**前置(七份旧脚本里干净工作树是无条件的,导致本地 dry-run 在有改动时永远跑不起来,
// 而 dry-run 的用处恰恰是改完发布链之后先验一遍)。这三条在真发布路径上一条不减。
//
// 谁核验它:kernel / agent 两域的 check:*-arch「防线:发布身份」按字面标记核对本文件与
// verify-release-ref.mjs，并独立核对 release-packages.yml 的权限、固定源码与完整检查入口。
// 被核验的标记 = git rev-parse / git status --porcelain --untracked-files=all / 安全打包入口 /
// artifact 里的 sourceSha·fileName·sizeBytes·sha256 / publish 的第一参数是 tarballPath。
// 改这些写法要同时改门,别加豁免。

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  assertLocalReleaseIdentity,
  parseReleaseArguments,
  runLocalReleaseChecks,
} from './local-release-identity.mjs'
import {
  collectReleasePackages,
  ReleaseRegistry,
  resolveReleaseSelection,
  selectReleasedPackages,
} from './releaseTopology.mjs'
import { safePackPackage } from './safe-package-pack.mjs'
import { normalizeTarEntryPaths } from './tar-entry-paths.mjs'
import { platformModules, platformReleaseAssetUrl } from './platform-distributions.mjs'
import { validatePlatformRelease } from './validate-platform-release.mjs'
import { validateSessionTraceArchive } from './validate-session-trace-archive.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const { dryRun, skipBuild, githubRelease, localTag, onlySelectors } = parseReleaseArguments(
  process.argv.slice(2)
)

const runForOutput = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: process.env })
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with exit code ${result.status}: ${result.stderr.trim()}`
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

const expectedPackedWorkspaceSpecification = (specification, version) => {
  if (specification === 'workspace:*') return version
  if (specification === 'workspace:^') return `^${version}`
  if (specification === 'workspace:~') return `~${version}`
  throw new Error(`Unsupported workspace dependency specification: ${specification}`)
}

const assertRegistryManifest = (item, tarballPath, workspaceVersions) => {
  const tarballDirectory = path.dirname(tarballPath)
  const tarballName = path.basename(tarballPath)
  const packedManifest = JSON.parse(
    runForOutput('tar', ['-xOf', tarballName, 'package/package.json'], tarballDirectory)
  )
  if (
    packedManifest.name !== item.manifest.name ||
    packedManifest.version !== item.manifest.version
  ) {
    throw new Error(
      `${item.manifest.name} tarball identity is ${packedManifest.name}@${packedManifest.version}, expected ${item.manifest.name}@${item.manifest.version}`
    )
  }
  if (item.manifest.name === '@velaros-ai/capabilities') {
    const base = artifacts.find((artifact) => artifact.name === '@velaros-ai/velaros')
    assert(base, 'Capabilities publication requires the same candidate base archive')
    assert.equal(packedManifest.version, base.version)
    assert.equal(packedManifest.dependencies?.[base.name], base.url)
    assert.equal(packedManifest.peerDependencies?.[base.name], undefined)
    assert.equal(packedManifest.optionalDependencies?.[base.name], undefined)
  }

  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [dependency, specification] of Object.entries(item.manifest[field] ?? {})) {
      if (typeof specification !== 'string' || !specification.startsWith('workspace:')) continue
      const workspaceVersion = workspaceVersions.get(dependency)
      if (!workspaceVersion) {
        throw new Error(`${item.manifest.name} references unknown workspace package ${dependency}`)
      }
      if (item.manifest.name === '@velaros-ai/velaros') {
        if (packedManifest[field]?.[dependency])
          throw new Error(`Unified Platform still depends on ${dependency}`)
        const moduleName = dependency.replace('@velaros-ai/', '')
        // 源码包仍可构建全部能力；迁出的 Skill 不属于基础归档的安装合同。
        if (!platformModules.includes(moduleName)) continue
        if (
          !Object.keys(packedManifest.exports ?? {}).some(
            (key) => key === `./${moduleName}` || key.startsWith(`./${moduleName}/`)
          )
        )
          throw new Error(`Unified Platform missing ${moduleName} exports`)
        continue
      }
      const expected = expectedPackedWorkspaceSpecification(specification, workspaceVersion)
      if (packedManifest[field]?.[dependency] !== expected) {
        throw new Error(
          `${item.manifest.name} tarball rewrote ${field}.${dependency} to ${packedManifest[field]?.[dependency] ?? '(missing)'}, expected ${expected}`
        )
      }
    }
    for (const [dependency, specification] of Object.entries(packedManifest[field] ?? {})) {
      if (typeof specification === 'string' && specification.startsWith('workspace:')) {
        throw new Error(
          `${item.manifest.name} tarball contains non-installable ${field}.${dependency}=${specification}`
        )
      }
    }
  }
}

// 全量校验先跑完(声明集 ↔ 磁盘、版本 ↔ bun.lock、平台代、拓扑序),再谈这趟发几节车厢。
const { rootManifest, platformGeneration, ordered } = await collectReleasePackages(root)
const workspaceVersions = new Map(
  ordered.map((item) => [item.manifest.name, item.manifest.version])
)
// tag 是发布身份，真实发布只接受显式 --local-tag；--only 只能手动收窄范围。
// 单包 tag 已经把「发哪个包、发哪个版本」钉死,再让 --only 覆盖它等于让开关推翻身份。
const requestedTag = localTag ?? `v${rootManifest.version}`
const tagSelection = resolveReleaseSelection(rootManifest, ordered, requestedTag)
if (tagSelection.kind === 'unknown') {
  throw new Error(`Unknown local release tag ${requestedTag}: ${tagSelection.reason}`)
}
const selected = selectReleasedPackages(
  rootManifest,
  ordered,
  // dry-run 沿用当前根版本的完整火车作为模拟身份；真实发布必须显式给出 --local-tag。
  requestedTag,
  onlySelectors.length === 0 && tagSelection.kind === 'train'
    ? ['velaros', 'capabilities']
    : onlySelectors
).packages
const releaseTag = tagSelection.tag
const basePackage = selected.find((item) => item.manifest.name === '@velaros-ai/velaros')
const capabilityPackage = selected.find((item) => item.manifest.name === '@velaros-ai/capabilities')
const platformPair = Boolean(capabilityPackage)
if (platformPair) {
  assert(basePackage, 'Capabilities cannot publish without the same candidate base')
  assert.equal(capabilityPackage.manifest.version, basePackage.manifest.version)
  assert(dryRun || githubRelease, 'Platform pairs require canonical GitHub release assets')
}

// —— ① 身份 ——
const sourceSha = runForOutput('git', ['rev-parse', 'HEAD'], root)
if (!/^[a-f0-9]{40}$/u.test(sourceSha)) {
  throw new Error(`Expected a full source commit SHA, received: ${sourceSha}`)
}
const assertLocalIdentity = () =>
  assertLocalReleaseIdentity({
    root,
    tag: localTag,
    repository: rootManifest.repository,
    expectedSourceSha: sourceSha,
    runForOutput,
  })
if (!dryRun) assertLocalIdentity()
const workingTreeStatus = runForOutput(
  'git',
  ['status', '--porcelain', '--untracked-files=all'],
  root
)
if (workingTreeStatus && !dryRun) {
  throw new Error(`Release artifacts require a clean working tree:\n${workingTreeStatus}`)
}
if (!dryRun && !githubRelease && !process.env.NODE_AUTH_TOKEN) {
  throw new Error('NODE_AUTH_TOKEN is required to publish packages')
}
if (githubRelease && !process.env.GH_TOKEN) {
  throw new Error('GH_TOKEN is required to publish a GitHub release')
}
if (!dryRun && skipBuild) {
  throw new Error(
    '--skip-build is a dry-run shortcut; a real publish must pack freshly built output'
  )
}

console.info(`${dryRun ? 'dry-run' : 'release'} ${releaseTag} from ${sourceSha}`)
if (!dryRun)
  console.info(
    'release mode: explicit verified tag; focused release checks run before publication; full audits run in CI'
  )
console.info(`registry: ${ReleaseRegistry}`)
console.info(`platform generation: ${platformGeneration}`)
console.info(`validated ${ordered.length} declared packages; publishing ${selected.length}`)
console.info(`publish order (${selected.length} packages, dependencies first):`)
selected.forEach((item, index) => {
  console.info(
    `  ${String(index + 1).padStart(2, ' ')}. ${item.manifest.name}@${item.manifest.version}  (packages/${item.directoryName}, access=${item.manifest.publishConfig.access})`
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
    `! dry-run over a dirty working tree (${workingTreeStatus.split('\n').length} entries); a real publish refuses this`
  )
}
if (skipBuild) {
  console.warn('! --skip-build: packing whatever dist/ is already on disk, not a fresh build')
}
if (!dryRun) {
  runLocalReleaseChecks({
    root,
    packageManager: rootManifest.packageManager,
    assertIdentity: assertLocalIdentity,
    run,
    runForOutput,
  })
}

// —— ② 打包并验明 ——
// 先整仓构建再逐包 pack:包间是拓扑依赖,单包构建拿不到上游 dist。build:package 是给将来
// 「只构建发布面」留的钩子,现在仓根没有它,回落到 build(scripts/build/buildPackageTopology.mjs)。
if (dryRun && !skipBuild) {
  run('bun', ['run', rootManifest.scripts?.['build:package'] ? 'build:package' : 'build'], root)
}
if (!dryRun) assertLocalIdentity()

const artifacts = []
// 每次发布持有独占候选目录，包字节和本地收据留存；out 已由 workspace 忽略。
const candidateRoot = path.join(root, 'out', 'release-candidates')
await mkdir(candidateRoot, { recursive: true })
const resolvedCandidateRoot = await realpath(candidateRoot)
const candidateRelative = path.relative(await realpath(root), resolvedCandidateRoot)
assert(
  candidateRelative &&
    candidateRelative !== '..' &&
    !candidateRelative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(candidateRelative),
  'Release candidates must stay inside the publishing workspace'
)
const candidateDirectory = await mkdtemp(
  path.join(resolvedCandidateRoot, `release-${sourceSha.slice(0, 12)}-`)
)
const candidateReceiptPath = path.join(candidateDirectory, 'candidate.json')
const candidateReceipt = {
  schemaVersion: 1,
  kind: 'platform-release-candidate',
  sourceSha,
  releaseTag,
  toolchain: {
    node: process.version,
    bun: runForOutput('bun', ['--version'], root),
    platform: process.platform,
    arch: process.arch,
  },
  sourceValidation: { command: 'bun run release:check', passed: !dryRun },
  packages: artifacts,
  traceValidation: null,
  platformValidation: null,
  local: { directory: candidateDirectory, archives: {} },
}
const saveCandidateReceipt = () =>
  writeFile(candidateReceiptPath, `${JSON.stringify(candidateReceipt, null, 2)}\n`)
await saveCandidateReceipt()
console.info(`Preserved release candidate: ${candidateDirectory}`)

// 公布前同时核对存盘收据与保留字节，不用上一候选或仅源码级的结果代替本次消费。
const assertCandidateReceipt = async ({ requirePlatformValidation = false } = {}) => {
  assert.deepEqual(JSON.parse(await readFile(candidateReceiptPath, 'utf8')), candidateReceipt)
  for (const artifact of artifacts) {
    assert.equal(artifact.sourceSha, sourceSha)
    assert.equal(artifact.releaseTag, releaseTag)
    assert.equal(
      artifact.url,
      platformReleaseAssetUrl(rootManifest.repository, releaseTag, artifact.fileName)
    )
    const retained = candidateReceipt.local.archives[artifact.fileName]
    const bytes = await readFile(retained)
    assert.equal(bytes.length, artifact.sizeBytes)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256)
    assert.equal(
      `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      artifact.integrity
    )
  }
  const base = artifacts.find((artifact) => artifact.name === '@velaros-ai/velaros')
  if (base) {
    const trace = candidateReceipt.traceValidation
    assert(trace, 'Base publication requires the installed session trace consumer')
    assert.equal(trace.sourceSha, sourceSha)
    assert.equal(trace.releaseTag, releaseTag)
    assert.equal(trace.name, base.name)
    assert.equal(trace.version, base.version)
    assert.equal(trace.sha256, base.sha256)
    assert.equal(trace.local.archive, candidateReceipt.local.archives[base.fileName])
    assert.equal(trace.validation.javascript, true)
    assert.equal(trace.validation.strictDeclarations, true)
    assert.equal(trace.validation.nodeEnvironmentQuery, true)
    assert.deepEqual(JSON.parse(await readFile(trace.local.receiptPath, 'utf8')), trace)
  }
  if (requirePlatformValidation) {
    assert(platformPair, 'Pair validation cannot apply to another release selection')
    assert.equal(candidateReceipt.sourceValidation.passed, true)
    const capabilities = artifacts.filter(
      (artifact) => artifact.name === '@velaros-ai/capabilities'
    )
    assert.equal(artifacts.filter((artifact) => artifact.name === '@velaros-ai/velaros').length, 1)
    assert.equal(capabilities.length, 1)
    assert.equal(capabilities[0].version, base.version)
    assertRegistryManifest(
      capabilityPackage,
      candidateReceipt.local.archives[capabilities[0].fileName],
      workspaceVersions
    )
    const proof = candidateReceipt.platformValidation
    assert(proof, 'Stable Platform publication requires ordinary pair consumption')
    assert.equal(proof.schemaVersion, 1)
    assert.equal(proof.kind, 'platform-release-pair-consumer')
    assert.equal(proof.sourceSha, sourceSha)
    assert.equal(proof.releaseTag, releaseTag)
    assert.deepEqual(proof.packages, [base, capabilities[0]])
    for (const flag of [
      'ordinaryInstall',
      'frozenInstall',
      'sameBaseInstance',
      'strictDeclarations',
      'actualProjectMutation',
      'sourceIntegrity',
    ])
      assert.equal(proof.validation[flag], true, `Platform pair requires ${flag}`)
    assert.equal(
      proof.local.receiptPath,
      path.join(candidateDirectory, 'platform-release-pair-receipt.json')
    )
    assert.deepEqual(JSON.parse(await readFile(proof.local.receiptPath, 'utf8')), proof)
  }
}

if (githubRelease) {
  // Existing releases are never overwritten. An interrupted draft remains inspectable.
  run(
    'gh',
    [
      'release',
      'create',
      releaseTag,
      '--draft',
      ...(platformPair ? ['--prerelease'] : []),
      '--verify-tag',
      '--target',
      sourceSha,
      '--title',
      `Platform ${releaseTag}`,
      '--notes',
      `Release source: ${sourceSha}; tag: ${releaseTag}. The exact base archive must pass isolated JavaScript and strict declaration consumption. Platform pairs become a non-latest prerelease candidate so canonical URLs can be consumed without overrides; stable promotion requires ordinary pair installation and Project validation. Package hashes and validation results are recorded in release-manifest.json and release-validation.json.`,
    ],
    root
  )
}

for (const item of selected) {
  const packDirectory = await mkdtemp(path.join(tmpdir(), 'velaros-release-pack-'))
  try {
    await safePackPackage({
      destination: packDirectory,
      packageDirectory: item.directory,
      distribution: item.distribution,
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
    // 从 ui 一个包推广到全部发布包。只断言 dist(声明在 files 里的其它目录未必存在——
    // 例如 workspace 的 files 列了 examples 但磁盘上没有,那是 npm 的合法 no-op,断言它会假红)。
    const tarballEntries = normalizeTarEntryPaths(
      runForOutput('tar', ['-tzf', tarballs[0]], packDirectory)
    )
    if (!tarballEntries.includes('package/package.json')) {
      throw new Error(`${item.manifest.name} tarball is missing package/package.json`)
    }
    // 工作树清单应继续用 workspace:* 保证单仓一致性；注册表清单则必须是普通版本号。
    // 这道门检查真正将要发布的 tarball，防止有人绕过 bun 的 workspace 重写或换回目录发布，
    // 造出 registry 接受、消费者却因 EUNSUPPORTEDPROTOCOL 无法安装的永久坏版本。
    assertRegistryManifest(item, tarballPath, workspaceVersions)
    if (
      item.manifest.files?.includes('dist') &&
      !tarballEntries.some((entry) => entry.startsWith('package/dist/'))
    ) {
      throw new Error(`${item.manifest.name} tarball ships no dist/ output; run the build first`)
    }

    const artifact = {
      name: item.manifest.name,
      version: item.manifest.version,
      sourceSha,
      releaseTag,
      fileName: tarballs[0],
      url: platformReleaseAssetUrl(rootManifest.repository, releaseTag, tarballs[0]),
      sizeBytes: (await stat(tarballPath)).size,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    }
    console.info(`release artifact: ${JSON.stringify(artifact)}`)
    artifacts.push(artifact)
    const retainedArchive = path.join(candidateDirectory, artifact.fileName)
    await copyFile(tarballPath, retainedArchive, fsConstants.COPYFILE_EXCL)
    assert.equal(
      createHash('sha256')
        .update(await readFile(retainedArchive))
        .digest('hex'),
      artifact.sha256
    )
    candidateReceipt.local.archives[artifact.fileName] = retainedArchive
    await saveCandidateReceipt()
    if (artifact.name === '@velaros-ai/velaros') {
      candidateReceipt.traceValidation = await validateSessionTraceArchive({
        archive: retainedArchive,
        sha256: artifact.sha256,
        sourceSha,
        releaseTag,
        version: artifact.version,
        receiptDirectory: candidateDirectory,
        bunVersion: candidateReceipt.toolchain.bun,
      })
      await saveCandidateReceipt()
    }

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
    if (!dryRun) {
      if (
        createHash('sha256')
          .update(await readFile(tarballPath))
          .digest('hex') !== artifact.sha256
      ) {
        throw new Error(`${item.manifest.name} tarball changed after validation`)
      }
      if (!dryRun) assertLocalIdentity()
    }
    await assertCandidateReceipt()
    if (githubRelease) run('gh', ['release', 'upload', releaseTag, tarballPath], root)
    else run('bun', publishArgs, root)
  } finally {
    await rm(packDirectory, { recursive: true, force: true })
  }
}

await assertCandidateReceipt()
if (githubRelease) {
  let publicPairCandidate = false
  try {
    if (platformPair) {
      assert.equal(artifacts.length, selected.length)
      assertLocalIdentity()
      await assertCandidateReceipt()
      // 标记本次公开尝试；命令失败也可能已生效，失败路径仍须尝试恢复 draft。
      publicPairCandidate = true
      run(
        'gh',
        ['release', 'edit', releaseTag, '--draft=false', '--prerelease', '--latest=false'],
        root
      )
      candidateReceipt.platformValidation = await validatePlatformRelease({
        rootManifest,
        releaseTag,
        sourceSha,
        artifacts,
        receiptDirectory: candidateDirectory,
        bunVersion: candidateReceipt.toolchain.bun,
      })
      await saveCandidateReceipt()
      await assertCandidateReceipt({ requirePlatformValidation: true })
    }
    // 公开版仅列身份、哈希及验证结果；机器路径和原始命令输出留在本地候选收据。
    const { local: _traceLocal, ...publicTrace } = candidateReceipt.traceValidation ?? {}
    const { local: _platformLocal, ...publicPlatform } = candidateReceipt.platformValidation ?? {}
    const validationPath = path.join(candidateDirectory, 'release-validation.json')
    const validationBytes = `${JSON.stringify(
      {
        schemaVersion: candidateReceipt.schemaVersion,
        kind: candidateReceipt.kind,
        sourceSha,
        releaseTag,
        toolchain: candidateReceipt.toolchain,
        sourceValidation: candidateReceipt.sourceValidation,
        packages: artifacts,
        traceValidation: candidateReceipt.traceValidation ? publicTrace : null,
        platformValidation: candidateReceipt.platformValidation ? publicPlatform : null,
      },
      null,
      2
    )}\n`
    await writeFile(validationPath, validationBytes, { flag: 'wx' })
    const validationSha256 = createHash('sha256').update(validationBytes).digest('hex')
    const manifestPath = path.join(candidateDirectory, 'release-manifest.json')
    const manifestBytes = `${JSON.stringify({ sourceSha, releaseTag, packages: artifacts, validationReceipt: { fileName: path.basename(validationPath), sha256: validationSha256 } }, null, 2)}\n`
    const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex')
    await writeFile(manifestPath, manifestBytes, { flag: 'wx' })
    assertLocalIdentity()
    await assertCandidateReceipt({ requirePlatformValidation: platformPair })
    assert.equal(
      createHash('sha256')
        .update(await readFile(validationPath))
        .digest('hex'),
      validationSha256
    )
    assert.equal(
      createHash('sha256')
        .update(await readFile(manifestPath))
        .digest('hex'),
      manifestSha256
    )
    run('gh', ['release', 'upload', releaseTag, validationPath], root)
    run('gh', ['release', 'upload', releaseTag, manifestPath], root)
    assertLocalIdentity()
    await assertCandidateReceipt({ requirePlatformValidation: platformPair })
    assert.equal(
      createHash('sha256')
        .update(await readFile(validationPath))
        .digest('hex'),
      validationSha256
    )
    assert.equal(
      createHash('sha256')
        .update(await readFile(manifestPath))
        .digest('hex'),
      manifestSha256
    )
    if (platformPair) {
      run('gh', ['release', 'edit', releaseTag, '--prerelease=false', '--latest'], root)
    } else run('gh', ['release', 'edit', releaseTag, '--draft=false'], root)
  } catch (error) {
    if (publicPairCandidate) {
      try {
        run(
          'gh',
          ['release', 'edit', releaseTag, '--draft=true', '--prerelease', '--latest=false'],
          root
        )
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          'Platform candidate validation and draft restoration failed'
        )
      }
    }
    throw error
  }
}

console.info(
  `${dryRun ? '✓ dry-run' : '✓ released'} ${selected.length} of ${ordered.length} declared packages at ${releaseTag}`
)
