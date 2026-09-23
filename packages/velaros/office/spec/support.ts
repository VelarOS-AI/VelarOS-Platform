/**
 * 验收测试与实现测试共用的夹具：
 * - 一个临时工作区加一份空间端口替身：记下交给宿主的每条原生命令，按给定名单回答「本机装没装」；
 *   converters 为 'working' 时替身像真的 LibreOffice / tectonic 那样在 --outdir 里产出一份 PDF，为 'failing' 时命令失败并带一段日志；
 * - 经真的能力端口挂上 `velaros:office` 九个操作的空间，以及照生成的声明跑一段模型程序的代码面会话。
 * 放在 spec 下，因为验收测试依赖它们；实现测试也从这里取。
 */

import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import JSZip from 'jszip'
import { PDFDocument, StandardFonts } from 'pdf-lib'

import { AppError } from '@velaros-ai/core/error'
import type { CapabilityOperationContext } from '@velaros-ai/script'
import {
  codeProgramChecker,
  createCapabilityPort,
  createCodeSurfaceSession,
  nodeSubprocessCodeRunner,
} from '@velaros-ai/script'

import type {
  OfficeNativeCommand,
  OfficeOperationContext,
  OfficeSystemCommandResult,
} from '../index.js'
import { officeOperations } from '../index.js'

/** 一个临时工作区与它的空间端口替身。 */
export interface OfficeHarness {
  root: string
  context: OfficeOperationContext
  /** 交给宿主执行过的原生命令，按顺序记下来。 */
  commands: OfficeNativeCommand[]
  /** 删掉这个临时工作区。 */
  cleanup(): Promise<void>
}

/** 造一个工作区加一份空间端口替身；availableCommands 是本机「装了」的命令，converters 决定替身跑命令时的表现。 */
export async function createHarness(
  options: { availableCommands?: string[]; converters?: 'working' | 'failing' } = {}
): Promise<OfficeHarness> {
  const root = await mkdtemp(join(tmpdir(), 'velaros-office-spec-'))
  const available = new Set(options.availableCommands ?? [])
  const commands: OfficeNativeCommand[] = []
  const context: OfficeOperationContext = {
    abortSignal: new AbortController().signal,
    office: {
      getRootPath: () => root,
      inspectEnvironment: async (names) => ({
        commands: (names ?? []).map((name) => ({
          name,
          available: available.has(name),
          path: available.has(name) ? `/usr/bin/${name}` : null,
        })),
      }),
      runCommand: async (command, commandOptions) => {
        commands.push(command)
        if (options.converters === 'failing')
          return commandResult(
            command,
            commandOptions.cwd,
            false,
            '! Undefined control sequence.\nl.3 \\badmacro'
          )
        if (options.converters === 'working') await produceConverterOutput(command)
        return commandResult(command, commandOptions.cwd, true, '')
      },
      // 替身一律回答「没装」：本机装没装 MarkItDown 不该影响验收结果。
      locateMarkItDown: () => null,
    },
  }
  return { root, context, commands, cleanup: () => rm(root, { recursive: true, force: true }) }
}

/** 一条命令的结果：成败与一段输出。 */
function commandResult(
  command: OfficeNativeCommand,
  cwd: string,
  success: boolean,
  stdout: string
): OfficeSystemCommandResult {
  return {
    command: command.file,
    cwd,
    exitCode: success ? 0 : 1,
    signal: null,
    stdout,
    stderr: '',
    durationMs: 1,
    timedOut: false,
    aborted: false,
    truncated: false,
    success,
    verification: { kind: 'unknown', status: 'unknown', issues: [] },
  }
}

/** 像 LibreOffice（--outdir 目录 + 最后一个参数是输入）与 tectonic（--outdir 目录 + 源文件）那样，在输出目录里产出同名 PDF。 */
async function produceConverterOutput(command: OfficeNativeCommand): Promise<void> {
  const outdirIndex = command.args.indexOf('--outdir')
  if (outdirIndex < 0) return
  const outdir = command.args[outdirIndex + 1]!
  const source = command.args.at(-1)!
  await writeFile(
    join(outdir, `${basename(source, extname(source))}.pdf`),
    await pdfWithPages([`converted from ${basename(source)}`])
  )
}

/** 一份每页一行文字的 PDF（pdf-lib 的标准字体写的，pdfjs 读得出文字）。 */
export async function pdfWithPages(texts: readonly string[]): Promise<Uint8Array> {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  for (const text of texts) document.addPage().drawText(text, { x: 72, y: 700, size: 14, font })
  return document.save()
}

