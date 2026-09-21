import type { OperationSchema } from "@velaros-ai/kernel";

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
export const querySchema: OperationSchema = objectSchema({space:{enum:['system','capability','all']},query:{type:'string'},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1}},[])

/** 模块发现返回真实卡片，脚本无需类型断言即可使用。 */
export const modulePageSchema:OperationSchema=objectSchema({items:{type:'array',items:objectSchema({specifier:{type:'string'},space:{enum:['system','capability']},exports:{type:'array',items:{type:'string'}},binding:objectSchema({moduleId:{type:'string'},instanceId:{type:'string'},generation:{type:'integer'},schemaRevision:{type:'string'}}),summary:{type:'string'},operations:{type:'array',items:{type:'string'}}},['specifier','space','summary','operations'])},nextOffset:{anyOf:[{type:'integer'},{type:'null'}]}})
/** 归档分页正文与原始元数据共用一种返回值。 */
export const contextContentSchema:OperationSchema=objectSchema({record:contextRecordSchema,text:{type:'string'},totalChars:{type:'integer'},offset:{type:'integer'}})

/** 发现结果中的用法字段有明确类型，动态 schema 与成员目录保持开放数据。 */
export const moduleDescriptionSchema:OperationSchema=objectSchema({specifier:{type:'string'},space:{enum:['system','capability']},export:{type:'string'},summary:{type:'string'},binding:{type:'object'},operations:{type:'object'},exports:{type:'object'},declarations:{type:'string'},template:{type:'string'}},['specifier','space','declarations','template'])
