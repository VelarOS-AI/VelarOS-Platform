/**
 * `velaros:browser`、`velaros:devtools` 与 `velaros:cdp` 的入参核对：形状、取值与上限在做事之前一次核对完，不合法当场 `VALIDATION`，空间端口一次都不调。
 * 上限都引 `contract/constants.ts` 的表——声明里写给模型的数字就是它们。顶层入参是严格对象：多给的字段直接拒绝，不静默丢掉。
 */

import { z } from 'zod'

import { isEmpty, isPresent } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import {
  BrowserActionLimits,
  BrowserCaptureLimits,
  BrowserConditionLimits,
  BrowserDiagnosticsLimits,
  BrowserEvaluateLimits,
  BrowserFetchLimits,
  BrowserInspectLimits,
  BrowserPendingEventLimits,
  BrowserPerformanceLimits,
  BrowserProtocolLimits,
  BrowserUserScriptLimits,
  BrowserWaitLimits,
} from '../contract/constants.js'
import type {
  BrowserClickInput,
  BrowserDialogInput,
  BrowserDownloadDecisionInput,
  BrowserDownloadInput,
  BrowserDragInput,
  BrowserEvaluateInput,
  BrowserFillInput,
  BrowserGotoInput,
  BrowserHoverInput,
  BrowserInsertTextInput,
  BrowserInspectInput,
  BrowserKeyInput,
  BrowserMouseButtonInput,
  BrowserMouseMoveInput,
  BrowserOpenInput,
  BrowserPermissionInput,
  BrowserPressInput,
  BrowserSavePdfInput,
  BrowserScreenshotInput,
  BrowserSwitchTabInput,
  BrowserUploadInput,
  BrowserWaitForEventInput,
  BrowserWaitForFunctionInput,
  BrowserWaitForLoadInput,
  BrowserWheelInput,
  CdpEventsInput,
  CdpSendInput,
  CdpWaitForEventInput,
  DevtoolsCreateUserScriptInput,
  DevtoolsDiagnosticsInput,
  DevtoolsEnableUserScriptInput,
  DevtoolsEnableUserScriptsInput,
  DevtoolsHeapSnapshotInput,
  DevtoolsInsightInput,
  DevtoolsMoveUserScriptInput,
  DevtoolsNetworkInput,
  DevtoolsRecordingInput,
  DevtoolsRequestInput,
  DevtoolsStopRecordingInput,
  DevtoolsTraceInput,
  DevtoolsUpdateUserScriptInput,
  DevtoolsUserScriptIdInput,
  DevtoolsZoomInput,
} from '../types/browser.js'
import type { BrowserClickRequest } from '../types/operations.js'

import { isKnownKeyName } from './keyboard.js'
import { BrowserTuning } from './tuning.js'

// ── 共用片段 ────────────────────────────────────────────────────

const selectorSchema = z.string().trim().min(1).max(BrowserInspectLimits.selectorChars)
const ignoreSelectorsSchema = z.array(selectorSchema).max(BrowserInspectLimits.ignoreSelectors).optional()
const urlSchema = z.string().trim().min(1).max(BrowserActionLimits.urlChars)
const coordinateSchema = z.number().int().min(0).max(BrowserActionLimits.coordinate)
const workspacePathSchema = z.string().trim().min(1).max(BrowserFetchLimits.pathChars)
const eventIdSchema = z.string().trim().min(1).optional()
const mouseButtonSchema = z.enum(['left', 'middle', 'right'])
const clickCountSchema = z.number().int().positive().max(BrowserActionLimits.clickCount)
const waitTimeoutSchema = z.number().int().positive().max(BrowserWaitLimits.maxMs).optional()
const keySchema = z
  .string()
  .min(1)
  .max(BrowserActionLimits.keyChars)
  .refine(isKnownKeyName, '不认识这个键：写 Enter、Tab、Escape、Backspace、ArrowDown、Home、F5 这类键名，或者一个字符')
