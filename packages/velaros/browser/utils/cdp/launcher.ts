/** 找外部浏览器、拉起外部浏览器时用不着实例状态的那部分：候选路径、用户的 Chrome 配置目录、启动参数、调试端口文件的解析。 */

import { join, posix, win32 } from 'node:path'

import { isPresent } from '@velaros-ai/core'
import { isEmpty, isNonBlankString, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type {
  CdpDevToolsActivePort,
  CdpExternalBrowserChildProcess,
  CdpExternalBrowserLaunchOptions,
} from '../../types/cdp.js'
import type { CdpChromeStderrDiagnostics, CdpExternalBrowserLaunchEnv } from '../../types/cdp.js'
import { BrowserTuning } from '../tuning'

/** 判断这次拉起浏览器的失败值不值得再试一次。 */
export function shouldRetryLaunchAttempt(error: unknown, attempt: number): boolean {
  if (attempt >= BrowserTuning.externalBrowser.launchMaxAttempts) return false

  const appError = AppError.from(error)
  return appError.code === 'EXECUTION_FAILED'
}

/** 在 Linux 上补几个让 Chrome 在容器里跑得住的启动参数。 */
export function addLinuxChromeStabilityFlags(
  args: string[],
  runtime: {
    env: CdpExternalBrowserLaunchEnv
    platform: NodeJS.Platform
  }
): void {
  if (runtime.platform !== 'linux') return
  if (!isString(runtime.env.CI)) return

  if (!args.includes('--no-sandbox')) {
    args.push('--no-sandbox')
  }
  if (!args.includes('--disable-dev-shm-usage')) {
    args.push('--disable-dev-shm-usage')
  }
}

/** 按平台列出 Chrome 可能装在哪几个位置。 */
export function getExecutablePathCandidates(platform: NodeJS.Platform): string[] {
  if (platform === 'darwin')
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ]

  if (platform === 'win32') {
    const roots = [
      process.env.LOCALAPPDATA,
      process.env.PROGRAMFILES,
      process.env['PROGRAMFILES(X86)'],
    ].filter((root): root is string => isNonBlankString(root))
    return roots.flatMap((root) => [
      join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(root, 'Chromium', 'Application', 'chrome.exe'),
      join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(root, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    ])
  }

  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/microsoft-edge',
    '/usr/bin/brave-browser',
  ]
}

/** 收一行 Chrome 的 stderr，保留最近的若干行备用。 */
export function pushChromeStderrLine(diagnostics: CdpChromeStderrDiagnostics, line: string): void {
  const trimmed = line.trim()
  if (!trimmed) return

  diagnostics.lines.push(trimmed)
  if (diagnostics.lines.length > BrowserTuning.externalBrowser.stderrMaxLines) {
    diagnostics.lines.shift()
  }
}

/** 从 Chrome 的 stderr 里挑出真正有诊断价值的几行。 */
export function selectChromeStderrDiagnostics(lines: string[]): string[] {
  const relevant = lines.filter((line) => {
    const lower = line.toLowerCase()
    return (
      lower.includes('error') ||
      lower.includes('fatal') ||
      lower.includes('sandbox') ||
      lower.includes('namespace') ||
      lower.includes('permission') ||
      lower.includes('cannot') ||
      lower.includes('failed') ||
      lower.includes('abort')
    )
  })
  if (!isEmpty(relevant)) return relevant.slice(-5)

  return lines.slice(-5)
}

/** 判断 Chrome 的 stderr 是不是在抱怨沙箱。 */
export function hasSandboxStderr(lines: string[]): boolean {
  return lines.some((line) => {
    const lower = line.toLowerCase()
    return lower.includes('sandbox') || lower.includes('namespace')
  })
}

/**
 * 按平台列出用户自己的 Chrome 的默认用户数据目录，正式版、Beta、Dev、Canary 的先后（与 puppeteer 的 resolveDefaultUserDataDir 同一套）。
 * 拿不到主目录时不猜：只列还拼得出来的。
 */
export function getDefaultUserDataDirCandidates(
  platform: NodeJS.Platform,
  runtime: { home: string; env: CdpExternalBrowserLaunchEnv }
): string[] {
  const home = runtime.home.trim()
  if (platform === 'win32') {
    const localAppData =
      runtime.env.LOCALAPPDATA?.trim() || (home ? win32.join(home, 'AppData', 'Local') : '')
    if (!localAppData) return []
    return ['Chrome', 'Chrome Beta', 'Chrome Dev', 'Chrome SxS'].map((channel) =>
      win32.join(localAppData, 'Google', channel, 'User Data')
    )
  }
  if (platform === 'darwin') {
    if (!home) return []
    return ['Chrome', 'Chrome Beta', 'Chrome Dev', 'Chrome Canary'].map((channel) =>
      posix.join(home, 'Library', 'Application Support', 'Google', channel)
    )
  }
  const configHome =
    runtime.env.CHROME_CONFIG_HOME?.trim() ||
    runtime.env.XDG_CONFIG_HOME?.trim() ||
    (home ? posix.join(home, '.config') : '')
  if (!configHome) return []
  return [
    'google-chrome',
    'google-chrome-beta',
    'google-chrome-unstable',
    'google-chrome-canary',
  ].map((channel) => posix.join(configHome, channel))
}

