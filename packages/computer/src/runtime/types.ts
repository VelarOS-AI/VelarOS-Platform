/** Phase 1 desktop-control command surface shared by mac/win helpers. */
export type ComputerCommand =
  | 'check'
  | 'screen_size'
  | 'screenshot'
  | 'mouse_move'
  | 'left_click'
  | 'type'
  | 'key'

/** A request sent to the Python helper over the stdio protocol. */
export interface ComputerHelperRequest {
  id: number
  command: ComputerCommand
  payload: Record<string, unknown>
}

/** A successful response decoded from the helper. */
export interface ComputerHelperSuccess<TResult = unknown> {
  id: number | null
  ok: true
  result: TResult
}

/** A failure response decoded from the helper. */
export interface ComputerHelperFailure {
  id: number | null
  ok: false
  error: { code: string; message: string }
}

export type ComputerHelperResponse<TResult = unknown> =
  | ComputerHelperSuccess<TResult>
  | ComputerHelperFailure

/** Result of `check` — desktop-control availability and OS permissions. */
export interface ComputerPermissionStatus {
  platform: string
  accessibility: boolean
  screenRecording: boolean | null
}

/** Result of `screen_size`. */
export interface ComputerScreenSize {
  displayId: number
  width: number
  height: number
  scaleFactor: number
  originX: number
  originY: number
}

/** Result of `screenshot`. */
export interface ComputerScreenshot {
  base64: string
  format: 'jpeg'
  /** 图片宽度（逻辑分辨率，等于 displayWidth）；与点击坐标空间 1:1 一致。 */
  width: number
  /** 图片高度（逻辑分辨率，等于 displayHeight）；与点击坐标空间 1:1 一致。 */
  height: number
  displayWidth: number
  displayHeight: number
  displayId: number
  originX: number
  originY: number
  scaleFactor: number
}

export interface ComputerMoveResult {
  x: number
  y: number
}

export interface ComputerClickResult {
  x: number
  y: number
  button: string
  count: number
}

export interface ComputerTypeResult {
  typed: number
}

export interface ComputerKeyResult {
  pressed: string[]
}

/** Why the desktop-control sidecar is unavailable, surfaced to the agent/UI. */
export type ComputerAvailabilityReason =
  | 'available'
  | 'unsupported-platform'
  | 'python-missing'
  | 'helper-missing'
  | 'dependencies-missing'
  | 'permission-missing'
  | 'spawn-failed'

export interface ComputerAvailability {
  available: boolean
  reason: ComputerAvailabilityReason
  detail: string | null
  permissions?: ComputerPermissionStatus
}