const scriptSchema = z.string().min(1).max(BrowserEvaluateLimits.scriptChars)
const scriptArgsSchema = z
  .array(z.unknown())
  .refine((value) => jsonLength(value) <= BrowserEvaluateLimits.argsChars, `args 按 JSON 算超过 ${BrowserEvaluateLimits.argsChars} 个字符`)
  .optional()
const frameIdSchema = z.string().trim().min(1).optional()

/** 定位线索：ref、css、text、name、attributes 至少一样；字段都可以是 null（inspect 结果里的 target 原样传回时就是这样）。 */
const targetHintSchema = z
  .strictObject({
    ref: z.string().trim().min(1).nullish(),
    css: selectorSchema.nullish(),
    role: z.string().trim().min(1).nullish(),
    text: z.string().nullish(),
    name: z.string().nullish(),
    frame: z
      .strictObject({
        css: selectorSchema.nullish(),
        name: z.string().nullish(),
        title: z.string().nullish(),
        url: z.string().nullish(),
      })
      .nullish(),
    attributes: z.record(z.string(), z.string()).optional(),
  })
  .refine(
    (value) => !!value.ref || !!value.css || !!value.text || !!value.name || !isEmpty(Object.keys(value.attributes ?? {})),
    'target 至少要有 ref、css、text、name、attributes 中的一样'
  )
const targetSchema = z.union([z.string().trim().min(1).max(BrowserInspectLimits.selectorChars), targetHintSchema])

/** 一个值按 JSON 写出来有多少字符：args 与 CDP 的 params 按它限长。 */
function jsonLength(value: unknown): number {
  return JSON.stringify(value).length
}

/** 核对一次入参：不合法抛 `VALIDATION`，message 点名是哪个操作、哪几个字段不对。 */
function parseInput<T>(schema: z.ZodType, input: unknown, operation: string): T {
  const parsed = schema.safeParse(input ?? {})
  if (parsed.success) return parsed.data as T
  const issues = parsed.error.issues.slice(0, BrowserTuning.input.reportedIssues).map((issue) => {
    const path = issue.path.map(String).join('.')
    return isEmpty(path) ? issue.message : `${path}：${issue.message}`
  })
  throw new AppError('VALIDATION', `${operation} 的入参不对——${issues.join('；')}`)
}

// ── velaros:browser ───────────────────────────────────────────────

const openSchema = z.strictObject({ url: urlSchema })
const switchTabSchema = z.strictObject({ targetId: z.string().trim().min(1) })
const inspectSchema = z.strictObject({
  maxTextChars: z.number().int().positive().max(BrowserInspectLimits.textChars).optional(),
  includeHtml: z.boolean().optional(),
  maxHtmlChars: z.number().int().positive().max(BrowserInspectLimits.htmlChars).optional(),
  maxElements: z.number().int().positive().max(BrowserInspectLimits.elements).optional(),
  ignoreSelectors: ignoreSelectorsSchema,
})
const regionSchema = z.union([
  z.strictObject({ selector: selectorSchema }),
  z.strictObject({
    x: z.number().int().min(0).max(BrowserCaptureLimits.regionMaxSide),
    y: z.number().int().min(0).max(BrowserCaptureLimits.regionMaxSide),
    width: z.number().int().min(1).max(BrowserCaptureLimits.regionMaxSide),
    height: z.number().int().min(1).max(BrowserCaptureLimits.regionMaxSide),
  }),
])
const screenshotSchema = z.strictObject({
  path: z.string().trim().min(1).max(BrowserCaptureLimits.pathChars).optional(),
  fullPage: z.boolean().optional(),
  region: regionSchema.optional(),
  annotate: z.boolean().optional(),
  width: z.number().int().min(BrowserCaptureLimits.minViewportWidth).max(BrowserCaptureLimits.maxViewportWidth).optional(),
  height: z.number().int().min(BrowserCaptureLimits.minViewportHeight).max(BrowserCaptureLimits.maxViewportHeight).optional(),
  waitForNetworkIdle: z
    .union([z.boolean(), z.number().int().min(BrowserCaptureLimits.minNetworkIdleMs).max(BrowserCaptureLimits.maxNetworkIdleMs)])
    .optional(),
  waitForDomStable: z.boolean().optional(),
  compareWithPrevious: z.boolean().optional(),
})
const evaluateSchema = z.strictObject({
  script: scriptSchema,
  args: scriptArgsSchema,
  frame: frameIdSchema,
  timeoutMs: z.number().int().positive().max(BrowserEvaluateLimits.timeoutMs).optional(),
})
const clickSchema = z
  .strictObject({
    target: targetSchema.optional(),
    x: coordinateSchema.optional(),
    y: coordinateSchema.optional(),
    button: mouseButtonSchema.optional(),
    clickCount: clickCountSchema.optional(),
    waitForNavigation: z.boolean().optional(),
  })
  .refine(
    (value) => isPresent(value.target) !== (isPresent(value.x) || isPresent(value.y)) && isPresent(value.x) === isPresent(value.y),
    'target 与 x、y 只给一样：点元素给 target，点坐标给 x 和 y'
  )
