/** 拉起 helper 子进程的默认办法；只有 sidecar 用它，是本单元唯一碰 child_process 的地方。 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'

import type { ComputerSidecarProcess } from '../contract/requires.js'
import type { ComputerHelperLaunchSpec } from '../types/computer.js'

/**
 * 默认辅助进程启动器。两项行为是刻意设计：
 * - **参数数组直传，不经过命令解释器**：解释器和脚本路径由 helper 定位器从固定布局解析，
 *   不拼接命令行字符串，因而不产生命令注入面。
 * - **继承父进程环境**：辅助程序是随插件分发的自包含虚拟环境，需要 `PATH`、`HOME` 等信息定位
 *   系统接口与显示会话。这里固定 UTF-8 管道编码，关闭缓冲并禁止写入 `.pyc`，保证
 *   标准输入输出协议实时且不在插件目录生成编译产物。
 */
export function spawnComputerHelperProcess(spec: ComputerHelperLaunchSpec): ComputerSidecarProcess {
  const child: ChildProcessWithoutNullStreams = spawn(spec.pythonCommand, [spec.helperScript], {
    cwd: spec.runtimeDir,
    // 原生 helper 是后台服务，Windows 下不能额外弹出控制台窗口。
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONIOENCODING: 'utf-8',
    },
  })
  // exit 先于管道排空；管理器只有在 close 之后才能清空这一代的响应与诊断缓冲。
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    on(
      event: 'error' | 'exit',
      listener: ((error: Error) => void) | ((code: Nullable<number>) => void)
    ) {
      child.on(event === 'exit' ? 'close' : event, listener)
    },
    kill(signal) {
      child.kill(signal)
    },
  }
}
