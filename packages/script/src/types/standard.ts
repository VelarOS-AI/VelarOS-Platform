/**
 * 两个标准模块给模型看的形状：`velaros`（输出通道）与 `velaros:program`（这次程序随身带来的数据）。
 * 都不经 Kernel、不占授权名额，生成器从这里写出 `contract/surface.ts` 里的声明；包内外的公开签名都不用它们。
 */
import type { ScriptOutput } from './output.js'

/**
 * 标准库 `velaros` 的模型面：脚本运行器在隔离进程里直接提供，不经 Kernel；声明由生成器从这里写出（`contract/surface.ts`）。
 * @AgentView
 * 交出结果。只 output 下一轮真正需要的事实：数据在脚本里先筛选、计算、聚合，读到的全部内容不必都交出来。
 */
export interface ScriptStandardLibrary {
  readonly output: ScriptOutput
}

/**
 * 恒常可用的程序数据模块 `velaros:program`：随这次运行交来的参数与大段文本；声明由生成器从这里写出（`contract/surface.ts`）。
 * **我们发明的东西要导入，语言自带的不动**——`input`、`blobs` 是我们发明的，做成隐形全局等于让模型背一条只有提示词告诉过它的暗知识；
 * `console` 是 JavaScript 自带的，让模型 `import { console }` 才是真的怪。这个模块永远在常驻档，不需要租约、不占授权名额。
 * @AgentView
 * 这次程序随身带来的数据。
 */
export interface ScriptProgramData {
  /** 随程序一起交来的大段文本，按名字取。文件正文、补丁放这里，不写进源码——写进源码要过好几层转义。 */
  readonly blobs: Record<string, string>
  /** 本次程序的 input 参数（任意 JSON 值），没给是 undefined。 */
  readonly input: any
}
