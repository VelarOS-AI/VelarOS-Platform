// VelarOS-Platform 根 eslint 共享基座。
//
// 形态:不重写规则集。八个源仓各自的 eslint.config.mjs 原样住在 eslint/<domain>.config.mjs,
// 本文件只做两件机械事:
//   ① 域作用域收敛——把每条 config entry 的 files 与该域的包 glob 求交(flat config 的
//      `files: [[a, b]]` 语义是 AND),使各域规则只作用于自己的包,互不串味;
//   ② 根锚定——parserOptions.tsconfigRootDir 从 eslint/ 目录改回仓根,project 指向根
//      tsconfig.eslint.json(全仓 program)。
// 纯全局 ignores 条目(只有 ignores 一个键)原样保留为全局。
//
// 结论:规则集不做统一,冲突的域差异保留在各自 eslint/<domain>.config.mjs 里。

import path from 'node:path'

import agentConfig from './eslint/agent.config.mjs'
import capabilitiesConfig from './eslint/capabilities.config.mjs'
import coreConfig from './eslint/core.config.mjs'
import kernelConfig from './eslint/kernel.config.mjs'
import memoryConfig from './eslint/memory.config.mjs'
import modelConfig from './eslint/model.config.mjs'
import uiConfig from './eslint/ui.config.mjs'

const RepoRoot = import.meta.dirname

// 各域裸路径 glob 的落位改写:源仓写 tests/ 开头的 glob 指自己的测试树,导入后住 tests/<domain>/。
// 其余裸 glob(packages/ 前缀、dist/node_modules 通配等)在新仓语义不变,原样透传。
const remapDomainPaths = (domain) => (pattern) =>
  /^tests\//.test(pattern) ? pattern.replace(/^tests\//, `tests/${domain}/`) : pattern

/** 各域的作用域 glob。html-artifacts 源仓无 eslint 门,故不参与(见下方全局 ignores)。 */
const Domains = [
  {
    name: 'kernel',
    config: kernelConfig,
    globs: [
      'packages/kernel-client/**',
      'packages/kernel-daemon/**',
      'packages/kernel-updater/**',
    ],
    // Kernel 仓根 src/ 与 test/ 的裸路径规则,P2 库化后落在 kernel-daemon 包下(内核本体已并入 core 域)。
    remap: (pattern) =>
      /^(?:src|test)\//.test(pattern) ? `packages/kernel-daemon/${pattern}` : pattern,
  },
  {
    name: 'agent',
    config: agentConfig,
    globs: ['packages/agent-protocol/**', 'packages/agent-runtime/**'],
  },
  { name: 'core', config: coreConfig, globs: ['packages/core/**'] },
  {
    name: 'model',
    config: modelConfig,
    globs: ['packages/model-runtime/**', 'tests/model/**'],
  },
  {
    name: 'capabilities',
    config: capabilitiesConfig,
    globs: [
      'packages/browser-composition/**',
      'packages/browser-core/**',
      'packages/browser-runtime/**',
      'packages/browser-tools/**',
      'packages/cli/**',
      'packages/computer-runtime/**',
      'packages/computer-tools/**',
      'packages/office-tools/**',
      'packages/system-tools/**',
      'packages/workspace/**',
    ],
  },
  {
    name: 'memory',
    config: memoryConfig,
    globs: [
      'packages/memory/**',
      'packages/knowledge/**',
      'packages/memory-adapter-kernel/**',
      'tests/memory/**',
    ],
  },
  {
    name: 'ui',
    config: uiConfig,
    globs: [
      'packages/ui/**',
      'packages/conversation-ui/**',
      'component-library/**',
      'tests/ui/**',
    ],
  },
]

const toArray = (value) => (Array.isArray(value) ? value : [value])

function isGlobalIgnores(entry) {
  const keys = Object.keys(entry)
  return keys.length === 1 && keys[0] === 'ignores'
}

function anchorLanguageOptions(languageOptions) {
  const parserOptions = languageOptions?.parserOptions
  if (!parserOptions?.tsconfigRootDir && !parserOptions?.project) return languageOptions
  return {
    ...languageOptions,
    parserOptions: {
      ...parserOptions,
      ...(parserOptions.project ? { project: './tsconfig.eslint.json' } : {}),
      ...(parserOptions.tsconfigRootDir ? { tsconfigRootDir: RepoRoot } : {}),
    },
  }
}

function scopeDomain({ name, config, globs, remap }) {
  const mapPattern = remap ?? remapDomainPaths(name)
  return config.map((entry) => {
    // 纯全局 ignores 保持全局,但域私有的裸路径(如 memory 的 `tests/**`)必须落到本域子树,
    // 否则一个域的忽略会误伤别的域。
    if (isGlobalIgnores(entry)) return { ignores: entry.ignores.map(mapPattern) }
    const scoped = { ...entry }
    scoped.files = entry.files
      ? entry.files.flatMap((pattern) =>
          globs.map((glob) => [...toArray(pattern).map(mapPattern), glob]),
        )
      : globs
    if (entry.ignores) scoped.ignores = entry.ignores.map(mapPattern)
    if (entry.languageOptions) {
      scoped.languageOptions = anchorLanguageOptions(entry.languageOptions)
    }
    return scoped
  })
}

export default [
  {
    ignores: [
      '**/.git/**',
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/demo-dist/**',
      'scripts/**',
      'eslint/**',
      'docs/**',
      'baselines/**',
      // html-artifacts 源仓(VelarOS-HTML-Artifacts)不带 eslint 门,导入后维持无门现状。
      'packages/html-artifacts/**',
      // dist-in-src:.js/.d.ts 是 tsc 产物(与 .ts 源同目录),不是源码。
      'packages/*/src/**/*.js',
      'packages/*/src/**/*.d.ts',
      path.basename(import.meta.filename),
    ],
  },
  ...Domains.flatMap((domain) => scopeDomain(domain)),
]
