# 演练沙箱公共规则不变量登记

每一条都是本模块对外的承诺。改动或删除任何一条，都要在差量报告里点名并说明原来的承诺为什么不对；新增一条同样要点名。
检验方式与 `packages/system/spec/invariants.md` 相同：测试 / 类型 / 门禁 / 运行时 / 文字，`check:module-ownership` 核对每一行的检验器是否存在。

| 编号 | 不变量 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | 确认的就是要落的：差量的三列永远完整（不按条数截），确认文案的条数与敏感路径按完整三列算，审批的操作身份带差量指纹与三列条数 | 测试 | `spec/acceptance.test.ts` |
| INV-2 | 点名了没有变化的路径，在问用户之前就拒绝，什么都没写；镜像里什么都没变不问用户 | 测试 | `spec/acceptance.test.ts` |
| INV-3 | 落回的审批是高风险、必须用户亲自点、不可记忆的确认 | 测试 | `spec/acceptance.test.ts` |
| INV-4 | 根入口与 `./contracts` 的整条引用链不碰 Node 内置模块，渲染进程可以直接加载 | 门禁 | `check:module-ownership` |
| INV-5 | 代码面的 `sandbox` 命名空间是一条真路，不是一道恒空的门：模型写的程序照生成的 `baselines/code-surface/sandbox.d.ts` 过 typecheck，在隔离里把 create → run → diff → apply/discard 整条链跑完，回执形状对得上。作用域由宿主注入的端口解析、不由模型挑（project 的实现把越界的 source 拒掉，system 的实现收任意绝对路径），落回照样过「确认的就是要落的」那道确认，用户不点头就抛错、一个文件都不落 | 测试 | `spec/acceptance.test.ts` |
| INV-6 | 代码模版（`template.js`）是日常用法的示例程序（只是示例，模型按需要改写、不要求照着写），import 只写一次；它**整份照生成的真实声明过类型检查**，不嵌进声明，随模型面发布、按需读（`velar:program` 的 template）。写错的模版会原样教出去，所以不许漂；在真的空间里把每个函数跑一遍、看交回的是不是它说的样子，由仓库层的 `tests/capabilities/capability-templates.test.ts` 核对 | 测试 | `spec/acceptance.test.ts` |
| INV-7 | 镜像里的危险命令照常先问用户（ADR 0006）：判定与审批请求用 `velar:shell` 的那一套，高风险、必须用户亲自点、不可记忆；被拒就抛错，宿主一个进程都不起；不危险的命令不打扰用户 | 测试 | `spec/acceptance.test.ts` |
| INV-8 | 差量与输出不折叠：`diff` 的三列永远完整，新增与修改的文本文件都附统一差量（`paths` 只要其中几个），镜像里命令的输出整份交回；只守内存的上限（单文件、单次差量总量、输出各一条），超出的点名没附差量或标 truncated，看多少由程序定 | 测试 | `spec/acceptance.test.ts` |
