// 受信进程只负责 IPC；模型程序在独立的 QuickJS WASM 堆中运行。
import { getQuickJS } from 'quickjs-emscripten'

const QuickJS = await getQuickJS()
const runtime = QuickJS.newRuntime()
runtime.setMemoryLimit(128 * 1024 * 1024)
runtime.setMaxStackSize(1024 * 1024)
const vm = runtime.newContext()
const pending = new Map()
let nextId = 0
let finished = false
let programHandle
const logs = []
let logChars = 0
let cpuRemaining = Infinity
let cpuDeadline = Infinity
runtime.setInterruptHandler(() => performance.now() >= cpuDeadline)

// 只在执行 QuickJS 指令期间计时；等待能力不消耗 CPU 预算，但也不能为同时运行的死循环停表。
function withCpuBudget(action) {
  if (cpuRemaining <= 0) throw Object.assign(new Error('脚本执行超时'), {code: 'TIMEOUT'})
  const started = performance.now()
  const outerDeadline = cpuDeadline
  cpuDeadline = Math.min(outerDeadline, started + cpuRemaining)
  try { return action() }
  finally {
    if (outerDeadline === Infinity) cpuRemaining -= performance.now() - started
    cpuDeadline = outerDeadline
  }
}

function readValue(handle) {
  return withCpuBudget(() => vm.dump(handle))
}

function finish(message) {
  if (finished) return
  finished = true
  // 独立进程立即退出，操作系统回收整个 WASM 堆；中断后不再运行用户 getter 或析构路径。
  pending.clear()
  process.send(message, undefined, undefined, () => process.exit(message.ok ? 0 : 1))
}

function pump() {
  if (finished) return
  const result = withCpuBudget(() => runtime.executePendingJobs())
  if (result.error) {
    const error = readValue(result.error)
    result.error.dispose()
    fail(error)
  }
}