const fillSchema = z.strictObject({ target: targetSchema, value: z.string().max(BrowserActionLimits.textChars) })
const hoverSchema = z.strictObject({ target: targetSchema })
const insertTextSchema = z.strictObject({ text: z.string().min(1).max(BrowserActionLimits.textChars) })
const pressSchema = z.strictObject({
  key: keySchema,
  modifiers: z.array(z.enum(['shift', 'control', 'alt', 'meta'])).max(4).optional(),
  repeat: z.number().int().positive().max(BrowserActionLimits.keyRepeat).optional(),
  waitForNavigation: z.boolean().optional(),
})
const singleKeySchema = z.strictObject({
  key: keySchema.refine((key) => !/.\+./u.test(key), '一次一个键：组合键先 keyDown 修饰键，或者用 press'),
})
const mouseMoveSchema = z.strictObject({
  x: coordinateSchema,
  y: coordinateSchema,
  steps: z.number().int().positive().max(BrowserActionLimits.moveSteps).optional(),
})
const mouseButtonInputSchema = z.strictObject({ button: mouseButtonSchema.optional(), clickCount: clickCountSchema.optional() })
const wheelDeltaSchema = z.number().int().min(-BrowserActionLimits.coordinate).max(BrowserActionLimits.coordinate)
const wheelSchema = z
  .strictObject({ deltaX: wheelDeltaSchema.optional(), deltaY: wheelDeltaSchema.optional() })
  .refine((value) => isPresent(value.deltaX) || isPresent(value.deltaY), '至少给 deltaX、deltaY 中的一个')
const dragSchema = z.strictObject({
  source: targetSchema,
  target: targetSchema,
  steps: z.number().int().positive().max(BrowserActionLimits.moveSteps).optional(),
  waitForNavigation: z.boolean().optional(),
})
const uploadSchema = z.strictObject({ target: targetSchema, filePath: workspacePathSchema })
const gotoSchema = z.strictObject({ url: urlSchema })
const waitForFunctionSchema = z.strictObject({
  script: scriptSchema,
  args: scriptArgsSchema,
  frame: frameIdSchema,
  timeoutMs: waitTimeoutSchema,
  intervalMs: z.number().int().min(BrowserWaitLimits.minIntervalMs).max(BrowserWaitLimits.maxIntervalMs).optional(),
})
const waitForLoadSchema = z.strictObject({
  state: z.enum(['domcontentloaded', 'load', 'networkidle']).optional(),
  timeoutMs: waitTimeoutSchema,
})
const waitForEventSchema = z.strictObject({
  kind: z.enum(['dialog', 'download', 'permission']).optional(),
  timeoutMs: z.number().int().positive().max(BrowserPendingEventLimits.maxWaitMs).optional(),
})
const dialogSchema = z.strictObject({ eventId: eventIdSchema, accept: z.boolean(), promptText: z.string().optional() })
const downloadDecisionSchema = z
  .strictObject({ eventId: eventIdSchema, savePath: workspacePathSchema.optional(), cancel: z.boolean().optional() })
  .refine((value) => !!value.cancel !== isPresent(value.savePath), '要么给 savePath 保存，要么 cancel: true 取消，只给一样')
