// 完整门禁先核对原生测试依赖，环境不支持时明确失败而非跳过测试。
import { spawnSync } from 'node:child_process'

const failures = []
if (!['linux', 'darwin'].includes(process.platform)) {
  failures.push(
    `完整 Runtime 测试需要原生进程隔离；当前 ${process.platform} 不支持 read-only 隔离。请使用 CI Ubuntu 环境或受支持的 Linux/macOS 环境。`
  )
}
for (const [command, args] of [
  ['bun', ['--version']],
  ['rg', ['--version']],
  ...(process.platform === 'linux' ? [['bwrap', ['--ro-bind', '/', '/', '--', '/bin/true']]] : []),
]) {
  const result = spawnSync(command, args, { stdio: 'pipe', timeout: 10000, encoding: 'utf8' })
  if (result.error || result.status !== 0) {
    failures.push(
      `${command} 前置检查失败：${result.error?.message ?? result.stderr ?? result.status}`
    )
  }
}
if (failures.length) {
  console.error(failures.join('\n'))
  console.error('门禁未执行、未通过；不会降低隔离或跳过必要测试。')
  process.exitCode = 1
} else {
  console.log('完整门禁环境前置检查通过。')
}