/** 用户数据目录里调试端口文件的路径，按那个平台的路径写法拼。 */
export function devToolsActivePortPath(userDataDir: string, platform: NodeJS.Platform): string {
  return (platform === 'win32' ? win32 : posix).join(userDataDir, 'DevToolsActivePort')
}

/** 解析 DevToolsActivePort：第一行端口、第二行浏览器级 WebSocket 路径；缺一行或形状不对（Chrome 写到一半）就当没有。 */
export function parseDevToolsActivePort(content: string): Nullable<CdpDevToolsActivePort> {
  const [rawPort = '', rawPath = ''] = content.split(/\r?\n/u).map((line) => line.trim())
  const port = Number.parseInt(rawPort, 10)
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return null
  if (!rawPath.startsWith('/devtools/browser/')) return null
  return { port, browserWebSocketPath: rawPath }
}

/** 浏览器级 WebSocket 的地址：Chrome 的调试端口只听本机回环口。 */
export function buildBrowserWebSocketUrl(activePort: CdpDevToolsActivePort): string {
  return `ws://127.0.0.1:${activePort.port}${activePort.browserWebSocketPath}`
}

/** 拼一次拉起 Chrome 的完整命令行参数。起始页是空白页：每次 launch 都另开自己的标签页，起始页只撑着窗口。 */
export function buildLaunchArgs(
  userDataDir: string,
  options: CdpExternalBrowserLaunchOptions,
  runtime: {
    env: CdpExternalBrowserLaunchEnv
    platform: NodeJS.Platform
  }
): string[] {
  const profileDirectory = options.profileDirectory?.trim()
  const useRealKeychain = options.useRealKeychain || isNonBlankString(profileDirectory)
  const args = [
    '--remote-debugging-port=0',
    // 让 Chrome 明示此独立窗口正受自动化控制。带产品名的调试横幅属于
    // chrome.debugger 扩展；这里的原始 CDP 传输使用 Chrome 原生自动化提示。
    '--enable-automation',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-backgrounding-occluded-windows',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-hang-monitor',
    '--disable-popup-blocking',
    '--disable-prompt-on-repost',
    '--disable-sync',
    '--disable-features=Translate',
    '--metrics-recording-only',
  ]
  if (!useRealKeychain) {
    args.push('--password-store=basic')
    args.push('--use-mock-keychain')
  }
  args.push(`--user-data-dir=${userDataDir}`)
  if (isNonBlankString(profileDirectory)) {
    args.push(`--profile-directory=${profileDirectory}`)
  }
  args.push(...(options.args ?? []))
  addLinuxChromeStabilityFlags(args, runtime)
  // 会话由 Target.createTarget 创建页面；启动时不要再额外生成占位空白页。
  args.push('--no-startup-window')

  return args
}

/** 收一段 Chrome 的 stderr 输出，按行并进诊断缓冲。 */
export function recordChromeStderrChunk(
  diagnostics: CdpChromeStderrDiagnostics,
  chunk: unknown
): void {
  const text = isString(chunk) ? chunk : String(chunk)
  const parts = `${diagnostics.pending}${text}`.split(/\r?\n/u)
  diagnostics.pending = parts.pop() ?? ''
  for (const part of parts) {
    pushChromeStderrLine(diagnostics, part)
  }
}

/** Chrome 早退时拼一句带退出码与 stderr 要点的报错。 */
export function formatChromeEarlyExitMessage(
  child: CdpExternalBrowserChildProcess,
  stderr: CdpChromeStderrDiagnostics
): string {
  if (stderr.pending.trim()) {
    pushChromeStderrLine(stderr, stderr.pending)
    stderr.pending = ''
  }

  const status = isPresent(child.exitCode)
    ? `exitCode=${child.exitCode}`
    : `signal=${child.signalCode ?? 'unknown'}`
  const lines = selectChromeStderrDiagnostics(stderr.lines)
  if (isEmpty(lines)) return `外部浏览器启动失败，进程在写入 DevToolsActivePort 前退出：${status}`

  const hint = hasSandboxStderr(lines)
    ? '\nHint: Linux/CI/容器环境可尝试在外部浏览器 args 中加入 --no-sandbox。'
    : ''
  return (
    [
      `外部浏览器启动失败，进程在写入 DevToolsActivePort 前退出：${status}`,
      'Chrome stderr:',
      ...lines.map((line) => `  ${line}`),
    ].join('\n') + hint
  )
}

/** 接上子进程的 stderr，边跑边留最近的若干行备用。 */
export function captureChromeStderr(
  child: CdpExternalBrowserChildProcess
): CdpChromeStderrDiagnostics {
  const diagnostics: CdpChromeStderrDiagnostics = { lines: [], pending: '' }
  const stderr = child.stderr
  if (!stderr) return diagnostics

  stderr.setEncoding?.('utf8')
  stderr.on('data', (chunk) => {
    recordChromeStderrChunk(diagnostics, chunk)
  })
  let chunk = stderr.read?.()
  while (isPresent(chunk)) {
    recordChromeStderrChunk(diagnostics, chunk)
    chunk = stderr.read?.()
  }

  return diagnostics
}