const permissionSchema = z.strictObject({ eventId: eventIdSchema, grant: z.boolean() })
const downloadSchema = z.strictObject({
  url: z.string().trim().url().max(BrowserFetchLimits.pathChars),
  savePath: workspacePathSchema,
  referer: z.string().trim().url().max(BrowserFetchLimits.pathChars).optional(),
})
const savePdfSchema = z.strictObject({ path: workspacePathSchema.optional() })

/** open 的入参。 */
export function openInput(input: unknown): BrowserOpenInput {
  return parseInput(openSchema, input, 'open')
}

/** switchTab 的入参。 */
export function switchTabInput(input: unknown): BrowserSwitchTabInput {
  return parseInput(switchTabSchema, input, 'switchTab')
}

/** inspect 的入参。 */
export function inspectInput(input: unknown): BrowserInspectInput {
  return parseInput(inspectSchema, input, 'inspect')
}

/** screenshot 的入参。 */
export function screenshotInput(input: unknown): BrowserScreenshotInput {
  return parseInput(screenshotSchema, input, 'screenshot')
}

/** evaluate 的入参。 */
export function evaluateInput(input: unknown): BrowserEvaluateInput {
  return parseInput(evaluateSchema, input, 'evaluate')
}

/** click 的入参：核对完分成点元素与点坐标两种。 */
export function clickInput(input: unknown): BrowserClickRequest {
  const { target, x, y, ...options }: BrowserClickInput = parseInput(clickSchema, input, 'click')
  if (isPresent(target)) return { kind: 'target', target, ...options }
  return { kind: 'point', x: x ?? 0, y: y ?? 0, ...options }
}

/** fill 的入参。 */
export function fillInput(input: unknown): BrowserFillInput {
  return parseInput(fillSchema, input, 'fill')
}

/** hover 的入参。 */
export function hoverInput(input: unknown): BrowserHoverInput {
  return parseInput(hoverSchema, input, 'hover')
}

/** insertText 的入参。 */
export function insertTextInput(input: unknown): BrowserInsertTextInput {
  return parseInput(insertTextSchema, input, 'insertText')
}

/** press 的入参。 */
export function pressInput(input: unknown): BrowserPressInput {
  return parseInput(pressSchema, input, 'press')
}

/** keyDown、keyUp 的入参。 */
export function keyInput(input: unknown, operation: 'keyDown' | 'keyUp'): BrowserKeyInput {
  return parseInput(singleKeySchema, input, operation)
}

/** mouseMove 的入参。 */
export function mouseMoveInput(input: unknown): BrowserMouseMoveInput {
  return parseInput(mouseMoveSchema, input, 'mouseMove')
}

/** mouseDown、mouseUp 的入参。 */
export function mouseButtonInput(input: unknown, operation: 'mouseDown' | 'mouseUp'): BrowserMouseButtonInput {
  return parseInput(mouseButtonInputSchema, input, operation)
}

/** wheel 的入参。 */
export function wheelInput(input: unknown): BrowserWheelInput {
  return parseInput(wheelSchema, input, 'wheel')
}

/** drag 的入参。 */
export function dragInput(input: unknown): BrowserDragInput {
  return parseInput(dragSchema, input, 'drag')
}

/** upload 的入参。 */
export function uploadInput(input: unknown): BrowserUploadInput {
  return parseInput(uploadSchema, input, 'upload')
}

/** goto 的入参。 */
export function gotoInput(input: unknown): BrowserGotoInput {
  return parseInput(gotoSchema, input, 'goto')
}

/** waitForFunction 的入参。 */
export function waitForFunctionInput(input: unknown): BrowserWaitForFunctionInput {
  return parseInput(waitForFunctionSchema, input, 'waitForFunction')
}

