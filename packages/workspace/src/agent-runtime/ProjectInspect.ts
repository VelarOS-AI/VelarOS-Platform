
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { isArray, isEmpty, isObject, isPlainObject, isPresent, isString, toNullable } from '@velaros-ai/core'
import { logRuntime } from '@velaros-ai/core/logger'

import type { VelaTool } from './Types'

export const log = logRuntime.tag('ProjectInspectTools')

export type JsonObject = Record<string, any>
type ProjectInfoToolContext = Parameters<VelaTool<Record<string, never>>['execute']>[1]

function isSameOrChild(rootPath: string, targetPath: string): boolean {
  const rel = relative(resolve(rootPath), resolve(targetPath))
  return isEmpty(rel) || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

export function resolveSandboxSourceProjectRoot(
  ctx: ProjectInfoToolContext,
  cwd: string | undefined
): Nullable<string> {
  const sandbox = ctx.workspaceSandbox?.current
  if (!sandbox || !cwd) return null

  const requestedRoot = isAbsolute(cwd)
    ? resolve(cwd)
    : resolve(ctx.workspace.getRootPath(), cwd)
  const sourceRoot = resolve(sandbox.sourceRoot)
  return isSameOrChild(sourceRoot, requestedRoot) ? requestedRoot : null
}

export async function buildJsTsProjectProfileForRoot(
  ctx: ProjectInfoToolContext,
  rootPath: string,
  packageManager: Nullable<string>
): Promise<Record<string, any>> {
  return buildJsTsProjectProfile(
    {
      ...ctx,
      workspace: {
        ...ctx.workspace,
        getRootPath: () => rootPath,
        kernel: () => ctx.workspace.kernelForRoot(rootPath),
      },
    },
    packageManager
  )
}

export async function readJsonFile(
  ctx: Parameters<VelaTool<Record<string, never>>['execute']>[1],
  path: string
): Promise<Nullable<JsonObject>> {
  try {
    const kernel = await ctx.workspace.kernel()
    const result = await kernel.read({ path, maxBytes: 300_000 })
    return JSON.parse(result.content ?? '{}') as JsonObject
  } catch (error) {
    log.debug('读取项目 JSON 文件失败，按不存在处理', {
      path,
      error: String(error),
    })
    return null
  }
}

export async function fileExists(
  ctx: Parameters<VelaTool<Record<string, never>>['execute']>[1],
  path: string
): Promise<boolean> {
  try {
    const kernel = await ctx.workspace.kernel()
    const result = await kernel.read({ path, maxBytes: 1 })
    return result.snapshot.exists && !result.snapshot.isDirectory
  } catch (error) {
    log.debug('探测项目文件存在性失败，按不存在处理', {
      path,
      error: String(error),
    })
    return false
  }
}

export function asStringRecord(value: any): Record<string, string> {
  if (!isPlainObject(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => isString(entry[1]))
  )
}

export function detectScriptGroups(scripts: Record<string, string>): Record<string, string[]> {
  const groups = {
    dev: ['dev', 'start', 'serve', 'preview'].filter((name) => scripts[name]),
    build: Object.keys(scripts).filter((name) => /build|compile|bundle/i.test(name)),
    typecheck: Object.keys(scripts).filter(
      (name) => /type-?check|tsc/i.test(name) || /\btsc\b/.test(scripts[name])
    ),
    lint: Object.keys(scripts).filter((name) => /lint/i.test(name)),
    test: Object.keys(scripts).filter(
      (name) =>
        /test|spec|vitest|jest|playwright|e2e/i.test(name) ||
        /vitest|jest|playwright|bun test|node --test/.test(scripts[name])
    ),
    format: Object.keys(scripts).filter((name) => /format|prettier/i.test(name)),
  }
  return groups
}

export function packageRunCommand(packageManager: Nullable<string>, scriptName: string): string {
  switch (packageManager) {
    case 'bun': {
      return `bun run ${scriptName}`
    }
    case 'pnpm': {
      return `pnpm ${scriptName}`
    }
    case 'yarn': {
      return `yarn ${scriptName}`
    }
    default: {
      return `npm run ${scriptName}`
    }
  }
}

export function detectNotablePackages(pkg: JsonObject): string[] {
  const deps = {
    ...asStringRecord(pkg.dependencies),
    ...asStringRecord(pkg.devDependencies),
  }
  return [
    'typescript',
    'react',
    'next',
    'vue',
    'vite',
    'vitest',
    'jest',
    'playwright',
    'electron',
    'eslint',
    'prettier',
    'tailwindcss',
    'tsup',
    'rollup',
    'webpack',
  ].filter((name) => deps[name])
}

export async function buildJsTsProjectProfile(
  ctx: Parameters<VelaTool<Record<string, never>>['execute']>[1],
  packageManager: Nullable<string>
): Promise<Record<string, any>> {
  const pkg = await readJsonFile(ctx, 'package.json')
  const tsconfig = await readJsonFile(ctx, 'tsconfig.json')
  const scripts = asStringRecord(pkg?.scripts)
  const configCandidates = [
    'tsconfig.json',
    'tsconfig.node.json',
    'tsconfig.web.json',
    'vite.config.ts',
    'vite.config.js',
    'next.config.js',
    'next.config.mjs',
    'eslint.config.js',
    'eslint.config.mjs',
    'eslint.config.ts',
    '.eslintrc.json',
    'prettier.config.js',
    '.prettierrc',
    'tailwind.config.ts',
    'tailwind.config.js',
  ]
  const configFiles = (
    await Promise.all(
      configCandidates.map(async (path) => ((await fileExists(ctx, path)) ? path : null))
    )
  ).filter((path): path is string => isPresent(path))
  const compilerOptions =
    tsconfig?.compilerOptions && isObject(tsconfig.compilerOptions)
      ? (tsconfig.compilerOptions as JsonObject)
      : {}
  const paths = isPlainObject(compilerOptions.paths) ? Object.keys(compilerOptions.paths) : []
  const scriptGroups = detectScriptGroups(scripts)

  return {
    package: pkg
      ? {
          type: isString(pkg.type) ? pkg.type : null,
          workspaces: isArray(pkg.workspaces) ? pkg.workspaces : null,
          notablePackages: detectNotablePackages(pkg),
          dependencyCount: Object.keys(asStringRecord(pkg.dependencies)).length,
          devDependencyCount: Object.keys(asStringRecord(pkg.devDependencies)).length,
        }
      : null,
    scripts: Object.entries(scripts).map(([name, command]) => ({
      name,
      command,
      run: packageRunCommand(packageManager, name),
    })),
    scriptGroups,
    configFiles,
    tsconfig: tsconfig
      ? {
          strict: toNullable(compilerOptions.strict),
          jsx: toNullable(compilerOptions.jsx),
          module: toNullable(compilerOptions.module),
          moduleResolution: toNullable(compilerOptions.moduleResolution),
          baseUrl: toNullable(compilerOptions.baseUrl),
          pathAliases: paths,
        }
      : null,
  }
}
