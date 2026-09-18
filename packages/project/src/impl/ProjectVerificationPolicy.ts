/**
 * 验证判据：`ProjectVerificationPolicy` 与整个进程唯一的 `projectVerificationPolicy`。接口 `ProjectVerificationPolicyApi` 在本文件的类上方。
 */

import { isVerificationRelevantProjectPath } from '../utils/verification-paths.js'

/**
 * 「改到这个文件之后要不要再跑一次验证」这条判据，由项目空间给出。
 *
 * 宿主把它交给 agent 的编码会话（`CodingSessionPolicy.isVerificationRelevantPath`）：agent 只知道自己
 * 收集到了哪些改动路径，不知道哪些文件算代码；不给这条判据时它会把每条改动都当成要验证的。
 */
export interface ProjectVerificationPolicyApi {
  /**
   * 这个路径（相对项目根或绝对路径都收）的改动值不值得再跑一次验证命令。
   * 源码、构建清单、依赖锁与配置格式为真；图片、文档、日志这类不影响构建结果的为假。
   */
  isVerificationRelevantPath(path: string): boolean
}

export class ProjectVerificationPolicy implements ProjectVerificationPolicyApi {
  public isVerificationRelevantPath(path: string): boolean {
    return isVerificationRelevantProjectPath(path)
  }
}

/** 整个进程唯一的一份验证判据。 */
export const projectVerificationPolicy: ProjectVerificationPolicyApi = new ProjectVerificationPolicy()
