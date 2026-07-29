import type { ComputerAvailability } from '@velaros-ai/computer-runtime'
import { AppError } from '@velaros-ai/core/error'

import type { ComputerToolContext } from './Types'

/**
 * Guard run before any desktop action: confirm the sidecar is available and the
 * OS permissions are granted, raising a user-readable error otherwise. This is
 * the "unavailable" surface (missing Python/deps/display/permission) made
 * visible to the model instead of a raw crash.
 *
 * Note on consent model: enabling Computer Use (an opt-in, off-by-default tool
 * category) is itself the user's authorization. We therefore do NOT pop a
 * per-action confirmation card for each click/type/key — the only remaining
 * gate is the OS-level permission (Accessibility / Screen Recording), which the
 * user grants in System Settings and which `ensureAvailable` surfaces here.
 *
 * Provisioning stance: Computer Use is an **install-to-use marketplace plugin**.
 * Its Python sidecar + dependencies ship as a downloadable artifact carrying a
 * self-contained venv (see scripts/build/packageComputerUseResources.mjs); the
 * user installs it from the plugin marketplace and the runtime lights up. The
 * runtime must never be provisioned by installing packages onto the user's
 * machine. So when it is not provisioned we deliberately tell the agent NOT to
 * run pip/shell installs — the only valid remedy is a user-driven plugin install
 * — to stop the model from polluting the user's system/global Python.
 */
export async function requireComputerAvailable(ctx: ComputerToolContext): Promise<void> {
  const availability = await ctx.computer.ensureAvailable()
  if (availability.available) return

  throw new AppError('PERMISSION', unavailableMessage(availability))
}

/** Build a reason-specific, non-self-install gate message for the agent/UI. */
function unavailableMessage(availability: ComputerAvailability): string {
  const detail = availability.detail?.trim()
  const suffix = detail ? `（${detail}）` : ''

  switch (availability.reason) {
    case 'permission-missing':
      // The one gate the agent should route to the user: OS-level permission.
      return `桌面控制被系统权限拦截${suffix}。请在「系统设置 → 隐私与安全性」为本应用授予「辅助功能」和「屏幕录制」权限，然后重试；不要尝试绕过权限。`

    case 'unsupported-platform':
      return `当前操作系统不支持桌面控制（Computer Use）${suffix}。请说明该平台暂不可用，不要尝试安装或搭建替代环境。`

    case 'python-missing':
    case 'helper-missing':
    case 'dependencies-missing':
    case 'spawn-failed':
    default:
      // Runtime not provisioned. Computer Use is an install-to-use plugin; do
      // NOT let the model pip/shell-install onto the host — route to the install.
      return (
        `桌面控制运行时尚未安装（${availability.reason}）${suffix}。` +
        `Computer Use 是「需安装才能使用」的插件，其 Python sidecar 与依赖随插件产物一起分发（自带 venv）——` +
        `请【不要】用 pip、shell 或任何命令在用户机器上安装 Python 依赖或自行搭建环境。` +
        `正确做法：向用户说明需要在「设置 → 插件市场」安装 Computer Use 插件；` +
        `以 blocking 的用户动作卡呈现该阻塞，等待用户安装完成后再重试，而不是自动安装。`
      )
  }
}
