# 平台约定不变量登记

每一条都是本模块对外的承诺。改动或删除任何一条，都要在差量报告里点名并说明原来的承诺为什么不对；新增一条同样要点名。
检验方式与 `packages/agent/spec/invariants.md` 相同：测试 / 类型 / 门禁 / 运行时 / 文字，`check:module-ownership` 核对每一行的检验器是否存在。

| 编号 | 不变量 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | 根入口与 `./contracts` 的整条引用链不碰 Node 内置模块，渲染进程可以直接加载；只有 `./shared-resources` 用 Node | 门禁 | `check:module-ownership` |
| INV-2 | 兼容层只按构造时给的平台与环境变量回答，在一台机器上能算出另一个平台的路径、shell 与命令规格；不读写磁盘、不启动进程 | 测试 | `spec/acceptance.test.ts` |
| INV-3 | 共享数据根：`VELAROS_SHARED_DATA_ROOT` 一旦设置就整体覆盖平台默认位置；资源目录与账号目录固定在它下面的 `shared/resources` 与 `shared/account/v1` | 测试 | `spec/acceptance.test.ts` |
| INV-4 | 路径文本包含判断按实例的平台规整：折叠 `.` 与 `..` 不越过根，win32 认两种分隔符而其他平台只认 `/`（POSIX 上反斜杠是文件名字符），大小写缺省按平台惯例；不是完整的绝对路径一律判「不在里面」 | 测试 | `spec/acceptance.test.ts` |
