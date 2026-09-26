# 0021: 写入不再按决策依据拦

- Status: accepted
- Date: 2026-09-26
- Owners: `@velaros-ai/velaros`（act 运行时）、`@velaros-ai/context`（任务视图）

## Context

模型每一轮看到的观察材料带着资源版本（决策依据）。每次写入之前，运行时核对这些版本：任何一个变了（`STALE_OBSERVATION`、
`STALE_VIEW`）、核验不了（`OBSERVATION_UNVERIFIABLE`）、`required` 输出没完整投递（`CONTEXT_REQUIRED`、`REQUIRED_EVIDENCE_MISSING`），
这次写入就不派发。同一段脚本自己写回的版本只在资源一一对应时才算数。真跑长任务时，模型写了一个新文件，观察里的目录列表就变了，
于是它后面所有写入都被拦，一轮轮重试也绕不开（ADR 0020 删宿主核对时同一次长跑里发现）。

## Decision

- 写入前只核对执行身份（这次调用还属于当前执行）；决策依据的版本、核验与 `required` 投递都不再挡写入。
- 资源是不是被别人改过，由各领域写入时自己的版本核对管（项目按文件版本/期望内容、存储按 `baseRevision`），拿旧版本写照样被拒。
- 完成检查不变：依据过期或核验不了时收尾先刷新再确认，`required` 输出没补齐时收尾要等它。
- 只为写入闸存在的决策依据记账（`validateDecision`、按执行记下的依据）删除。

## Alternatives

- **把自己写回的版本推进得更准**（目录、搜索这类派生资源也按自己的写入推进）：派生资源和写入的对应关系说不全，总有漏的；
  而领域在写入处本来就核对版本。否决。

## Security and privacy

不影响权限与危险命令确认；各领域的版本与冲突核对照旧。

## Compatibility and migration

模型看到的 `required` 说明改成「放不下时报告缺口、收尾要等它补齐」；写入不再报上面几个码。

## Validation

act 运行时 INV-24、INV-25 按新语义改写；`decision-basis`、`dual-core`、系统空间 `store` 的写入闸用例改成「写入照常、收尾前刷新」，
context 视图的并发步骤用例改成只核对身份。

## Consequences

模型一段脚本里连续建文件、改文件不会再被自己的写入拦住。外界在模型读取之后改了它依据的东西，写入不会被运行时拦，
要么撞上领域的版本核对，要么在收尾前的刷新里被发现。
