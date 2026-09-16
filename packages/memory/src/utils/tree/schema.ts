import { MemoryTreeStorage } from '../../contract/constants'
import type { SQLiteDatabase } from '../../types/tree'

/**
 * 测试版 v1 记忆树权威 schema（常量表 MemoryTreeStorage.schemaSql 的别名，单一出处在合同里）。
 *
 * schema 文本归属记忆产品：产品宿主可以把本常量内联到单事务迁移链，serve / standalone
 * 宿主可调用 applyMemoryTreeSchema 建表。宿主只提供数据库解析器。
 */
export const MemoryTreeSchemaSql = MemoryTreeStorage.schemaSql


/**
 * 把记忆树 schema 应用到宿主打开的共享连接（所有 CREATE 均 IF NOT EXISTS，幂等可重跑）。
 *
 * 记忆产品自带 schema 与迁移应用逻辑，宿主只递数据库解析器。宿主若把建表文本嵌入自己的
 * 迁移链，也必须复用 MemoryTreeSchemaSql，不得维护第二份 schema 定义。
 */
export function applyMemoryTreeSchema(database: SQLiteDatabase): void {
  database.exec(MemoryTreeSchemaSql)
}
