/** 插件的选项。只放类型。 */

/** typescriptPlugin 的选项。 */
export interface TypeScriptPluginOptions {
  /** 是否装 TypeScript 语法校验器（缺省装）：改动的 .ts/.tsx 文件在提交前按语法检查。 */
  syntaxValidator?: boolean
}
