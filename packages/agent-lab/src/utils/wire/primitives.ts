/**
 * 线格式的共用基元：JSON 值、标识符、可为空的非负数。
 * schema 不出包，外面只拿得到 `labWire` 的几个 `parse*`。纯测量：不碰 Node 模块、不发请求。
 */
import { z } from 'zod'

import { AgentLabLimits } from '../../contract/constants.js'
import type { JsonObject, JsonValue } from '../../types/agent-lab.js'

/** 任意一个 JSON 值：布尔、有限数、字符串、null，以及它们组成的数组与对象。 */
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ])
)

/** 一个 JSON 对象：证据、参数、元数据都用它。 */
export const jsonObjectSchema = z.record(
  z.string(),
  jsonValueSchema
) satisfies z.ZodType<JsonObject>

/** 标识符：去掉两头空白后非空，长度按常量表的上限卡。 */
export const identifierSchema = z.string().trim().min(1).max(AgentLabLimits.identifierChars)

/** 归档目录的运行身份：沿用专用 200 字符上限，原字节不改写，并拒绝 Windows 非法/保留目录名。 */
export const runIdSchema = z
  .string()
  .min(1)
  .max(AgentLabLimits.runIdChars)
  .refine((value) => /^[A-Za-z0-9]/.test(value) && !/[^A-Za-z0-9._-]/.test(value), {
    message: 'run id 必须以字母数字开头，只能包含字母数字、点、下划线或连字符',
  })
  .refine((value) => !value.endsWith('.'), { message: 'run id 不能以点结尾' })
  .refine((value) => !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value), {
    message: 'run id 不能使用保留设备名',
  })

/** 可为空的非负有限数：`null` 表示不设限或没观测到，不是 0。 */
export const nullableLimitSchema = z.number().finite().nonnegative().nullable()

/** 非空字符串（去掉两头空白后仍非空）。 */
export const nonEmptyTextSchema = z.string().trim().min(1)
