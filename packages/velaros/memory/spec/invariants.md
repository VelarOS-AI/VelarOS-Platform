# 长期记忆不变量登记

每一条都是本模块对外的承诺。改动或删除任何一条，都要在差量报告里点名并说明原来的承诺为什么不对；新增一条同样要点名。
检验方式与 `packages/agent/spec/invariants.md` 相同：测试 / 类型 / 门禁 / 运行时 / 文字，`check:module-ownership` 核对每一行的检验器是否存在。

编号只增不重排。ADR 0010 把记忆单元整个重写成「一个作用域一个目录的 Markdown」：原来的 23 条随记忆树、向量档、证据与回合召回一起作废，
编号从 1 重新起。

| 编号 | 不变量 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | 作用域之间互相看不见：两个作用域的读写落在不同目录，互相列不到、删不到；作用域按字符串逐字区分，只差大小写的两个字符串也是两个作用域 | 测试 | `spec/acceptance.test.ts` |
| INV-2 | 作用域的目录：名字是小写可读前缀接作用域字符串 SHA-256 的前 16 位十六进制，第一次写入时才建；目录里的 `.scope` 原样记着作用域字符串，`listScopes` 据此交回原串、条数与最近一次更新，一条记忆都没有的不列，根目录里的普通文件与没有 `.scope` 的目录不算作用域；作用域是空的、根目录不是绝对路径，一律 `VALIDATION` | 测试 | `spec/acceptance.test.ts` |
| INV-3 | id 就是文件名：只许小写字母、数字和连字符（连字符不在头尾、不连写），最多 64 个字符，不许 Windows 的保留名；别的一律 `VALIDATION`，所以读写出不了这个作用域的目录 | 测试 | `spec/acceptance.test.ts` |
| INV-4 | save 默认最后提交者整条覆盖（只有 tags 例外，见 INV-13）：同一个 id 再写就是更新（`created` 为假）；文件头部依次只有 title、description、type、tags、updated 五个字段，标题与描述为 JSON 字符串、标签为 JSON 字符串数组，入参里多出来的字段不落盘；updated 由记忆库在写入时填；标题、描述、正文去掉首尾空白，标签去掉首尾空白、转小写、去重，合法方括号与单双引号标签可逆；先写临时文件再改名，不留临时文件 | 测试 | `spec/acceptance.test.ts` |
| INV-5 | remove 真删：文件没了，之后列不到；本来就没有这一条时 `removed` 为假，不报错 | 测试 | `spec/acceptance.test.ts` |
| INV-6 | 做事之前核对：入参不合法（不是对象、类别不对、标题或描述是空的、换行或超长、正文不是字符串或超长、标签不是字符串数组、含逗号、超长、超条数）一律 `VALIDATION`，一个文件都不写、不删；expectedRevision 仅接受 list/save 的 64 位十六进制版本、null 或省略；宿主 prepareRemove 同步复用 remove 的完整规范并返回独立输入快照，不读磁盘、不承诺 CAS 或删除；取消信号已经触发时，三个操作都不碰磁盘 | 测试 | `spec/acceptance.test.ts` |
| INV-7 | 只解析当前完整五字段头部与精确类别，允许 BOM 和 CRLF，revision 取原始内容；无头部、旧别名、缺失或未知字段、未知类别、坏 JSON 或时间一律 `VALIDATION`，list 不跳过无效条目，save 无论是否带 tags 都不覆盖无效原件，不自动迁移；不是 `<合法 id>.md` 的文件不算记忆 | 测试 | `spec/acceptance.test.ts` |
| INV-8 | 已退役：宿主开场索引与排版预算不再由记忆单元提供；调用方按需 list 读取条目，编号不复用 | 文字 | |
| INV-9 | 代码面是一条真路：模型写的程序 import 生成的 `baselines/script/memory.d.ts` 里的操作、过语法检查，经代码面的门调到真实操作；声明只放出 list、save、remove，调用上下文、作用域端口与记忆库都不进模型面；失败时程序看得到的就是 `error.code` 与 `error.message` | 测试 | `spec/acceptance.test.ts` |
| INV-10 | 模型面与常量表一致：声明里 id、标题、描述、正文、标签的上限就是 `MemoryLimits`，类别就是 `MemoryTypes` | 测试 | `spec/acceptance.test.ts` |
| INV-11 | 代码模版（`template.js`）是日常用法的示例程序（只是示例，模型按需要改写），import 只写一次：整份照生成的声明过类型检查，不嵌进声明、随模型面发布、按需读；在真的记忆库上逐个函数跑一遍，交回的是它说的样子 | 测试 | `spec/acceptance.test.ts` |
| INV-12 | 分工与对外边界不塌：合同、类型、实现、工具函数各在其位，作用域端口的每个方法都有操作在调；`./contracts` 入口整条引用链不碰 Node 内置模块，渲染进程可以直接加载 | 门禁 | `check:module-ownership` |
| INV-13 | 改一条时 tags 不给就沿用锁内当前格式文件的原有标签，给 `[]` 才清空，给了就整组换掉；新建时不给就是没有标签，避免只改正文时悄悄清掉标签 | 测试 | `spec/acceptance.test.ts` |

| INV-14 | list/save 返回基于原始文件内容的 revision；save/remove 给 expectedRevision 时锁内核对，过期报 CONFLICT、目标不变，null 要求不存在；省略版本继续最后提交覆盖。同磁盘条目的写锁跨 store 实例与遵守协议的进程协调，锁忙报 CONFLICT，可重读后重试；崩溃遗留锁不自动夺取 | 测试 | `test/foundation-concurrency.test.ts` |

2026-09-30：INV-4 明确默认并发覆盖语义，INV-6 补齐条件版本输入和提交前取消边界，新增 INV-14 的可检测过期写能力。版本不写进 Markdown 头部，仍保持五字段格式。

2026-11-08：INV-4/7 改为唯一可逆的当前格式，撤销无生产者的旧别名与默认字段兼容，防止合法标签被旧解析规则剥除；INV-6 增加宿主写屏障前的删除准入；INV-13 保留锁内标签沿用语义，移除模型必有开场索引的错误前提。
