# 0025: 收尾不再按读到的版本核对

- Status: accepted
- Date: 2026-09-27
- Owners: `@velaros-ai/velaros`（act 运行时、`velaros:project`、系统空间 store）

## Context

ADR 0021 拆掉写入闸时留下了完成检查：模型交 done 时，运行时把本帧可见结果里记下的读取凭据（文件 revision、list / search 结果的哈希、
store 对象的 revision）逐个交给 Kernel 重新核验，任何一个变了就答 `STALE_OBSERVATION`、核验不了就答 `OBSERVATION_UNVERIFIABLE`，
运行带着「上次完成检查尚未通过」再来一轮；连着被拦超过修复次数，整次运行记失败。

2026-09-27 的真任务测试里，开发数据里一共出现三次拦截，三次都是误报：两次是 search 的命中次序每次不同（ripgrep 多线程，已由
project INV-41 修掉），一次是模型 list 之后自己用 shell 建了文件，列表就「过期」了。一次只读问答被拦两次，模型重读文件、重跑测试，
第三次才收尾。拦截的说明只有原因码，模型不知道哪一项变了，只能全部重来。

同时，这些凭据整份放在每一帧的 `runtime.decision` 里（每条带模块实例的绝对路径与合同哈希），一个读了七个文件的会话，这一段占了
每帧动态部分的将近一半，而模型用不上它们。

## Decision

- 完成检查不再核验读取凭据；`required` 输出没补齐时收尾照旧要等（`CONTEXT_REQUIRED`），进行中的目标照旧要 done 附依据。
- 帧里的 `runtime.decision` 只剩 `frameId` 与 `missing`；执行结果不再记 `dependencies.reads / unverified`。
- `velaros:project` 与系统空间 store 不再登记读取凭据（`reads` 的 capture / validate）；store 会话只为核验而有的 `version` 一并删除。
  写入冲突照旧由各领域在写入处自己核对：store 按 `baseRevision`，项目与本机文件按提交时的内容找原文（ADR 0023）。
- Kernel 的读取凭据能力（`OperationDefinition.reads`、`validateReads`）随之删除：act 运行时是它唯一的使用方，
  各产品仓也没有别的接入（2026-09-27 另行评估后删；`OperationReadContract`、`OperationReadStamp`、
  `OperationReadValidation`、`OperationResourceVersion`、回执上的 `reads`、`beforeReadValidation` 与
  `CapabilityModuleOptions.reads` 一并去掉）。

## Alternatives

- **保留检查，只在说明里点名哪一项变了**：模型少重做一些，但 list / search 这类派生结果与模型自己的 shell 写入对不上的问题仍在，
  误报照样发生，照样可能把答完的任务判失败。否决。
- **只核验文件，不核验 list / search**：模型自己用命令格式化、装依赖、跑生成器改掉读过的文件时同样误报。否决。

## Security and privacy

不碰权限、危险命令确认与空间边界；读完之后被外界改掉的内容，写入时撞上领域的版本核对，模型要不要重看由它自己判断。

## Compatibility and migration

帧里 `runtime.decision` 少了 `reads`、`unverified`、`sources`、`superseded`；模型说明原本只引用 `missing`。旧的执行结果里留着的
`dependencies` 照样读得回来，只是没人再看。宿主不用改接口。

## Validation

act 运行时 INV-24 改写（读到的版本不进帧、不挡写入、不打回收尾），`test/decision-basis.test.mjs` 换成新语义（Kernel 凭据核验的用例随能力一起删掉）；
系统空间 INV-15 与 `spec/store.test.mjs` 对应改写。

## Consequences

模型交 done 不会再因为自己的命令或次序抖动被打回；每帧少一大段模型用不上的凭据。读完之后外界改了什么，靠写入处的版本核对与模型自己的判断。
