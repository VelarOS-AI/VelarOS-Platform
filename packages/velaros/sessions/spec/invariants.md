# 会话之间交活、传话不变量登记

每一条都是本单元对外的承诺。改动或删除任何一条，都要在差量报告里点名并说明原来的承诺为什么不对；新增一条同样要点名。
检验方式与 `packages/agent/spec/invariants.md` 相同：测试 / 类型 / 门禁 / 运行时 / 文字，`check:module-ownership` 核对每一行的检验器是否存在。编号只增不重排。

会话的一切都在宿主那里（这个对话里有谁、开新会话、排队、谁在等谁）；本单元是模型面加入参核对，验收测试用 `spec/support.ts` 的假宿主。
对方是不是这个对话里的会话、两个会话互相等待、对方正忙由宿主判断，这里不重复，只承诺把宿主的结果与错误原样交出去。

| 编号 | 不变量 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | list 不收入参，照宿主的原样交回这个对话里的会话（自己那一个 self 为真），宿主调一次 | 测试 | `spec/acceptance.test.ts` |
| INV-2 | ask 交给已有的会话：to 去掉首尾空白交给宿主，task 原样交；交给宿主的对象只有 to 与 task 两个字段 | 测试 | `spec/acceptance.test.ts` |
| INV-3 | ask 开新会话：workspace 是 project、system、browser 之一；project 带去掉首尾空白的 root（绝对路径：/ 开头、盘符加斜杠、\\\\服务器\\共享，哪个平台的宿主都认），browser 可以带 site（换成网址的规范写法），system 什么都不带；没给的字段不放在对象上，空白的 to、root、site 当作没给 | 测试 | `spec/acceptance.test.ts` |
| INV-4 | 宿主交回的结果原样交回（同一个对象）：ask 的 completed、failed、cancelled、waiting 四种，tell 的 delivered、queued 两种；宿主拒绝时的错误原样抛出，码与说明都不改 | 测试 | `spec/acceptance.test.ts` |
| INV-5 | tell：to 去掉首尾空白，message 原样交给宿主；交给宿主的对象只有 to 与 message | 测试 | `spec/acceptance.test.ts` |
| INV-6 | 入参不对抛 `SessionsErrorCodes` 里的码，宿主一次都不调：不是对象、多给字段、字段不是字符串（`SESSIONS_INPUT_INVALID`）；task、message 去掉首尾空白后是空的（`SESSIONS_TASK_EMPTY`、`SESSIONS_MESSAGE_EMPTY`）；没说交给谁（`SESSIONS_TARGET_MISSING`）；to 与 workspace 都给了（`SESSIONS_TARGET_CONFLICT`）；workspace 不认得（`SESSIONS_WORKSPACE_UNKNOWN`）；开项目会话没给 root 或不是绝对路径（`SESSIONS_ROOT_INVALID`）；site 不是 http(s) 网址（`SESSIONS_SITE_INVALID`）；root、site 没配着 workspace 或跟错了工作区（`SESSIONS_OPTION_MISMATCH`）。message 点名字段、说怎么改 | 测试 | `spec/acceptance.test.ts` |
| INV-7 | 取消：调用之前就取消的，宿主一次都不调；调用上下文的取消信号原样交给宿主；宿主还没回时一取消就以取消原因失败，不陪宿主等 | 测试 | `spec/acceptance.test.ts` |
| INV-8 | 代码面的 `sessions` 命名空间是一条真路：模型写的程序 import 生成的 `baselines/script/sessions.d.ts` 里的操作、过语法检查，在隔离里调到真实操作；几件事可以 Promise.all 同时 ask；失败时程序接得住 `error.code` 与 `error.message` | 测试 | `spec/acceptance.test.ts` |
| INV-9 | 代码模版（`template.js`）是日常用法的示例程序（只是示例，模型按需要改写），import 只写一次；它整份照生成的真实声明过类型检查，不嵌进声明，随模型面发布；每个函数照写法在假宿主上跑通由 `test/template.test.ts` 核对 | 测试 | `spec/acceptance.test.ts` |
| INV-10 | 模型面：三个操作都声明为没有效果（none）；list 不收入参、哪个入口都能调，ask 与 tell 只能在 execute 里调；声明里的三种工作区与 `SessionWorkspaces` 一致；端口与调用上下文不进模型面 | 测试 | `spec/acceptance.test.ts` |
| INV-11 | 分工与对外边界不塌：合同、类型、实现、工具函数各在其位，空间端口的每个方法都有操作在调；`./contracts` 入口整条引用链不碰 Node 内置模块 | 门禁 | `check:module-ownership` |
