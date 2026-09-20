import type { OperationSchema } from '@velaros-ai/kernel'

/** 建立无隐式额外字段的对象 schema。 */
export function objectSchema(properties: Readonly<Record<string,OperationSchema>>, required: readonly string[]=Object.keys(properties)): OperationSchema {
  return {type:'object',properties,required,additionalProperties:false}
}
/** 无参数操作采用 null 或空对象。 */
export const emptyInputSchema: OperationSchema = {anyOf:[{type:'null'},objectSchema({})]}
/** 同一会话内的不可变材料引用。 */
export const contextRefSchema: OperationSchema = objectSchema({sessionId:{type:'string'},id:{type:'string'}})
/** 原始记录元数据与来源。 */
export const contextRecordSchema: OperationSchema = objectSchema({ref:contextRefSchema,sequence:{type:'integer'},kind:{type:'string'},title:{type:'string'},objectId:{type:'string'},chars:{type:'integer'},sources:{type:'array',items:contextRefSchema},createdAt:{type:'string'}})
/** 分页查询的公共形状；具体范围由所属机制校验。 */
export const querySchema: OperationSchema = objectSchema({query:{type:'string'},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1}},[])
