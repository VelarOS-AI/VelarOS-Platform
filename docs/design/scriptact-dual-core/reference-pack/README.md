# ScriptAct 双核 Runtime · 设计与 Codex 实现包

版本：v0.1，2026-09-19。

## 建议阅读顺序

先读 `DESIGN.md` 的第 0、2、4、6、14、15 章了解核心；将整个目录交给 Codex，以 `CODEX_START.md` 作为开工指令；接口和局部测试在 `reference/`；真实测试与论文评测定义在 `EVAL_SPEC.md`。

## 文件

| 文件 | 用途 |
| --- | --- |
| DESIGN.md | 完整架构、状态机、协议、错误处理、安全、迁移与验收设计 |
| DESIGN.docx | 同内容的 24 页 Word 阅读版，含可点击目录 |
| CODEX_START.md | 可直接作为 Codex 首条指令 |
| ORCHESTRATOR.md | 编排、取消、恢复和模型视图发布的职责级伪代码 |
| EVAL_SPEC.md | Fixture、四组 baseline、成本与正确性指标 |
| reference/contracts.ts | 与框架无关的 TypeScript 参考契约 |
| reference/contracts.examples.ts | 正确/错误类型示例 |
| reference/invariants.ts | 预算、diff 基线、计划引用、恢复决策的纯函数示例 |
| reference/smoke.test.cjs | 上述局部示例的 17 项 Node 测试 |
| reference/tsconfig.json | 参考代码严格类型检查配置 |
| VALIDATION.md | 本次实际完成的检查与未完成项 |

## 运行参考检查

在已经装有 TypeScript 编译器与支持 node:test 的 Node 环境中执行：

```sh
cd reference
tsc -p tsconfig.json
node --test smoke.test.cjs
```

在实际仓库内优先使用现有包管理器和锁定的 TypeScript 版本，不为本参考包随意升级整个项目依赖。

## 范围说明

这是设计和契约参考包，不是完整可部署 Runtime。没有连接或修改你的当前代码仓库，没有执行真实项目 Agent、沙箱安全测试或模型性能评测。无模型局部测试通过不能代替 DESIGN.md 的 A01-A28 集成验收。

本方案不声称学术首创，也不保证一定降低总体 token/成本；这正是 EVAL_SPEC.md 要验证的问题。
