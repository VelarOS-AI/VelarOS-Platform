# 语言服务库不变量登记

每一条都是本模块对外的承诺。改动或删除任何一条，都要在差量报告里点名并说明原来的承诺为什么不对；新增一条同样要点名。
检验方式与 `packages/system/spec/invariants.md` 相同：测试 / 类型 / 门禁 / 运行时 / 文字，`check:module-ownership` 核对每一行的检验器是否存在。

编号只增不重排。

| 编号 | 不变量 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | 语言查询只借读源码端口（`listFiles` / `read` / `listSymbols`）：不消耗项目的修改、执行与审批能力，宿主给的内核就算带着写入口本包也够不着 | 测试 | `spec/acceptance.test.ts` |
| INV-2 | 代码图谱后端不可用时内置的七个语言动作照常可用，代码图谱类动作抛 code 为 `UNAVAILABLE` 的错误（project 据此降级，而不是当成查询失败） | 测试 | `spec/acceptance.test.ts` |
| INV-3 | 空结果不伪装成「全部通过」：没扫到文件、文件数被截断、耗时超预算、标准库缺失，一律写进 `note` / `degraded` | 测试 | `spec/acceptance.test.ts` |
| INV-4 | 目录诊断按文件所属的 tsconfig 分组，同一个文件在目录模式与单文件模式下得到一样的诊断 | 测试 | `spec/acceptance.test.ts` |
| INV-5 | 外部语言服务只启动规格表里给的命令，只解析项目根以内的文件；命令没装时给不出诊断，但这次结果仍标为完整（是没有诊断能力，不是等到超时） | 测试 | `spec/acceptance.test.ts` |
| INV-6 | 路径越界按**真实路径**判定：项目里名叫 `..xxx` 的目录照常查询，经符号链接指到项目外的路径一律拒 | 测试 | `spec/acceptance.test.ts` |
| INV-7 | `find_references` 提前停扫时引用数是下限：`referenceCountIsLowerBound` 为真且 `note` 里写明，不把下限当总数交给模型 | 测试 | `spec/acceptance.test.ts` |
| INV-8 | 认不出的 `language` 当场失败并列出可用值，不静默选中零个服务返回一份看似「没有结果」的空答复 | 测试 | `spec/acceptance.test.ts` |
| INV-9 | TypeScript 语言服务池可以被宿主释放：`typeScriptProjects.release()` 之后旧凭据自报失效，调用方按 `isCurrent()` 重新取 | 测试 | `spec/acceptance.test.ts` |
| INV-10 | `./contracts` 入口整条引用链不碰 Node 内置模块，渲染进程与浏览器都能加载；语言服务实现、工具函数与内部接口一律不出包 | 门禁 | `check:module-ownership` |
| INV-11 | 语言查询的注入面只借内核的三个读方法，多一个都借不到：类型上就是对 `AgentProjectKernelPort` 取 `listFiles`、`read`、`listSymbols` 三键的 `Pick` | 类型 | `src/contract/requires.ts::LanguageReadPort` |
