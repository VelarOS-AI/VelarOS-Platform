/** 每个桌面动作前的可用性门禁，以及不可用时按原因给智能体与界面的文案。 */

import { AppError } from '@velaros-ai/core/error'

import { ComputerErrorCodes, ComputerHelperErrorCodes } from '../contract/constants.js'
import type { ComputerOperationContext } from '../contract/requires.js'
import type { ComputerAvailability, ComputerPermissionStatus } from '../types/computer.js'

/**
 * 动作前的门禁：确认 sidecar 可用、系统权限也给了，否则抛一句用户读得懂的中文报错。
 *
 * 这是把「不可用」（缺 Python/依赖/显示会话/权限）显式讲给模型听的地方，而不是让它撞一个裸崩溃。
 */
export async function requireComputerAvailable(ctx: ComputerOperationContext): Promise<void> {
  const availability = await ctx.computer.ensureAvailable()
  ctx.abortSignal.throwIfAborted()
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
        `正确做法：告诉用户需要在「设置 → 插件市场」安装 Computer Use 插件，等用户装好再重试，而不是自己去装。`
      )
  }
}

/**
 * 把启动失败的报错分类成可用性原因。
 *
 * 先认错误码（本单元自己抛的那条），认不出才去看文字——剩下的文字是操作系统与 Python 抛的英文，
 * 不归本单元管，所以关键字保持英文。
 */
export function classifyStartError(error: unknown): ComputerAvailability['reason'] {
  if (error instanceof AppError && error.code === ComputerErrorCodes.helperMissing)
    return 'helper-missing'

  const message = AppError.getMessage(error).toLowerCase()
  if (message.includes('enoent') || message.includes('not found')) return 'python-missing'
  if (message.includes('modulenotfounderror') || message.includes('no module named'))
    return 'dependencies-missing'
  return 'spawn-failed'
}

/** 权限没给全时给出的说明：Linux 缺的是图形会话，macOS/Windows 缺的是辅助功能与屏幕录制。 */
export function permissionMissingDetail(permissions: ComputerPermissionStatus): string {
  if (permissions.platform === 'linux')
    return 'Linux 上的桌面控制需要一个能截图、能注入输入的图形会话。'

  return '桌面控制需要「辅助功能」和「屏幕录制」两项系统权限。'
}

/**
 * 把 helper 报来的领域错误翻成模型看得懂的中文。
 *
 * helper 资产是 Python、报错是英文，而这几条恰恰是模型要据以决定下一步的（重新截图还是改坐标）。
 * 按错误码翻译而不是按文字匹配：改 helper 的英文措辞不影响这里，码是两边唯一的约定。
 * 码不认识就把原文带上——宁可露出英文，也不要把诊断吞掉。
 */
export function describeHelperError(code: string, message: string): string {
  switch (code) {
    case ComputerHelperErrorCodes.snapshotRequired:
      return `点击主屏坐标必须带上同一次截图返回的 snapshotId，请先 screenshot 再点。（${code}）`
    case ComputerHelperErrorCodes.snapshotStale:
      return `这张截图已经过期：主屏、分辨率、缩放或原点变过了，旧坐标作废。请重新 screenshot 再按新图上的坐标点。（${code}）`
    case ComputerHelperErrorCodes.snapshotUnexpected:
      return `显式全局坐标不要带 snapshotId；要按截图坐标点就把 coordinateSpace 去掉。（${code}）`
    case ComputerHelperErrorCodes.coordinateOutOfBounds:
      return `坐标落在屏幕或截图之外，请重新截图确认位置。（${code}：${message}）`
    case ComputerHelperErrorCodes.coordinateSpaceInvalid:
      return `坐标空间只能是 primary-display 或 global。（${code}）`
    case ComputerHelperErrorCodes.screenStateInvalid:
      return `取不到当前屏幕状态，无法校验坐标，请重新截图后再试。（${code}：${message}）`
    default:
      return `${code}: ${message}`
  }
}