function fail(error) {
  let message = String(error?.message ?? error)
  const library = /(?:at .*?\()?((?:lib\/)[A-Za-z0-9_./-]+\.js):(\d+)/u.exec(String(error?.stack))
  if (library) message += `（出在库里的 ${library[1]} 第 ${Math.max(1, Number(library[2]) - 1)} 行）`
  const matched = /program\.js:(\d+)/u.exec(String(error?.stack))
  const line = matched ? Number(matched[1]) - 1 : undefined
  finish({ type: 'done', ok: false, logs, error: {
    code: message.includes('out of memory') ? 'TOO_LARGE' : message.includes('interrupted') ? 'TIMEOUT' : (error?.code ?? 'PROGRAM_ERROR'),
    message, ...(line > 0 ? { line } : {}),
  } })
}

function expose(name, callback) {
  const handle = vm.newFunction(name, callback)
  vm.setProp(vm.global, name, handle)
  handle.dispose()
}

expose('__hostCall', (namespace, operation, input) => {
  const promise = vm.newPromise()
  const callId = ++nextId
  pending.set(callId, promise)
  process.send({ type: 'call', callId, namespace: vm.getString(namespace), operation: vm.getString(operation), input: JSON.parse(vm.getString(input)) })
  return promise.handle
})
expose('__hostLog', (text) => {
  const line = vm.getString(text).slice(0, 2000)
  if (logChars + line.length > 8000) return vm.undefined
  logChars += line.length
  logs.push(line)
  process.send({ type: 'log', line })
  return vm.undefined
})

function run(message) {
  if (!Number.isFinite(message.timeoutMs) || message.timeoutMs <= 0) throw new Error('缺少有限的执行预算')
  cpuRemaining = message.timeoutMs
  const bootstrap = `(() => {
    const config = ${JSON.stringify({ operations: message.operations, input: message.input, blobs: message.blobs, templates: message.templates, modules: message.modules })};
    const api = Object.create(null);
    for (const [namespace, operations] of Object.entries(config.operations)) {
      const methods = Object.create(null);
      for (const operation of operations) methods[operation] = async input => {
        const site = new Error('调用位置').stack;
        const response = JSON.parse(await __hostCall(namespace, operation, JSON.stringify(input ?? null)));
        if (!response.ok) throw Object.assign(new Error(response.error.message), {code: response.error.code, stack: site});
        return response.value;
      };
      api[namespace] = Object.freeze(methods);
    }
    // 数据编码在 QuickJS 堆内完成，不暴露宿主对象或环境权限。
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const invalidEncoding = () => Object.assign(new Error('Invalid character'), {name:'InvalidCharacterError'});
    globalThis.btoa = value => {
      const text=String(value);let out='';
      for(let i=0;i<text.length;i+=3){
        const a=text.charCodeAt(i),b=text.charCodeAt(i+1),c=text.charCodeAt(i+2);
        if(a>255||b>255||c>255)throw invalidEncoding();
        const bits=(a<<16)|((b||0)<<8)|(c||0);
        out+=alphabet[(bits>>>18)&63]+alphabet[(bits>>>12)&63]+(i+1<text.length?alphabet[(bits>>>6)&63]:'=')+(i+2<text.length?alphabet[bits&63]:'=');
      }
      return out;
    };
    globalThis.atob = value => {
      let text=String(value).replace(/[\\t\\n\\f\\r ]/g,'');
      if(text.length%4===0)text=text.replace(/={1,2}$/,'');
      if(text.length%4===1||/[^A-Za-z0-9+/]/.test(text))throw invalidEncoding();
      let bits=0,count=0,out='';
      for(const character of text){bits=(bits<<6)|alphabet.indexOf(character);count+=6;if(count>=8){count-=8;out+=String.fromCharCode((bits>>>count)&255);bits&=(1<<count)-1;}}
      return out;
    };
    const utf8 = point => point<128?[point]:point<2048?[192|(point>>>6),128|(point&63)]:point<65536?[224|(point>>>12),128|((point>>>6)&63),128|(point&63)]:[240|(point>>>18),128|((point>>>12)&63),128|((point>>>6)&63),128|(point&63)];
    globalThis.TextEncoder = class TextEncoder {
      get encoding(){return 'utf-8';}
      encode(value=''){
        const bytes=[];
        for(const character of String(value)){let point=character.codePointAt(0);if(point>=55296&&point<=57343)point=65533;bytes.push(...utf8(point));}
        return new Uint8Array(bytes);
      }
      encodeInto(value,destination){
        if(!(destination instanceof Uint8Array))throw new TypeError('destination must be Uint8Array');
        let read=0,written=0;
        for(const character of String(value)){let point=character.codePointAt(0);if(point>=55296&&point<=57343)point=65533;const bytes=utf8(point);if(written+bytes.length>destination.length)break;destination.set(bytes,written);read+=character.length;written+=bytes.length;}
        return {read,written};
      }
    };
    globalThis.console = Object.freeze({log: (...args) => __hostLog(args.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' '))});
    const program = Object.freeze({input: config.input, blobs: Object.freeze(config.blobs), template: name => {
      if (!Object.hasOwn(config.templates, name)) throw new Error('没有模块模板 ' + name + '；可用模块：' + Object.keys(config.templates).join('、'));
      return config.templates[name];
    }});
    const outputs = [];
    const standard = Object.freeze({
      modules: api['velaros:modules'] ?? api.modules,
      execution: api['velaros:execution'] ?? api.execution,
      programs: api['velaros:programs'] ?? api.programs,
      results: api['velaros:results'] ?? api.results,
      artifacts: api['velaros:artifacts'] ?? api.artifacts,
      output: value => { outputs.push(value); },
    });
    globalThis.__readOutputs = () => outputs;
    globalThis.__velaros = name => {
      if (name === 'velaros') return standard;
      if (name === 'velaros:program') return program;
      if (Object.hasOwn(api, name)) return api[name];
      if (typeof name !== 'string' || !name.startsWith('velaros:')) throw new Error('未知模块 ' + name);
      const namespace = name.slice('velaros:'.length);
      if (!Object.hasOwn(api, namespace)) throw new Error('未挂载模块 ' + name);
      return api[namespace];
    };
    globalThis.__libraryFactories = Object.create(null);
    const loaded = new Map();
    globalThis.__import = path => {
      if (loaded.has(path)) {
        const entry = loaded.get(path);
        if (entry.loading) throw new Error('脚本出现循环 import：' + path);
        return entry.promise;
      }
      if (!Object.hasOwn(config.modules, path)) throw new Error('不存在脚本 ' + path);
      const entry = {loading: true, promise: undefined};
      loaded.set(path, entry);
      entry.promise = __libraryFactories[path]();
      entry.loading = false;
      return entry.promise;
    };
  })()`
  const setup = withCpuBudget(() => vm.evalCode(bootstrap, 'bootstrap.js'))
  if (setup.error) { const error = readValue(setup.error); setup.error.dispose(); fail(error); return }
  setup.value.dispose()
  for (const [path, source] of Object.entries(message.modules)) {
    const compiled = vm.evalCode(`globalThis.__libraryFactories[${JSON.stringify(path)}] = async () => {\n${source}\n}`, path)
    if (compiled.error) { const error = readValue(compiled.error); compiled.error.dispose(); fail(error); return }
    compiled.value.dispose()
  }
  const evaluated = withCpuBudget(() => vm.evalCode(`(async () => {\n${message.source}\n})()`, 'program.js'))
  if (evaluated.error) { const error = readValue(evaluated.error); evaluated.error.dispose(); fail(error); return }
  programHandle = evaluated.value
  withCpuBudget(() => vm.resolvePromise(programHandle)).then(result => {
    if (finished) { result.value?.dispose(); result.error?.dispose(); return }
    if (result.error) { const error = readValue(result.error); result.error.dispose(); fail(error); return }
    let value = readValue(result.value)
    result.value.dispose()
    const explicit = withCpuBudget(() => vm.evalCode('__readOutputs()'))
    if (explicit.error) { const error = readValue(explicit.error); explicit.error.dispose(); fail(error); return }
    const outputs = readValue(explicit.value)
    explicit.value.dispose()
    if (outputs.length) value = { default: outputs.length === 1 ? outputs[0] : outputs }
    finish({ type: 'done', ok: true, value, logs })
  }).catch(fail)
  pump()
}

process.on('message', message => {
  if (finished) return
  if (message.type === 'program') { try { run(message) } catch (error) { fail(error) }; return }
  if (message.type !== 'result') return
  const waiter = pending.get(message.callId)
  if (!waiter) return
  pending.delete(message.callId)
  const text = vm.newString(JSON.stringify({ok: message.ok, value: message.value, error: message.error}))
  waiter.resolve(text)
  text.dispose()
  waiter.dispose()
  try { pump() } catch (error) { fail(error) }
})
const probe = vm.evalCode('[typeof process, typeof require, typeof fetch, typeof WebSocket].every(x => x === "undefined")')
const confined = !probe.error && vm.dump(probe.value) === true
probe.value?.dispose()
probe.error?.dispose()
process.send({ type: 'ready', confined })
