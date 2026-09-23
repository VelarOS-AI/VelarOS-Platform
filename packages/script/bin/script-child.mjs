// Node IPC 启动壳；QuickJS 内核由独立 worker 入口提供。
import { AppError } from '@velaros-ai/core/error'

import { startScriptWorker } from '../dist/worker.js'

await startScriptWorker({
  send: (message) =>
    new Promise((resolve, reject) => {
      if (!process.connected || !process.send) {
        reject(new AppError('CLOSED', '父进程 IPC 已关闭'))
        return
      }
      process.send(message, (error) => (error ? reject(error) : resolve()))
    }),
  onMessage: (listener) => {
    process.on('message', listener)
    return () => process.removeListener('message', listener)
  },
  exit: (code) => process.exit(code),
})