/** waitForLoad 的入参。 */
export function waitForLoadInput(input: unknown): BrowserWaitForLoadInput {
  return parseInput(waitForLoadSchema, input, 'waitForLoad')
}

/** waitForEvent 的入参。 */
export function waitForEventInput(input: unknown): BrowserWaitForEventInput {
  return parseInput(waitForEventSchema, input, 'waitForEvent')
}

/** handleDialog 的入参。 */
export function dialogInput(input: unknown): BrowserDialogInput {
  return parseInput(dialogSchema, input, 'handleDialog')
}

/** handleDownload 的入参。 */
export function downloadDecisionInput(input: unknown): BrowserDownloadDecisionInput {
  return parseInput(downloadDecisionSchema, input, 'handleDownload')
}

/** handlePermission 的入参。 */
export function permissionInput(input: unknown): BrowserPermissionInput {
  return parseInput(permissionSchema, input, 'handlePermission')
}

/** download 的入参。 */
export function downloadInput(input: unknown): BrowserDownloadInput {
  return parseInput(downloadSchema, input, 'download')
}

/** savePdf 的入参。 */
export function savePdfInput(input: unknown): BrowserSavePdfInput {
  return parseInput(savePdfSchema, input, 'savePdf')
}

// ── velaros:devtools ──────────────────────────────────────────────

const diagnosticsSchema = z.strictObject({
  kind: z.enum(['all', 'console', 'network', 'page_error']).optional(),
  limit: z.number().int().positive().max(BrowserDiagnosticsLimits.entries).optional(),
  clear: z.boolean().optional(),
  level: z.enum(['debug', 'info', 'log', 'warning', 'error']).optional(),
  errorsOnly: z.boolean().optional(),
  status: z.number().int().min(100).max(BrowserDiagnosticsLimits.networkStatus).optional(),
  resourceType: z.string().trim().min(1).max(BrowserDiagnosticsLimits.resourceTypeChars).optional(),
  failedOnly: z.boolean().optional(),
})
const requestSchema = z.strictObject({
  requestId: z.string().trim().min(1).max(BrowserDiagnosticsLimits.requestIdChars),
  includeResponseBody: z.boolean().optional(),
  maxBodyChars: z.number().int().positive().max(BrowserDiagnosticsLimits.responseBodyChars).optional(),
})
const zoomSchema = z
  .strictObject({
    action: z.enum(['in', 'out', 'reset', 'set']),
    zoomFactor: z.number().min(BrowserConditionLimits.minZoomFactor).max(BrowserConditionLimits.maxZoomFactor).optional(),
    step: z.number().min(BrowserConditionLimits.minZoomStep).max(BrowserConditionLimits.maxZoomStep).optional(),
  })
  .refine((value) => value.action !== 'set' || isPresent(value.zoomFactor), { message: 'action 是 set 时要给 zoomFactor', path: ['zoomFactor'] })
const headersSchema = z.record(
  z.string().min(1).max(BrowserConditionLimits.headerNameChars),
  z.string().max(BrowserConditionLimits.headerValueChars)
)
const urlPatternSchema = z.string().min(1).max(BrowserConditionLimits.urlPatternChars)
const networkSchema = z
  .strictObject({
    offline: z.boolean().optional(),
    extraHTTPHeaders: headersSchema.optional(),
    blockedURLPatterns: z.array(urlPatternSchema).max(BrowserConditionLimits.blockedUrlPatterns).optional(),
    blockedResourceTypes: z.array(z.string().min(1).max(80)).max(BrowserConditionLimits.blockedResourceTypes).optional(),
    mockResponses: z
      .array(
        z.strictObject({
          urlPattern: urlPatternSchema,
          status: z.number().int().min(100).max(599).optional(),
          contentType: z.string().min(1).max(200).optional(),
          body: z.string().max(BrowserConditionLimits.mockBodyChars).optional(),
          headers: headersSchema.optional(),
        })
      )
      .max(BrowserConditionLimits.mockResponses)
      .optional(),
  })
  .refine((value) => Object.values(value).some(isPresent), '至少要设一样：offline、extraHTTPHeaders、blockedURLPatterns、blockedResourceTypes 或 mockResponses')
