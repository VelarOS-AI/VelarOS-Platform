/** 拉起 helper 子进程的默认办法；只有 sidecar 用它，是本包唯一碰 child_process 的地方。 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'

import type { ComputerSidecarProcess } from '../contract/requires.js'
import type { ComputerHelperLaunchSpec } from '../types/computer.js'

/**
 * 默认辅助进程启动器。两项行为是刻意设计：
 * - **参数数组直传，不经过命令解释器**：解释器和脚本路径由 helper 定位器从固定布局解析，
 *   不拼接命令行字符串，因而不产生命令注入面。
 * - **继承父进程环境**：辅助程序是随插件分发的自包含虚拟环境，需要 `PATH`、`HOME` 等信息定位
 *   系统接口与显示会话。这里只额外固定两个 Python 行为开关，关闭缓冲并禁止写入 `.pyc`，保证
 *   标准输入输出协议实时且不在插件目录生成编译产物。
 */
export function spawnComputerHelperProcess(spec: ComputerHelperLaunchSpec): ComputerSidecarProcess {
  const child: ChildProcessWithoutNullStreams = spawn(
    spec.pythonCommand,
    [spec.helperScript],
    {
      cwd: spec.runtimeDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' },
    }
  )
  return child
}
