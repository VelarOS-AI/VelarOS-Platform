/** helper 进程的 stdio 线协议（行分隔 JSON）上流过的形状；只在包内用。 */

/** mac/win/linux helper 共用的命令面。 */
export type ComputerCommand =
  | 'capabilities'
  | 'windows'
  | 'screenshot_window'
  | 'focus_window'
  | 'scroll'
  | 'drag'
  | 'mouse_down'
  | 'mouse_up'
  | 'key_down'
  | 'key_up'
  | 'release_inputs'
  | 'ui_tree'
  | 'invoke_element'
  | 'set_element_value'
  | 'record'
  | 'check'
  | 'screen_size'
  | 'screenshot'
  | 'mouse_move'
  | 'left_click'
  | 'type'
  | 'key'

/** 发给 Python helper 的一次请求。 */
export interface ComputerHelperRequest {
  id: number
  command: ComputerCommand
  payload: Record<string, unknown>
}

/** 解码出来的成功应答。 */
export interface ComputerHelperSuccess<TResult = unknown> {
  id: Nullable<number>
  ok: true
  result: TResult
}

/** 解码出来的失败应答；`error.code` 取自合同里的 helper 错误码表。 */
export interface ComputerHelperFailure {
  id: Nullable<number>
  ok: false
  error: { code: string; message: string }
}

export type ComputerHelperResponse<TResult = unknown> =
  ComputerHelperSuccess<TResult> | ComputerHelperFailure
