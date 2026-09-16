import { resolve } from 'node:path'

import { AppError } from '@velaros-ai/core/error'
import { resolveRealPath } from '@velaros-ai/core/utils/RealPath'
import { currentPlatform } from '@velaros-ai/platform'

/**
 * 解析站点工作区内的相对保存路径，防目录穿越。
 *
 * 判定走 {@link resolveBrowserWorkspacePath}（按真实路径，解开符号链接）：与 `browser:files`
 * 同一份实现，工作区里指向外面的符号链接读写都拒绝。
 */
export async function resolveWorkspaceFilePath(
  workspaceRoot: string,
  requestedPath: string,
  label = '路径'
): Promise<BrowserWorkspacePath> {
  return resolveBrowserWorkspacePath(workspaceRoot, requestedPath, label)
}

/** 站点工作区里的一条路径。 */
export interface BrowserWorkspacePath {
  /** 解开符号链接后的真实绝对路径：包含判定与落盘都用它。 */
  path: string
  /** 相对工作区根的可移植相对路径（各级用 `/` 连接；根本身是 `.`）。 */
  relativePath: string
  /** 没解链接、只把相对路径接到根上的字面绝对路径：判「这一段本身是不是符号链接」时用。 */
  literalPath: string
}

/**
 * 纯文本的包含判定：candidate 在 root 之内时返回相对路径（root 本身是 `.`），否则 null。
 *
 * 只算字符串（折叠 `.` 与 `..`、大小写按平台），**不解符号链接**——列目录、给已经解析过的
 * 真实路径贴相对路径这类场景够用；凡是要按结果决定「能不能读写」的地方一律走
 * {@link resolveBrowserWorkspacePath}，它先把链接解开再判。
 */
export function getRelativePathInsideRoot(
  rootPath: string,
  candidatePath: string
): Nullable<string> {
  return currentPlatform.relativePathTextInside(resolve(candidatePath), resolve(rootPath))
}

export function toPortableRelativePath(relativePath: string): string {
  return currentPlatform.toPortablePathText(relativePath)
}

/**
 * 站点工作区路径解析的**全包唯一实现**：engine 落盘（截图、录屏、堆快照、下载、PDF）、
 * 上传与 `browser:files` 都走这里。
 *
 * 判定按**真实路径**来：先把工作区根与目标路径上的符号链接全部解开（路径还不存在时解开最近
 * 一个存在的祖先、悬空链接照它指向的位置继续解），再判包含。曾经的两套判定里，engine 这一套
 * 只做字面 `path.resolve`：工作区里只要有一个指向外面的符号链接（用户或别的空间建的），
 * `fetch_resource` / `handle_download` / 截图就能写到工作区外，`upload_file` 能把链接指向的
 * 任意文件（例如私钥）传给网页——而同一个链接在 `browser:files` 那套判定里是拒绝的。
 *
 * 只接受相对路径：绝对路径由调用方自己决定要不要放行（宿主预览有单独的入口）。
 */
export async function resolveBrowserWorkspacePath(
  workspaceRoot: string,
  requestedPath: string,
  label = '路径'
): Promise<BrowserWorkspacePath> {
  const trimmed = requestedPath.trim()
  if (!trimmed) {
    throw new AppError('VALIDATION', `${label}不能为空。`)
  }
  if (currentPlatform.isAbsolutePathText(trimmed)) {
    throw new AppError('VALIDATION', `${label}必须是当前站点工作区内的相对路径。`, undefined, {
      path: requestedPath,
    })
  }

  const realRoot = await resolveRealPath(workspaceRoot)
  const literalPath = resolve(realRoot, trimmed)
  const realPath = await resolveRealPath(literalPath)
  const relativePath = currentPlatform.relativePathTextInside(realPath, realRoot)
  if (!relativePath) {
    throw new AppError('PERMISSION', `${label}不能离开当前站点工作区。`, undefined, {
      path: requestedPath,
    })
  }

  return { path: realPath, relativePath, literalPath }
}
