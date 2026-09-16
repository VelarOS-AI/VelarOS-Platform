/** 每个桌面动作前的可用性门禁，以及不可用时按原因给智能体与界面的文案。 */

import { AppError } from '@velaros-ai/core/error'

import type { ComputerToolContext } from '../contract/requires.js'
import type { ComputerAvailability, ComputerPermissionStatus } from '../types/computer.js'

/**
 * 动作前的门禁：确认 sidecar 可用、系统权限也给了，否则抛一句用户读得懂的中文报错。
 *
 * 这是把「不可用」（缺 Python/依赖/显示会话/权限）显式讲给模型听的地方，而不是让它撞一个裸崩溃。
 */
export async function requireComputerAvailable(ctx: ComputerToolContext): Promise<void> {
  const availability = await ctx.computer.ensureAvailable()
  if (availability.available) return

  throw new AppError('PERMISSION', unavailableMessage(availability))
}

/**
 * 按不可用原因生成面向智能体与界面的门禁消息，并明确禁止自行安装依赖。
 *
 * 口径（两条，别改回去）：
 * - **操作系统权限**是唯一该交给用户处理的门禁：引导去授权，不要绕。
 * - **运行时没装**时禁止模型自己补：Computer Use 是「装了才能用」的插件，Python sidecar 与依赖
 *   随插件产物分发（自带 venv）。让模型跑 pip / shell 去补，等于往用户机器上装来源不可控的东西，
 *   所以这里明说不要装，只引导用户去插件市场安装。
 */
export function unavailableMessage(availability: ComputerAvailability): string {
  const detail = availability.detail?.trim()
  const suffix = detail ? `（${detail}）` : ''

  switch (availability.reason) {
    case 'permission-missing':
      return `桌面控制被系统权限拦截${suffix}。请在「系统设置 → 隐私与安全性」为本应用授予「辅助功能」和「屏幕录制」权限，然后重试；不要尝试绕过权限。`

    case 'unsupported-platform':
      return `当前操作系统不支持桌面控制（Computer Use）${suffix}。请说明该平台暂不可用，不要尝试安装或搭建替代环境。`

    case 'python-missing':
    case 'helper-missing':
    case 'dependencies-missing':
    case 'spawn-failed':
    default:
      return (
        `桌面控制运行时尚未安装（${availability.reason}）${suffix}。` +
        `Computer Use 是「需安装才能使用」的插件，其 Python sidecar 与依赖随插件产物一起分发（自带 venv）——` +
        `请【不要】用 pip、shell 或任何命令在用户机器上安装 Python 依赖或自行搭建环境。` +
        `正确做法：向用户说明需要在「设置 → 插件市场」安装 Computer Use 插件；` +
        `以 blocking 的用户动作卡呈现该阻塞，等待用户安装完成后再重试，而不是自动安装。`
      )
  }
}

/** 把启动失败的报错分类成可用性原因：按关键字认 helper 侧的典型失败，认不出就算 spawn 失败。 */
export function classifyStartError(error: unknown): ComputerAvailability['reason'] {
  const message = AppError.getMessage(error).toLowerCase()
  if (message.includes('enoent') || message.includes('not found')) return 'python-missing'
  if (message.includes('modulenotfounderror') || message.includes('no module named'))
    return 'dependencies-missing'
  return 'spawn-failed'
}

/** 权限没给全时给出的说明：Linux 缺的是图形会话，macOS/Windows 缺的是辅助功能与屏幕录制。 */
export function permissionMissingDetail(permissions: ComputerPermissionStatus): string {
  if (permissions.platform === 'linux') return 'Linux desktop control requires a graphical display session with screenshot and input access.'

  return 'Desktop control requires Accessibility and Screen Recording permissions.'
}
