/** 工作区落盘与归一化的工作类型；只在包内流动，不随可移植入口出包。 */

import type { NormalizedWordInput, OfficeSystemCommandResult } from './office.js'

/** office 工具写出文件后的统一回执。 */
export type OfficeOutput = {
  path: string
  bytes: number
  created: boolean
  changed: boolean
  kind: 'docx' | 'pptx' | 'xlsx' | 'pdf'
}

/** Word 输入归一化的结果：成功给归一化后的输入，失败给原路径、待回收的临时目录与命令结果。 */
export type NormalizeWordInputResult =
  | { success: true; input: NormalizedWordInput }
  | {
      success: false
      originalPath: string
      tempDir: Nullable<string>
      commandResult: OfficeSystemCommandResult
    }

