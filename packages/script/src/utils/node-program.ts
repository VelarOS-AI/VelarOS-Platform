import { writeFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { isEmpty, isUndefined, toNullable, toOptional, TypeGuards } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { CodeSurfaceLimits, ScriptOutputLimits } from '../contract/constants.js'
import type { CodeRunRequest } from '../types/runner.js'

import { createOutputCollector, validateOutputOptions } from './output-capture.js'

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

/** 只为授权包和本次不可变程序补充解析；标准库、npm 与普通文件仍由 Node 链接。 */
export async function nodeProgramSource(
  request: CodeRunRequest,
  catalog: string,
  cwd: string,
  capabilities: Readonly<Record<string, string>>
): Promise<{ bootstrap: string; preload: string; entrypoint: string }> {
  const specifiers: Record<string, string> = Object.create(null)
  const sources: Record<string, string> = Object.create(null)
  const url = (path: string) => pathToFileURL(path).href
  for (const [name, file] of Object.entries(capabilities)) {
    if (
      isBuiltin(name) ||
      ['velaros', 'velaros:program'].includes(name) ||
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
    `const specifiers = JSON.parse(${JSON.stringify(JSON.stringify(specifiers))});
export async function resolve(specifier, context, nextResolve) {
  if (Object.hasOwn(specifiers, specifier)) return {url:specifiers[specifier], shortCircuit:true};
  if (specifier.startsWith('velaros:')) throw Object.assign(new Error('当前会话未授权包 '+specifier), {code:'PERMISSION'});
  return nextResolve(specifier, context);
}
`,
    { mode: 0o600 }
  )
  const preload = url(join(catalog, 'preload.mjs'))
  await writeFile(
    join(catalog, 'preload.mjs'),
    `import {register} from 'node:module'; register(${JSON.stringify(url(loader))}, import.meta.url);\n`,
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
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('file:')) {
    const target = new URL(specifier, context.parentURL).href;
    if (Object.hasOwn(sources, target)) return {url:target, shortCircuit:true};
  }
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
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
  const bootstrap = `import {register} from 'node:module';
import ${JSON.stringify(preload)};
import {send,releaseCalls} from ${JSON.stringify(url(join(catalog, 'bridge.mjs')))};
register(${JSON.stringify(url(programLoader))}, import.meta.url);
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
