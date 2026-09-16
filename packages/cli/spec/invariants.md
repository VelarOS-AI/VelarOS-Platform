# `velaros` 命令行不变量登记

每一条都是本模块对外的承诺。改动或删除任何一条，都要在差量报告里点名并说明原来的承诺为什么不对；新增一条同样要点名。
检验方式与 `packages/system/spec/invariants.md` 相同：测试 / 类型 / 门禁 / 运行时 / 文字，`check:module-ownership` 核对每一行的检验器是否存在。

编号只增不重排。

| 编号 | 不变量 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | 路由器永不向宿主抛：未知命名空间收成 `UNKNOWN_NAMESPACE`（退出码 2），命名空间抛的任何异常收成 `EXECUTION_ERROR`（退出码 1），宿主拿到的永远是可打印结果 | 测试 | `spec/acceptance.test.ts` |
| INV-2 | 命名空间集合构造后冻结、按字典序；内置集是产品默认集不是准入白名单——`includeBuiltinNamespaces: false` 能整组关掉，同名的产品命名空间盖掉内置的那个 | 测试 | `spec/acceptance.test.ts` |
| INV-3 | `--json` 的信封字段固定：`schemaVersion` 取自常量表，成功信封的 `kind` 是 `velaros.cli.<命名空间>.<子命令>`，失败信封的 `kind` 恒为 `velaros.cli.error`，失败一律带 `error.code` | 测试 | `spec/acceptance.test.ts` |
| INV-4 | 用户看得到的文字是中文：根帮助与失败说明都用中文，命令名、错误码、环境变量名原样夹在中文里；自动化按 `error.code` 判断，不按文字 | 测试 | `spec/acceptance.test.ts` |
| INV-5 | `velaros terminal` 只启动 Termel、不装配它：命令名取 `VELAROS_TERMEL_COMMAND`（不设时是 `termel`），命名空间之后的参数原样按序转交；找不到可执行文件时给 `TERMEL_NOT_INSTALLED`（退出码 127），不报成执行失败 | 测试 | `spec/acceptance.test.ts` |
| INV-6 | 子进程的退出码原样透出，本包不改写；被信号杀死时按 POSIX 惯例报 128 加信号号，不混进「正常退出 1」 | 测试 | `spec/acceptance.test.ts` |
| INV-7 | `./contracts` 入口整条引用链不碰 Node 内置模块，渲染进程与浏览器里解析 `--json` 输出的代码都能加载；路由器、进程壳与错误类都不出包 | 门禁 | `check:module-ownership` |
| INV-8 | `src/` 下全是声明与类：import 根入口不产生任何输出、不启动任何东西；`velaros` 要跑起来只有 `bin/velaros.mjs` 这一个入口 | 测试 | `spec/acceptance.test.ts` |
| INV-9 | 装出来的 `velaros` 就是包根的 `bin/velaros.mjs`：文件可直接执行，跑 `velaros help` 得到中文帮助与退出码 0 | 测试 | `spec/acceptance.test.ts` |
