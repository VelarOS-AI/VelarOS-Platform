import type { KernelCapabilityOperationMetadata } from '@velaros-ai/kernel/contracts/abi'

function operation(permissions: readonly string[], reason: string): KernelCapabilityOperationMetadata {
  return Object.freeze({ permissions: Object.freeze([...permissions]), reason })
}

/** Shared by Kernel permission enforcement and host tool discovery. */
export const ComputerOperationMetadata = Object.freeze({
  ensure_available: operation(['process:exec'], 'Check whether the desktop-control sidecar is available.'),
  screen_size: operation(['process:exec', 'screen:capture'], 'Read the active display dimensions.'),
  screenshot: operation(['process:exec', 'screen:capture'], 'Capture the active display.'),
  mouse_move: operation(['process:exec', 'input:control'], 'Move the system pointer.'),
  left_click: operation(['process:exec', 'input:control'], 'Click at a display coordinate.'),
  type_text: operation(['process:exec', 'input:control'], 'Type text into the active application.'),
  key: operation(['process:exec', 'input:control'], 'Send a bounded keyboard chord.'),
})

export type ComputerOperation = keyof typeof ComputerOperationMetadata

/** Agent tool names and their corresponding callable capability operations. */
export const ComputerToolOperations = Object.freeze({
  'computer:screenshot': 'screenshot',
  'computer:screen_size': 'screen_size',
  'computer:move': 'mouse_move',
  'computer:click': 'left_click',
  'computer:type': 'type_text',
  'computer:key': 'key',
} satisfies Record<string, ComputerOperation>)
