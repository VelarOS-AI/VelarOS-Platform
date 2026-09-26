# 0019: 模型写的脚本只查语法，不查类型

- Status: accepted
- Date: 2026-09-26
- Owners: `@velaros-ai/script`（检查器）、`@velaros-ai/kernel`（入参校验的报错）、`@velaros-ai/velaros`（各单元验收）

## Context

脚本执行之前照生成的声明做 TypeScript 检查（`checkJs`、strict），没过就一行不执行。Desktop 接上长程任务后第一次真跑，
一堆脚本卡在类型推断上：空对象里的 `items: []` 推成 `never[]`，之后 `push` 报错；`let mode = 'a'` 拓宽后传给字面量联合报错。
这些程序在 JavaScript 里完全对，模型却要一轮轮改类型写法，失败卡片刷满一屏。用户的裁决：「检查一下 js 语法就行，别检查 ts 了」。

## Decision

- 模型交的程序（连同它 import 到的库里的脚本）执行之前只做 JS 引擎本来就会做的检查：
  语法；每个 import 都落得到——能力模块要在这一轮的声明里，相对路径要落到库里一份存在的脚本上；
  从能力模块 import 的名字模块里得有（和 ES 模块链接时一样，诊断列出它实际导出什么）。没过一行不执行，诊断带代码帧。
- 不再查类型：字段名写错读到 undefined；入参形状错由 Kernel 在那一次调用上按 schema 拒绝（效果 none），
  报错从原样的 Ajv JSON 改成一句话（`gaps[0] 应当是 object；多了不认识的字段 targetChars`）。
- 手滑写 TypeScript 的宽容路径保留：整份诊断都是「只能在 TS 文件里用」那一族时按 TS 再解析一遍，剥掉类型照跑。
- 我们自己写的代码模版照旧照声明做完整类型检查（`codeProgramChecker.typecheck`，只在各单元验收里用）：模版会原样教给模型。
- 名字写错时补「实际有什么」的类型提示（script INV-38）随类型检查一起删掉。

## Alternatives

- **保留类型检查、逐条放宽规则**（关 strict、关 `strictNullChecks`……）：误报换个样子还在，每放一条都要实测一轮。否决。
- **类型错只提示、不拦**：检查照跑、结果只当提醒，模型还是会停下来改类型写法。否决。

## Security and privacy

检查从来不是安全边界：能力只经 Kernel 的调用桥可达，没授权的模块在隔离里取不到，入参照样按 schema 校验，危险命令照旧确认。

## Compatibility and migration

`CodeProgramCheckerApi` 多了 `typecheck`；`check` 的诊断从 TS 语义诊断变成语法诊断与 import 诊断（码 2307 / 2305 沿用 TS 编号），
`CodeSurfaceDiagnosticCodes` 多了 `missingExport`。Kernel 的入参 / 返回值校验失败说明换了格式，错误码不变。

## Validation

script INV-1、INV-10、INV-12、INV-13、INV-33 按新语义改写，INV-38 删除，新增 INV-39（模版另走完整类型检查）；
各单元「代码面是一条真路」的不变量改成过语法检查；act 运行时里靠类型错造检查失败的用例改成语法错，
靠类型检查拦隐藏操作的用例改成断言运行时报错。

## Consequences

对的 JavaScript 不再被弹回去；写错字段的程序会跑到那一行才报，报错写明哪个字段错在哪。
