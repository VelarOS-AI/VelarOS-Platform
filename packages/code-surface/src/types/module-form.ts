/** 模块形态里不出包的那几个形状；可移植的（租约、import、授权模块）在 `code-surface.ts`。 */



/** 改写模块时一处要按文本替换的区间；包内用。 */
export interface ProgramRewrite {
  /** 起点，从 0 起。 */
  start: number
  /** 终点，右开。 */
  end: number
  /** 换上去的文本；**必须与原文行数相同**，否则抛错的行号就对不上模型写的那一行。 */
  text: string
}
