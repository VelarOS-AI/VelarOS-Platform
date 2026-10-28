/** 原生工具要求对象根；仅展开生成合同的根引用，保留全部定义与严格字段约束。 */
export function contextMaterialInput(
  schema: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  const definitions = schema.definitions as Readonly<Record<string, Record<string, unknown>>>
  return { ...definitions[(schema.$ref as string).split('/').at(-1)!], definitions }
}
