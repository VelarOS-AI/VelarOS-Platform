/**
 * 产品面：项目空间交给外面的东西——装配表与交给 agent 编码会话的验证判据。类实现的 API 定义在各自的类上方（`impl/` 里），这里登记并转发。
 * 这里的每个接口都必须从根入口导出。
 */

export type { ProjectSpaceApi } from '../impl/ProjectSpace.js'
export type { ProjectVerificationPolicyApi } from '../impl/ProjectVerificationPolicy.js'
