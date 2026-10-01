import { isEmpty, toNullable, toOptional, TypeGuards } from '@velaros-ai/core'

import { ScriptOutputLimits } from '../contract/constants.js'
import type { CodeRunRequest } from '../types/runner.js'

import { createOutputCollector, validateOutputOptions } from './output-capture.js'

const guards = { ...TypeGuards, isEmpty, toNullable, toOptional }
const guardSource = Object.entries(guards)
  .map(([name, guard]) => {
    const body = guard.toString()
    const source =
      /^(?:async\s+)?[\w$]+\s*\(/u.test(body) && !body.startsWith('function ')
        ? `function ${body}`
        : body
    return `const ${name}=(${source});`
  })
  .join('\n')

/** 为 QuickJS 构造能力桩、虚拟包和有界输出收集器，宿主对象不进入 guest。 */
export function createWorkerBootstrap(message: CodeRunRequest): string {
  const config = JSON.stringify({
    operations: message.operations,
    packages: message.packages ?? [],
    input: message.input,
    blobs: message.blobs,
    modules: message.modules,
  })
  return `(() => {
    const config = JSON.parse(${JSON.stringify(config)});
    const api = Object.create(null);
    for (const [namespace, operations] of Object.entries(config.operations)) {
      const methods = Object.create(null);
      for (const operation of operations)
        methods[operation] = async (input) => {
          const site = new Error('调用位置').stack;
          const response = JSON.parse(
            await __hostCall(namespace, operation, JSON.stringify(input ?? null)),
          );
          if (!response.ok)
            throw Object.assign(new Error(response.error.message), {
              code: response.error.code,
              stack: site,
            });
          return response.value;
        };
      api[namespace] = Object.freeze(methods);
    }
    // 数据编码在 QuickJS 堆内完成，不暴露宿主对象或环境权限。
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const invalidEncoding = () =>
      Object.assign(new Error('Invalid character'), { name: 'InvalidCharacterError' });
    globalThis.btoa = (value) => {
      const text = String(value);
      let out = '';
      for (let i = 0; i < text.length; i += 3) {
        const a = text.charCodeAt(i),
          b = text.charCodeAt(i + 1),
          c = text.charCodeAt(i + 2);
        if (a > 255 || b > 255 || c > 255) throw invalidEncoding();
        const bits = (a << 16) | ((b || 0) << 8) | (c || 0);
        out +=
          alphabet[(bits >>> 18) & 63] +
          alphabet[(bits >>> 12) & 63] +
          (i + 1 < text.length ? alphabet[(bits >>> 6) & 63] : '=') +
          (i + 2 < text.length ? alphabet[bits & 63] : '=');
      }
      return out;
    };
    globalThis.atob = (value) => {
      let text = String(value).replace(/[\\t\\n\\f\\r ]/g, '');
      if (text.length % 4 === 0) text = text.replace(/={1,2}$/, '');
      if (text.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(text)) throw invalidEncoding();
      let bits = 0,
        count = 0,
        out = '';
      for (const character of text) {
        bits = (bits << 6) | alphabet.indexOf(character);
        count += 6;
        if (count >= 8) {
          count -= 8;
          out += String.fromCharCode((bits >>> count) & 255);
          bits &= (1 << count) - 1;
        }
      }
      return out;
    };
    const utf8 = (point) =>
      point < 128
        ? [point]
        : point < 2048
          ? [192 | (point >>> 6), 128 | (point & 63)]
          : point < 65536
            ? [224 | (point >>> 12), 128 | ((point >>> 6) & 63), 128 | (point & 63)]
            : [
                240 | (point >>> 18),
                128 | ((point >>> 12) & 63),
                128 | ((point >>> 6) & 63),
                128 | (point & 63),
              ];
    globalThis.TextEncoder = class TextEncoder {
      get encoding() {
        return 'utf-8';
      }
      encode(value = '') {
        const bytes = [];
        for (const character of String(value)) {
          let point = character.codePointAt(0);
          if (point >= 55296 && point <= 57343) point = 65533;
          bytes.push(...utf8(point));
        }
        return new Uint8Array(bytes);
      }
      encodeInto(value, destination) {
        if (!(destination instanceof Uint8Array))
          throw new TypeError('destination must be Uint8Array');
        let read = 0,
          written = 0;
        for (const character of String(value)) {
          let point = character.codePointAt(0);
          if (point >= 55296 && point <= 57343) point = 65533;
          const bytes = utf8(point);
          if (written + bytes.length > destination.length) break;
          destination.set(bytes, written);
          read += character.length;
          written += bytes.length;
        }
        return { read, written };
      }
    };
    globalThis.console = Object.freeze({
      log: (...args) =>
        __hostLog(
          args.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join(' '),
        ),
    });
    const freezeData = (value) => {
      if (value && typeof value === 'object') {
        for (const item of Object.values(value)) freezeData(item);
        Object.freeze(value);
      }
      return value;
    };
    const program = Object.freeze({
      input: freezeData(config.input),
      blobs: Object.freeze(config.blobs),
    });
    const emitOutput = __hostOutput;
    delete globalThis.__hostOutput;
    const collector = (() => {
      ${guardSource}
      return (${createOutputCollector.toString()})(
        ${JSON.stringify(ScriptOutputLimits)},
        (${validateOutputOptions.toString()}),
        (event) => emitOutput(JSON.stringify(event)),
      );
    })();
    const packages = Object.create(null);
    for (const pkg of config.packages) {
      if (
        Object.hasOwn(packages, pkg.specifier) ||
        Object.hasOwn(api, pkg.specifier) ||
        pkg.specifier === 'velaros:program'
      )
        throw new Error('脚本包冲突 ' + pkg.specifier);
      const members = Object.create(null);
      for (const [name, target] of Object.entries(pkg.exports)) {
        if (!Object.hasOwn(api, target)) throw new Error('包成员未授权 ' + target);
        members[name] = api[target];
      }
      if (pkg.specifier === 'velaros') members.output = collector.output;
      packages[pkg.specifier] = Object.freeze(members);
    }
    const standard = packages.velaros ?? Object.freeze({ output: collector.output });
    globalThis.__readOutputs = () => collector.snapshot();
    globalThis.__velaros = (name) => {
      if (name === 'velaros') return standard;
      if (name === 'velaros:program') return program;
      if (Object.hasOwn(packages, name)) return packages[name];
      if (Object.hasOwn(api, name)) return api[name];
      if (typeof name !== 'string' || !name.startsWith('velaros:'))
        throw new Error('未知模块 ' + name);
      const namespace = name.slice('velaros:'.length);
      if (!Object.hasOwn(api, namespace)) throw new Error('未挂载模块 ' + name);
      return api[namespace];
    };
  })();`
}

/** 原生链接器中的合成模块只导出当前能力桥已有的值，不加载宿主文件。 */
export function createWorkerModules(message: CodeRunRequest): Readonly<Record<string, string>> {
  const modules: Record<string, string> = Object.create(null)
  const bridge = (specifier: string, names: readonly string[]): string =>
    `const api = globalThis.__velaros(${JSON.stringify(specifier)});\n${names
      .map(
        (name, index) =>
          `const value${index} = api[${JSON.stringify(name)}]; export { value${index} as ${name} };`
      )
      .join('\n')}`
  for (const [namespace, operations] of Object.entries(message.operations)) {
    modules[namespace] = bridge(namespace, operations)
    if (!namespace.includes(':')) modules[`velaros:${namespace}`] = modules[namespace]!
  }
  modules.velaros = bridge('velaros', ['output'])
  modules['velaros:program'] = bridge('velaros:program', ['input', 'blobs'])
  for (const pkg of message.packages ?? [])
    modules[pkg.specifier] = [
      ...(pkg.specifier === 'velaros' ? [bridge('velaros', ['output'])] : []),
      ...Object.entries(pkg.exports).map(
        ([name, target], index) =>
          `import * as member${index} from ${JSON.stringify(target)}; export { member${index} as ${name} };`
      ),
    ].join('\n')
  return modules
}