/** 在工作区里放一份文件（父目录一并建好）。 */
export async function putFile(
  root: string,
  path: string,
  content: string | Uint8Array
): Promise<string> {
  const target = join(root, path)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content)
  return target
}

/** 读出 OOXML 产物里的 docProps 文本，用来核对元数据里有没有产品名。 */
export async function readDocumentProperties(path: string): Promise<string> {
  const zip = await JSZip.loadAsync(await readFile(path))
  const parts = await Promise.all(
    Object.keys(zip.files)
      .filter((name) => name.startsWith('docProps/'))
      .map(async (name) => zip.file(name)?.async('string') ?? '')
  )
  return parts.join('\n')
}

/** 一个挂着 `velaros:office` 的空间：经真的能力端口调九个操作，取消信号跟着每次调用。 */
export function officeSpace(context: OfficeOperationContext) {
  const hostContext = (call: CapabilityOperationContext): OfficeOperationContext => ({
    ...context,
    abortSignal: call.signal ?? new AbortController().signal,
  })
  const capabilities = createCapabilityPort({
    office: {
      createWord: (input, call) => officeOperations.createWord(input as never, hostContext(call)),
      createPresentation: (input, call) =>
        officeOperations.createPresentation(input as never, hostContext(call)),
      createSpreadsheet: (input, call) =>
        officeOperations.createSpreadsheet(input as never, hostContext(call)),
      readPdf: (input, call) => officeOperations.readPdf(input as never, hostContext(call)),
      wordToPdf: (input, call) => officeOperations.wordToPdf(input as never, hostContext(call)),
      latexToPdf: (input, call) => officeOperations.latexToPdf(input as never, hostContext(call)),
      editPdf: (input, call) => officeOperations.editPdf(input as never, hostContext(call)),
      preview: (input, call) => officeOperations.preview(input as never, hostContext(call)),
      toMarkdown: (input, call) => officeOperations.toMarkdown(input as never, hostContext(call)),
    },
  })
  /** 像模型的程序那样调一次：成功交回返回值，失败抛带 code 的错误（程序看得到的就这两样）。入参与返回值都过一遍 JSON。 */
  const call = async (operation: string, input?: unknown): Promise<any> => {
    const outcome = await capabilities.invoke({
      namespace: 'office',
      operation,
      input: input === undefined ? undefined : JSON.parse(JSON.stringify(input)),
    })
    if (outcome.error)
      throw Object.assign(new Error(outcome.error.message), { code: outcome.error.code })
    return outcome.value === undefined ? undefined : JSON.parse(JSON.stringify(outcome.value))
  }
  return { capabilities, call }
}

/** 等一个调用失败，交出它的码与说明。 */
export async function failureOf(
  call: Promise<unknown>
): Promise<{ code: string; message: string }> {
  try {
    await call
  } catch (error) {
    const failure = error as { code?: string; message?: string }
    return {
      code: failure.code ?? AppError.from(error).code,
      message: failure.message ?? String(error),
    }
  }
  throw new Error('应当失败，却成功了')
}

// ── 代码面 ──────────────────────────────────────────────────────

/** 模型这一轮读到的 `velaros:office` 声明：就是提交进仓的那份生成物，程序照着它过 typecheck。 */
export const OfficeDeclarations = readFileSync(
  fileURLToPath(new URL('../../../../baselines/script/office.d.ts', import.meta.url)),
  'utf8'
)

/** 这一轮授给程序的模块：只有 `office` 一个命名空间。 */
const Granted = [{ namespace: 'office', declarations: OfficeDeclarations }]

/** 只照生成的声明做 typecheck、不执行：交回诊断，过了就是空的。 */
export function checkModelProgram(source: string) {
  const checked = codeProgramChecker.check({ source, granted: Granted })
  return checked.ok ? [] : checked.diagnostics
}

/** 让一段真程序照生成的声明过 typecheck，再在隔离里跑完：交出程序的结果。 */
export async function runModelProgram(
  space: ReturnType<typeof officeSpace>,
  source: string,
  timeoutMs = 60_000
) {
  const session = createCodeSurfaceSession({
    checker: codeProgramChecker,
    runner: nodeSubprocessCodeRunner,
    capabilities: space.capabilities,
  })
  const outcome = await session.submit({ program: { source }, granted: Granted, timeoutMs })
  if (!outcome.checked) {
    const why =
      'needsModules' in outcome
        ? `要先补模块 ${outcome.needsModules.join(', ')}`
        : JSON.stringify(outcome.check.diagnostics)
    throw new Error(`程序没过 typecheck：${why}`)
  }
  return outcome.result
}