const traceSchema = z.strictObject({
  reload: z.boolean().optional(),
  autoStopMs: z.number().int().min(BrowserPerformanceLimits.minTraceMs).max(BrowserPerformanceLimits.maxTraceMs).nullable().optional(),
})
const insightSchema = z.strictObject({
  insightSetId: z.string().trim().min(1).max(BrowserPerformanceLimits.insightIdChars),
  insightName: z.string().trim().min(1).max(BrowserPerformanceLimits.insightIdChars),
})
const heapSnapshotSchema = z.strictObject({ path: z.string().trim().min(1).max(BrowserPerformanceLimits.snapshotPathChars).optional() })
const recordingSchema = z.strictObject({
  maxWidth: z.number().int().min(BrowserCaptureLimits.minScreencastWidth).max(BrowserCaptureLimits.maxScreencastWidth).optional(),
  everyNthFrame: z.number().int().min(1).max(BrowserCaptureLimits.maxScreencastFrameStep).optional(),
})
const stopRecordingSchema = z.strictObject({ name: z.string().trim().min(1).max(BrowserCaptureLimits.screencastNameChars).optional() })
const userScriptIdSchema = z.strictObject({ id: z.string().trim().min(1) })
const matchRulesSchema = z.array(z.string().min(1).max(BrowserUserScriptLimits.matchRuleChars)).max(BrowserUserScriptLimits.matchRules)
const userScriptFields = {
  name: z.string().min(1).max(BrowserUserScriptLimits.nameChars),
  code: z.string().min(1).max(BrowserUserScriptLimits.codeBytes),
  description: z.string().max(BrowserUserScriptLimits.descriptionChars).optional(),
  version: z.string().min(1).max(BrowserUserScriptLimits.versionChars).optional(),
  match: matchRulesSchema.min(1),
  excludeMatch: matchRulesSchema.optional(),
  runAt: z.enum(['document-start', 'document-end', 'document-idle']).optional(),
  world: z.enum(['isolated', 'main']).optional(),
}
const createUserScriptSchema = z.strictObject(userScriptFields)
const updateUserScriptSchema = z
  .strictObject({
    id: z.string().trim().min(1),
    name: userScriptFields.name.optional(),
    code: userScriptFields.code.optional(),
    description: userScriptFields.description,
    version: userScriptFields.version,
    match: userScriptFields.match.optional(),
    excludeMatch: userScriptFields.excludeMatch,
    runAt: userScriptFields.runAt,
    world: userScriptFields.world,
  })
  .refine(({ id: _id, ...patch }) => Object.values(patch).some(isPresent), '至少要改一样')
const enableUserScriptSchema = z.strictObject({ id: z.string().trim().min(1), enabled: z.boolean() })
const enableUserScriptsSchema = z.strictObject({ enabled: z.boolean() })
const moveUserScriptSchema = z.strictObject({ id: z.string().trim().min(1), direction: z.enum(['up', 'down']) })

/** diagnostics 的入参。 */
export function diagnosticsInput(input: unknown): DevtoolsDiagnosticsInput {
  return parseInput(diagnosticsSchema, input, 'diagnostics')
}

/** request 的入参。 */
export function requestInput(input: unknown): DevtoolsRequestInput {
  return parseInput(requestSchema, input, 'request')
}

/** zoom 的入参。 */
export function zoomInput(input: unknown): DevtoolsZoomInput {
  return parseInput(zoomSchema, input, 'zoom')
}

/** network 的入参。 */
export function networkInput(input: unknown): DevtoolsNetworkInput {
  return parseInput(networkSchema, input, 'network')
}

/** startTrace 的入参。 */
export function traceInput(input: unknown): DevtoolsTraceInput {
  return parseInput(traceSchema, input, 'startTrace')
}

