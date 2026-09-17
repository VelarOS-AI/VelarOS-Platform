/** 模块形态里不出包的那几个形状；可移植的（租约、import、授权模块）在 `code-surface.ts`。 */


/**
 * 程序 import 了没授权的模块时的结果：**程序一行都没执行**，回的是那几个模块的签名。
 *
 * 这不是失败，是「先拿说明书」——非常驻能力必须先导入才能用，因为代码面里写错一处的代价
 * 不是一次调用失败，是整段程序不执行。给了签名之后模型重写一遍，这一轮不算白花。
 */
export interface CodeProgramNeedsModules {
  /** 恒为 true，用来和其它去向区分。 */
  needsModules: true
  /** 要补的命名空间，按程序里出现的顺序。 */
  namespaces: string[]
  /** 给模型看的一句话加这几个模块的声明。 */
  message: string
}

/** 改写模块时一处要按文本替换的区间；包内用。 */
export interface ProgramRewrite {
  /** 起点，从 0 起。 */
  start: number
  /** 终点，右开。 */
  end: number
  /** 换上去的文本；**必须与原文行数相同**，否则抛错的行号就对不上模型写的那一行。 */
  text: string
}
