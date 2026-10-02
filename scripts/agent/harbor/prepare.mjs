import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { withVerifiedPackageBuilds } from '../../build/buildPackageTopology.mjs'
import { createBundleSeal } from './bundle-integrity.mjs'
import { validateCandidatePricing } from './candidate-pricing.mjs'
import { safePackPackage } from '../../release/safe-package-pack.mjs'

// 只输出正式包的发布内容；沿用安全打包入口，不复制源码、凭据或本机 node_modules。
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    lockfile: { type: 'string' },
    model: { type: 'string' },
    reasoning: { type: 'string' },
    pricing: { type: 'string' },
    'openai-explicit-cache-breakpoints': { type: 'string' },
    'result-retain': { type: 'string' },
    'project-images': { type: 'boolean' },
    'resident-modules': { type: 'string' },
    'resident-exports': { type: 'string' },
    'working-window': { type: 'string' },
  },
})
const modelName = values.model?.replace(/^openai\//u, '')
if (!modelName || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u.test(modelName))
  throw new Error('--model must explicitly identify the candidate model')
const reasoningEffort = values.reasoning
if (!['low', 'medium', 'high'].includes(reasoningEffort))
  throw new Error('--reasoning must explicitly be low, medium or high')
const breakpointSetting = values['openai-explicit-cache-breakpoints']
if (breakpointSetting !== undefined && !['enabled', 'disabled'].includes(breakpointSetting))
  throw new Error('--openai-explicit-cache-breakpoints must be enabled or disabled')
const openaiExplicitCacheBreakpoints =
  breakpointSetting === undefined ? undefined : breakpointSetting === 'enabled'
const pricingBytes = values.pricing ? await readFile(resolve(values.pricing)) : undefined
const pricing = pricingBytes
  ? {
      ...validateCandidatePricing(
        JSON.parse(pricingBytes.toString('utf8')),
        modelName,
        reasoningEffort
      ),
      sha256: createHash('sha256').update(pricingBytes).digest('hex'),
    }
  : undefined
if (positionals.length > 1) throw new Error('Expected one output directory')
const retain = values['result-retain']
if (retain !== undefined && retain !== 'task' && !/^(?:[1-9]|[12]\d|3[0-2])$/.test(retain))
  throw new Error('--result-retain must be task or an integer from 1 to 32')
const runtimeOptions =
  retain === undefined
    ? {}
    : { protocol: { defaultRetain: retain === 'task' ? retain : Number(retain) } }
if (values['project-images']) runtimeOptions.project = { images: true }
if (values['resident-modules'] !== undefined) {
  const modules = values['resident-modules'] === 'none' ? [] : values['resident-modules'].split(',')
  if (
    modules.some((name) => !['project', 'shell', 'images'].includes(name)) ||
    new Set(modules).size !== modules.length ||
    (modules.includes('images') && !values['project-images'])
  )
    throw new Error(
      '--resident-modules must be none or unique project,shell,images names; images requires --project-images'
    )
  runtimeOptions.residentModules = modules.map((name) => ({ module: `velaros:${name}` }))
}
if (values['resident-exports'] !== undefined) {
  const names = values['resident-exports'].split(',')
  const selected = names.map((name) => /^(project|shell|images)\.([A-Za-z_$][\w$]*)$/.exec(name))
  if (
    selected.some((match) => !match || (match[1] === 'images' && !values['project-images'])) ||
    new Set(names).size !== names.length
  )
    throw new Error(
      '--resident-exports must be unique module.export names; images requires --project-images'
    )
  runtimeOptions.residentModules = [
    ...(runtimeOptions.residentModules ?? []),
    ...selected.map((match) => ({ module: `velaros:${match[1]}`, exports: [match[2]] })),
  ]
}
if (values['working-window'] !== undefined) {
  const windowTokens = Number(values['working-window'])
  if (!Number.isSafeInteger(windowTokens) || windowTokens < 1 || windowTokens > 922000)
    throw new Error('--working-window must be an integer from 1 to 922000 tokens')
  runtimeOptions.context = { policy: { windowTokens } }
}
const output = resolve(positionals[0] ?? join(repository, '.velaros-workspace/bench/bundle'))
const previous = await readdir(output).catch((error) => {
  if (error.code === 'ENOENT') return []
  throw error
})
if (previous.length) throw new Error('Bundle directory is not empty; use a new versioned path')
const names = ['core', 'kernel', 'context', 'model', 'agent', 'script', 'velaros']
const fingerprint = createHash('sha256')
const identity = await withVerifiedPackageBuilds(names, async (buildProof) => {
  const temporary = await mkdtemp(join(tmpdir(), 'velaros-harbor-pack-'))
  try {
    await mkdir(output, { recursive: true })
    for (const name of names) {
      const filename = join(temporary, `${name}.tgz`)
      await safePackPackage({ packageDirectory: join(repository, 'packages', name), filename })
      fingerprint.update(name).update(await readFile(filename))
      const target = join(output, 'packages', name)
      await mkdir(target, { recursive: true })
      execFileSync('tar', ['-xzf', filename, '--strip-components', '1', '-C', target])
      const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'))
      delete manifest.scripts
      delete manifest.devDependencies
      delete manifest.publishConfig
      for (const key of ['dependencies', 'peerDependencies']) {
        for (const dependency of Object.keys(manifest[key] ?? {})) {
          if (dependency.startsWith('@velaros-ai/')) manifest[key][dependency] = 'workspace:*'
        }
      }
      await writeFile(join(target, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
    }
    const root = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'))
    await writeFile(
      join(output, 'package.json'),
      JSON.stringify(
        {
          name: 'velaros-scriptact-harbor',
          private: true,
          type: 'module',
          workspaces: ['packages/*'],
          dependencies: {
            '@velaros-ai/velaros': 'workspace:*',
            '@velaros-ai/model': 'workspace:*',
            '@velaros-ai/agent': 'workspace:*',
          },
          overrides: root.overrides,
        },
        null,
        2
      ) + '\n'
    )
    for (const name of [
      'run.mjs',
      'atif.mjs',
      'trace-export.mjs',
      'trace-artifact.mjs',
      'tool-discovery.mjs',
    ]) {
      fingerprint.update(name).update(await readFile(join(import.meta.dirname, name)))
      await cp(join(import.meta.dirname, name), join(output, name))
    }
    const inheritedLock = values.lockfile ? await readFile(resolve(values.lockfile)) : undefined
    if (inheritedLock) await writeFile(join(output, 'bun.lock'), inheritedLock)
    execFileSync(
      'bun',
      [
        'install',
        '--lockfile-only',
        '--ignore-scripts',
        ...(inheritedLock ? ['--frozen-lockfile'] : []),
      ],
      {
        cwd: output,
        stdio: ['ignore', 'ignore', 'inherit'],
        timeout: 120000,
      }
    )
    const lock = await readFile(join(output, 'bun.lock'))
    if (inheritedLock && !lock.equals(inheritedLock))
      throw new Error('Candidate dependency lock changed')
    fingerprint.update(lock)
    fingerprint.update(await readFile(join(import.meta.dirname, 'agent.py')))
    fingerprint.update('runtimeOptions').update(JSON.stringify(runtimeOptions))
    const bundleSeal = await createBundleSeal(output)
    fingerprint.update(bundleSeal.sha256).update(
      JSON.stringify({
        modelName,
        reasoningEffort,
        openaiExplicitCacheBreakpoints,
        buildProof,
        pricing,
      })
    )
    return {
      sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repository,
        encoding: 'utf8',
      }).trim(),
      sourceDirty: Boolean(
        execFileSync('git', ['status', '--porcelain'], {
          cwd: repository,
          encoding: 'utf8',
        }).trim()
      ),
      bundleFingerprint: fingerprint.digest('hex'),
      dependencyLockSha256: createHash('sha256').update(lock).digest('hex'),
      runtimeOptions,
      modelName,
      reasoningEffort,
      openaiExplicitCacheBreakpoints,
      pricing,
      buildProof,
      bundleSeal,
      preparedAt: new Date().toISOString(),
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})
await writeFile(join(output, 'identity.json'), JSON.stringify(identity, null, 2) + '\n')
console.log(output)