/** insight 的入参。 */
export function insightInput(input: unknown): DevtoolsInsightInput {
  return parseInput(insightSchema, input, 'insight')
}

/** heapSnapshot 的入参。 */
export function heapSnapshotInput(input: unknown): DevtoolsHeapSnapshotInput {
  return parseInput(heapSnapshotSchema, input, 'heapSnapshot')
}

/** startRecording 的入参。 */
export function recordingInput(input: unknown): DevtoolsRecordingInput {
  return parseInput(recordingSchema, input, 'startRecording')
}

/** stopRecording 的入参。 */
export function stopRecordingInput(input: unknown): DevtoolsStopRecordingInput {
  return parseInput(stopRecordingSchema, input, 'stopRecording')
}

/** 只要一个用户脚本 id 的那几个操作的入参。 */
export function userScriptIdInput(input: unknown, operation: string): DevtoolsUserScriptIdInput {
  return parseInput(userScriptIdSchema, input, operation)
}

/** createUserScript 的入参。 */
export function createUserScriptInput(input: unknown): DevtoolsCreateUserScriptInput {
  return parseInput(createUserScriptSchema, input, 'createUserScript')
}

/** updateUserScript 的入参。 */
export function updateUserScriptInput(input: unknown): DevtoolsUpdateUserScriptInput {
  return parseInput(updateUserScriptSchema, input, 'updateUserScript')
}

/** enableUserScript 的入参。 */
export function enableUserScriptInput(input: unknown): DevtoolsEnableUserScriptInput {
  return parseInput(enableUserScriptSchema, input, 'enableUserScript')
}

/** enableUserScripts 的入参。 */
export function enableUserScriptsInput(input: unknown): DevtoolsEnableUserScriptsInput {
  return parseInput(enableUserScriptsSchema, input, 'enableUserScripts')
}

/** moveUserScript 的入参。 */
export function moveUserScriptInput(input: unknown): DevtoolsMoveUserScriptInput {
  return parseInput(moveUserScriptSchema, input, 'moveUserScript')
}

// ── velaros:cdp ───────────────────────────────────────────────────

const protocolMethodSchema = z
  .string()
  .trim()
  .min(1)
  .max(BrowserProtocolLimits.methodChars)
  .regex(/^[A-Z][A-Za-z]*\.[a-zA-Z]+$/u, 'method 写成「域.方法」，如 DOM.getDocument')
const protocolMethodFilterSchema = z
  .string()
  .trim()
  .min(1)
  .max(BrowserProtocolLimits.methodChars)
  .regex(/^[A-Z][A-Za-z]*\.(?:[a-zA-Z]+)?$/u, 'method 写成完整方法名（Network.responseReceived）或以点结尾的域（Network.）')
const sendSchema = z.strictObject({
  method: protocolMethodSchema,
  params: z
    .record(z.string(), z.unknown())
    .refine((value) => jsonLength(value) <= BrowserProtocolLimits.paramsChars, `params 按 JSON 算超过 ${BrowserProtocolLimits.paramsChars} 个字符`)
    .optional(),
  session: z.string().trim().min(1).max(BrowserProtocolLimits.sessionChars).optional(),
})
const eventCursorSchema = z.number().int().min(0).optional()
const eventsSchema = z.strictObject({ method: protocolMethodFilterSchema.optional(), after: eventCursorSchema })
const protocolWaitSchema = z.strictObject({
  method: protocolMethodFilterSchema,
  after: eventCursorSchema,
  timeoutMs: waitTimeoutSchema,
})

/** send 的入参。 */
export function sendInput(input: unknown): CdpSendInput {
  return parseInput(sendSchema, input, 'send')
}

/** events 的入参。 */
export function eventsInput(input: unknown): CdpEventsInput {
  return parseInput(eventsSchema, input, 'events')
}

/** velaros:cdp 的 waitForEvent 的入参。 */
export function protocolWaitInput(input: unknown): CdpWaitForEventInput {
  return parseInput(protocolWaitSchema, input, 'waitForEvent')
}
