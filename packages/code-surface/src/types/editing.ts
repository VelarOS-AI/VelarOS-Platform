/** 编辑落到原文上之后的形状；包内用，不出包，所以不放在可移植文件里。 */

/** 一处编辑落到原文上的字符区间；空区间就是在那个位置插入。 */
export interface ResolvedProgramEdit {
  /** 起点，从 0 起。 */
  start: number
  /** 终点，右开。 */
  end: number
  /** 落进去的新文本。 */
  text: string
}
