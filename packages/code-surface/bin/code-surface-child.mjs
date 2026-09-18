// 隔离进程侧的引导：把模型的程序跑起来，能力全部走 IPC 回宿主。
//
// 宿主用 `node --permission` 起它：文件系统与起子进程由运行时拦死。**网络拦不住**
// （Node 的权限模型不覆盖 socket），所以这个运行器只能开发期用，正式发版前换 WASM 里的 QuickJS。
// 程序源码经 IPC 送进来、**不落盘**——落盘等于凭空多一个可读文件。
// 本文件自己不引任何模块，也不碰 fs/网络。

const pending = new Map()
let nextId = 0
const logs = []

function call(namespace, operation, input) {
  const callId = (nextId += 1)
  // 发起调用这一刻的栈上有程序那一帧；回音到的时候已经没有了，所以现在就记下来。
  const site = new Error('发起能力调用').stack
  return new Promise((resolve, reject) => {
    pending.set(callId, { resolve, reject, site })
    process.send({ type: 'call', callId, namespace, operation, input })
  })
}

/**
 * 能力报的错换成程序里的异常：错误对象是在收回音时造的，它自己的栈上没有程序的帧；
 * 换上发起调用时记下的那几帧，程序没接住时才报得出是哪一行发起的这次调用。
 */
function capabilityError(waiter, error) {
  const failure = Object.assign(new Error(error.message), { code: error.code })
  const frames = typeof waiter.site === 'string' ? waiter.site.split('\n').slice(1).join('\n') : ''
  failure.stack = `Error: ${error.code}\n${frames}`
  return failure
}

function buildApi(operations) {
  const api = {}
  for (const [namespace, names] of Object.entries(operations)) {
    const bound = {}
    for (const operation of names) bound[operation] = (input) => call(namespace, operation, input)
    api[namespace] = Object.freeze(bound)
  }
  return api
}

async function runProgram(message) {
  const api = buildApi(message.operations)
  const consoleShim = {
    log: (...args) => {
      const line = args.map((value) => (typeof value === 'string' ? value : safeStringify(value))).join(' ')
      logs.push(line)
      // 界面要实时看见程序跑到哪了；模型那边不走这条路，日志随最终结果一起回。
      process.send({ type: 'log', line })
    },
  }
  /**
   * 模型写的是真 ES 模块，宿主在送进来之前已经把 `import` 改写成 `__velar(...)`、
   * 导出改写成登记到 `__exports` 上、末尾统一交出（模型写的那些行行号一个不变，所以抛错的行号仍对得上）。
   * 这里只要给出 `__velar`：按模块名取那个命名空间的桩，取不到就抛——
   * 能走到这里说明检查已经过了，取不到只可能是宿主授权与改写对不上，该响不该默默给个空对象。
   */
  const programModule = Object.freeze({ blobs: Object.freeze({ ...message.blobs }) })
  const resolveModule = (specifier) => {
    // 这次运行本身的环境，恒常授权：我们发明的东西要导入，语言自带的（console）不动。
    if (specifier === 'velar:program') return programModule
    const namespace = typeof specifier === 'string' && specifier.startsWith('velar:') ? specifier.slice(6) : ''
    const bound = api[namespace]
    if (!bound) throw new Error(`宿主没有授权模块 ${specifier}，它不该通过检查。`)
    return bound
  }
  // 能力以**形参**注入而不是全局：全局会被程序自己改掉，形参改不动外面。
  const body = `${ProgramPrefix}${message.source}\n})()`
  const program = new Function('__velar', 'console', body)
  return program(resolveModule, consoleShim)
}

function safeStringify(value) {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

process.on('message', (message) => {
  if (message.type === 'result') {
    const waiter = pending.get(message.callId)
    if (!waiter) return
    pending.delete(message.callId)
    // 宿主拒绝（审批被拒、危险命令被挡）在程序里是一个能 try/catch 的异常，不是一份静默的空回执。
    if (message.ok) waiter.resolve(message.value)
    else waiter.reject(capabilityError(waiter, message.error))
    return
  }
  if (message.type !== 'program') return
  runProgram(message).then(
    (value) => finish({ type: 'done', ok: true, value, logs }),
    (error) => finish({
      type: 'done',
      ok: false,
      logs,
      error: {
        message: error?.message ?? String(error),
        // 栈里的行号减掉包装占的那几行，才是模型写的那一行（见 ProgramLineOffset）。
        line: readProgramLine(error?.stack),
      },
    })
  )
})

/** 包在程序外面的那一截；程序正文从它后面一行开始。 */
const ProgramPrefix = '"use strict";\nreturn (async () => {\n'

/**
 * 程序第 1 行在栈里是第几行，减 1。
 *
 * **量出来，不写死**：`new Function` 自己会在正文前面加几行（引擎不同加得不同），外面这截包装也可能改。
 * 写死过一次——包装改了两行、这里还减 1，报给模型的行号一直差 3，而运行时行号从没被测过。
 * 所以启动时拿同样的前缀、同步抛一次，看它落在第几行。
 */
const ProgramLineOffset = (() => {
  try {
    new Function('__velar', 'console', `${ProgramPrefix.replace('async ', '')}throw new Error('probe')\n})()`)()
  } catch (error) {
    const matched = /<anonymous>:(\d+):\d+/u.exec(String(error?.stack))
    if (matched) return Number(matched[1]) - 1
  }
  return 0
})()

/** 从栈里挖出程序自己的行号；挖不到就不给，宁可不说也不要报一个错的位置。 */
function readProgramLine(stack) {
  if (typeof stack !== 'string') return undefined
  const matched = /<anonymous>:(\d+):\d+/u.exec(stack)
  if (!matched) return undefined
  const line = Number(matched[1]) - ProgramLineOffset
  return Number.isInteger(line) && line >= 1 ? line : undefined
}

/**
 * 送完再退出。
 *
 * `process.send` 对大负载是异步的，紧跟着 `process.exit` 会把还没冲出去的那条消息整个丢掉——
 * 宿主只看见进程退出、看不见结果，于是把一次正常跑完误判成崩溃。实测 45,000 字符的返回值必中。
 */
function finish(message) {
  process.send(message, undefined, undefined, () => process.exit(message.ok ? 0 : 1))
}

/**
 * 开工之前先自证：我到底有没有被关住。
 *
 * **不能只相信旗标。** `child_process.fork` 默认拿 `process.execPath` 起子进程——宿主跑在 bun 下时
 * fork 出来的是 bun，而 `--permission` 是 node 的旗标，bun 直接忽略，隔离等于没有，
 * 可命令行看着完全正常。这是最坏的一类失败：静默失效。
 * 所以这里真去做一次该被拒绝的动作，做成了就说明没关住，宿主据此拒绝把程序发进来。
 */
async function proveConfined() {
  try {
    const fs = await import('node:fs')
    // 读 node/bun 自己这个可执行文件：任何平台上都存在，且不在放行名单里，关住了就必须失败。
    fs.readFileSync(process.execPath)
    return false
  } catch {
    return true
  }
}

proveConfined().then((confined) => process.send({ type: 'ready', confined }))
