import { writeFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { isEmpty, isUndefined, toNullable, toOptional, TypeGuards } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import {
  CodeSurfaceLimits,
  NodeDefaultPackages,
  ScriptOutputLimits,
} from '../contract/constants.js'
import type { NodeRuntimeEnvironment } from '../types/environment.js'
import type { CodeRunRequest } from '../types/runner.js'

import { createOutputCollector, validateOutputOptions } from './output-capture.js'

/** 默认 npm 包拥有整个导入命名空间，子路径仍由 Node 的 exports 规则核对。 */
function isDefaultPackage(specifier: string): boolean {
  return NodeDefaultPackages.some((name) => specifier === name || specifier.startsWith(`${name}/`))
}

/** 正式输出合同的原生模块；普通任务直接使用 console，内部结构化产物按需导入。 */
function outputModule(): string {
  const guards = Object.entries({ ...TypeGuards, isEmpty, toNullable, toOptional })
    .map(([name, guard]) => {
      const body = guard.toString()
      const source =
        /^(?:async\s+)?[\w$]+\s*\(/u.test(body) && !body.startsWith('function ')
          ? `function ${body}`
          : body
      return `const ${name}=(${source});`
    })
    .join('\n')
  return `import {appendFileSync} from 'node:fs';
${guards}
const collector = (${createOutputCollector.toString()})(${JSON.stringify(ScriptOutputLimits)}, (${validateOutputOptions.toString()}), event => {
  appendFileSync(process.env.VELAROS_OUTPUT_FILE, JSON.stringify(event)+'\\n');
});
export const output = collector.output;
`
}

/** 授权能力与预装 npm 包共用加载入口，工作区依赖优先交给 Node 正常解析。 */
export async function nodeProgramSource(
  request: CodeRunRequest,
  catalog: string,
  cwd: string,
  capabilities: Readonly<Record<string, string>>,
  packageDirectory?: string,
  runtime?: NodeRuntimeEnvironment
): Promise<{ bootstrap: string; preload: string; entrypoint: string }> {
  const specifiers: Record<string, string> = Object.create(null)
  const sources: Record<string, string> = Object.create(null)
  const url = (path: string) => pathToFileURL(path).href
  const packageParents: Record<string, string> = Object.create(null)
  for (const name of NodeDefaultPackages)
    packageParents[name] = packageDirectory
      ? url(join(packageDirectory, 'package.json'))
      : import.meta.url
  for (const pkg of runtime?.packages ?? []) {
    if (Object.hasOwn(packageParents, pkg.name) && !isDefaultPackage(pkg.name))
      throw new AppError('CONFLICT', `运行环境包名重复：${pkg.name}`)
    packageParents[pkg.name] = url(join(pkg.directory, 'package.json'))
  }
  const isRuntimePackage = (name: string) =>
    Object.keys(packageParents).some((pkg) => name === pkg || name.startsWith(`${pkg}/`))
  for (const [name, file] of Object.entries(capabilities)) {
    if (
      isBuiltin(name) ||
      ['velaros', 'velaros:program'].includes(name) ||
      isRuntimePackage(name) ||
      Object.hasOwn(specifiers, name)
    )
      throw new AppError('CONFLICT', `能力包导入名冲突：${name}`)
    specifiers[name] = url(join(catalog, file))
    if (!name.includes(':')) {
      if (Object.hasOwn(capabilities, `velaros:${name}`))
        throw new AppError('CONFLICT', `能力包导入名冲突：velaros:${name}`)
      specifiers[`velaros:${name}`] = specifiers[name]!
    }
  }
  await writeFile(join(catalog, 'output.mjs'), outputModule(), { mode: 0o600 })
  await writeFile(
    join(catalog, 'program.mjs'),
    `
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
export const input = freeze(${isUndefined(request.input) ? 'undefined' : `JSON.parse(${JSON.stringify(JSON.stringify(request.input))})`});
export const blobs = freeze(JSON.parse(${JSON.stringify(JSON.stringify(request.blobs))}));
`,
    { mode: 0o600 }
  )
  specifiers['velaros:program'] = url(join(catalog, 'program.mjs'))
  specifiers.velaros = url(join(catalog, 'standard.mjs'))
  await writeFile(join(catalog, 'standard.mjs'), "export {output} from './output.mjs';\n", {
    mode: 0o600,
  })
  const packages = new Set<string>()
  for (const [index, pkg] of (request.packages ?? []).entries()) {
    if (
      packages.has(pkg.specifier) ||
      isBuiltin(pkg.specifier) ||
      isRuntimePackage(pkg.specifier) ||
      (Object.hasOwn(specifiers, pkg.specifier) && pkg.specifier !== 'velaros')
    )
      throw new AppError('CONFLICT', `能力包导入名冲突：${pkg.specifier}`)
    packages.add(pkg.specifier)
    const file = pkg.specifier === 'velaros' ? 'standard.mjs' : `package-${index}.mjs`
    const members = Object.entries(pkg.exports).filter(([, target]) =>
      Object.hasOwn(capabilities, target)
    )
    await writeFile(
      join(catalog, file),
      [
        ...(pkg.specifier === 'velaros' ? ["export {output} from './output.mjs';"] : []),
        ...members.map(
          ([name, target]) => `export * as ${JSON.stringify(name)} from ${JSON.stringify(target)};`
        ),
      ].join('\n'),
      { mode: 0o600 }
    )
    specifiers[pkg.specifier] = url(join(catalog, file))
  }
  const loader = join(catalog, 'loader.mjs')
  await writeFile(
    loader,
    `import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
const specifiers = JSON.parse(${JSON.stringify(JSON.stringify(specifiers))});
const packages = JSON.parse(${JSON.stringify(JSON.stringify(packageParents))});
export function resolve(specifier, context, nextResolve) {
  if (Object.hasOwn(specifiers, specifier)) return {url:specifiers[specifier], shortCircuit:true};
  if ((specifier.startsWith('velaros:') || specifier.startsWith('skill:'))) throw Object.assign(new Error('当前会话未授权包 '+specifier), {code:'PERMISSION'});
  try { return nextResolve(specifier, context); }
  catch (error) {
    const name = Object.keys(packages).find(name => specifier === name || specifier.startsWith(name+'/'));
    if (!name || !['ERR_MODULE_NOT_FOUND','MODULE_NOT_FOUND'].includes(error.code) || error.url) throw error;
    const parent = context.parentURL ?? ${JSON.stringify(url(join(cwd, 'package.json')))};
    if (parent.startsWith('file:') && createRequire(parent).resolve.paths(name)?.some(root => existsSync(join(root,name)))) throw error;
    if (context.conditions.includes('require')) return nextResolve(createRequire(packages[name]).resolve(specifier),context);
    return nextResolve(specifier, {...context, parentURL:packages[name]});
  }
}
`,
    { mode: 0o600 }
  )
  const preload = url(join(catalog, 'preload.mjs'))
  await writeFile(
    join(catalog, 'preload.mjs'),
    `import {registerHooks} from 'node:module'; import {resolve} from ${JSON.stringify(url(loader))}; registerHooks({resolve});\n`,
    { mode: 0o600 }
  )
  // 子进程只继承能力解析；本轮虚拟源码不遮蔽磁盘上同路径的普通脚本。
  const entry = url(resolve(cwd, request.path ?? '__velaros_program__.mjs'))
  sources[entry] = request.source
  for (const [path, source] of Object.entries(request.modules)) {
    const target = url(resolve(cwd, path))
    if (Object.hasOwn(sources, target)) throw new AppError('CONFLICT', `程序模块路径冲突：${path}`)
    sources[target] = source
  }
  const programLoader = join(catalog, 'program-loader.mjs')
  await writeFile(
    programLoader,
    `
const sources = JSON.parse(${JSON.stringify(JSON.stringify(sources))});
export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('file:')) {
    const target = new URL(specifier, context.parentURL).href;
    if (Object.hasOwn(sources, target)) return {url:target, shortCircuit:true};
  }
  return nextResolve(specifier, context);
}
export function load(url, context, nextLoad) {
  if (Object.hasOwn(sources, url)) return {format:'module', source:sources[url], shortCircuit:true};
  return nextLoad(url, context);
}
`,
    { mode: 0o600 }
  )
  const wrapper = join(catalog, 'entry.mjs')
  await writeFile(wrapper, `import * as exports from ${JSON.stringify(entry)}; export {exports};`, {
    mode: 0o600,
  })
  const bootstrap = `import {registerHooks} from 'node:module';
import ${JSON.stringify(preload)};
import {send,releaseCalls} from ${JSON.stringify(url(join(catalog, 'bridge.mjs')))};
import {resolve,load} from ${JSON.stringify(url(programLoader))};
registerHooks({resolve,load});
try {
  const {exports} = await import(${JSON.stringify(url(wrapper))});
  const names = Object.keys(exports);
  const value = names.length === 1 && names[0] === 'default' ? exports.default : names.length ? exports : undefined;
  await send('/result', {value});
} catch (error) {
  console.error(error.stack ?? error);
  const location = String(error.stack).split('\\n').find(line => line.includes(${JSON.stringify(`${entry}:`)}));
  const line = location?.slice(location.indexOf(${JSON.stringify(`${entry}:`)}) + ${JSON.stringify(`${entry}:`)}.length).match(/^([0-9]+):/);
  const message = String(error.message ?? error);
  const detail = message.length > ${CodeSurfaceLimits.failureChars} ? message.slice(0, ${CodeSurfaceLimits.failureChars})+'（字符省略，完整错误见输出日志）' : message;
  await send('/result', {error:{code:error.code ?? 'PROGRAM_ERROR', message:detail, ...(line ? {line:Number(line[1])} : {})}});
  process.exitCode = 1;
} finally { releaseCalls(); }
`
  const entrypoint = join(catalog, 'bootstrap.mjs')
  await writeFile(entrypoint, bootstrap, { mode: 0o600 })
  return { bootstrap, preload, entrypoint }
}
