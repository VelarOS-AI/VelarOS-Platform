# 项目空间不变量登记

每一条都是本模块对外的承诺。改动或删除任何一条，都要在差量报告里点名并说明原来的承诺为什么不对；新增一条同样要点名。
检验方式与 `packages/system/spec/invariants.md` 相同：测试 / 类型 / 门禁 / 运行时 / 文字，`check:module-ownership` 核对每一行的检验器是否存在。

| 编号 | 不变量 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | 模型面只有九个工具（外加宿主单独登记的 project:code-analysis），名字只来自 `ProjectToolNames`；每个工具的入参 schema 都拒收未知字段 | 测试 | `spec/acceptance.test.ts` |
| INV-2 | 编辑只认本会话读取或修改回执里的 fileRef：它绑定路径、版本和模型实际看到的那段源码；range 超出看到的范围整批拒绝（SCOPE_VIOLATION，not-applied），文件一个字节都不变 | 测试 | `spec/acceptance.test.ts` |
| INV-3 | 文件在读取之后被外部改过，基于旧版本的编辑整批拒绝（BASE_REVISION_MISMATCH，not-applied），不覆盖外部改动 | 测试 | `spec/acceptance.test.ts` |
| INV-4 | 一次 project:edit / project:file / project:change 是一个事务：几个文件、几处编辑全成或全不成；失败时回执标 not-applied，入参可复用 | 测试 | `spec/acceptance.test.ts` |
| INV-5 | 撤销只撤本事务写下的内容：遇到之后的外部修改拒绝覆盖（CONFLICT_WITH_EXTERNAL_EDIT） | 测试 | `spec/acceptance.test.ts` |
| INV-6 | 读、列、搜、改都只在项目根之内：越出项目的路径（包括经符号链接指到项目外）一律拒绝 | 测试 | `spec/acceptance.test.ts` |
| INV-7 | 危险命令每次都由用户亲自确认（高风险、手动、不可记忆，操作身份跨工具一致）；被拒返回 skipped、不执行；会改项目的命令先过宿主的项目修改授权 | 测试 | `spec/acceptance.test.ts` |
| INV-8 | 同一项目根上写操作串行、读操作可并发；排队的写者不被后来的读者饿死，取消了的等待者不运行 | 测试 | `spec/acceptance.test.ts` |
| INV-9 | 文本改动无损：保留文件原来的编码、BOM 与换行，没改到的字节原样保留；新建文件是无 BOM 的 UTF-8、LF；只有 recode 动作改磁盘编码 | 测试 | `spec/acceptance.test.ts` |
| INV-10 | 命中项目策略 generatedFiles 的文件不许手改（GENERATED_FILE），下一步是改生成器的输入再重新生成 | 测试 | `spec/acceptance.test.ts` |
| INV-11 | 错误原因只来自合同常量表 `ProjectErrorCodes`，宿主按码分支，不按文字 | 类型 | `src/contract/constants.ts::ProjectErrorCode` |
| INV-12 | 根入口只出产品面、注入面和它们用到的数据；`./contracts` 的整条引用链不碰 Node 内置模块，渲染进程可以直接加载 | 门禁 | `check:module-ownership` |
| INV-13 | 同一个物理文件的项目内别名（符号链接、大小写变体）算同一个文件：一次事务里两个入参指向同一份内容时，在写任何东西之前整批拒绝（INVALID_INPUT，not-applied）；拒读拒写名单与宿主的可见性过滤器同时按请求路径和解开符号链接后的真实路径判，别名绕不过去 | 测试 | `spec/acceptance.test.ts` |
| INV-14 | 版本库内部（任意一层的 `.git`）缺省不许写，报错说清楚要用 `project:run` 跑 git 命令；演练沙箱的源目录解开符号链接后必须仍在项目之内，否则 PERMISSION_DENIED | 测试 | `spec/acceptance.test.ts` |
| INV-16 | 演练沙箱落回过与编辑同一套写治理（越界、writeDeny、受保护文件、生成文件、宿主可见范围）：有一条不许写就在问用户之前整批拒绝并点名，一个文件都不落 | 测试 | `spec/acceptance.test.ts` |
