import { AgentProtocolVersions } from '../../contract/constants.js'

/**
 * Agent 工具契约协议版本的单值别名，等价于 `AgentProtocolVersions.agent`。
 *
 * 版本表本身在合同的常量表里；这里只是给 `z.literal()` 与旧调用点一个不带表前缀的名字，值永远跟着表走。
 */
export const AgentProtocolVersion = AgentProtocolVersions.agent

/**
 * 聊天持久化 manifest 基线版本的单值别名，等价于 `AgentProtocolVersions.chatStorageSchema`。
 *
 * 同上：唯一事实在常量表，这里只保留宿主已经在用的老名字。
 */
export const CHAT_STORAGE_SCHEMA_VERSION = AgentProtocolVersions.chatStorageSchema
