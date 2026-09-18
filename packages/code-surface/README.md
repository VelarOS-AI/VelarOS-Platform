# @velaros-ai/code-surface

代码面：模型写**真 ES 模块**——`import { read } from 'velar:files'` 拿能力、顶层 `await` 直接用、`export default` 交出答案——用生成出来的能力声明把事情一次办完，而不是一次一个工具地调。

- `createCodeProgramGate({ checker, runner })`：模型写脚本的那扇门。模型面上四个工具：`script:exec` 一次给几步（跑代码、存进脚本库、改版本、退回旧版本、按记录重放），`script:history`、`script:show`、`script:diff` 读这个空间的时间线。每一步的代码、参数与结果都记下来，项目空间还记下每一步改了哪些文件——只存哈希，不存文件内容。
- `codeProgramChecker`：执行之前的那道门。脚本是 JavaScript，但照样受 TypeScript 检查（类型从声明里推），连同它 import 到的库里的脚本一起查；**只加载这一轮授权的模块**，没授权的 `import` 不出来。
- `createCodeSurfaceSession({ checker, runner, capabilities, events })`：办完一段脚本——查体量、检查、隔离里执行、把脚本发的能力调用转给宿主、编成给模型看的结果。
- `nodeSubprocessCodeRunner`：开发期用的隔离运行器（`node --permission` 子进程）。**不可发版**：它挡不住网络，正式版换 WASM 里的 QuickJS。

脚本发出的每一次能力调用都转回宿主，危险判定、运行事件仍在原来那道端口后面；参数走 `input`、文件内容这类大字符串走 `blobs`，不进源码。宿主要给每个空间一个时间线目录（`CodeSurfaceTimelinePort`），项目空间再给项目根打标记。
