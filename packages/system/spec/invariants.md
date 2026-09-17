# 系统空间不变量登记

每一条都是本模块对外的承诺。改动或删除任何一条，都要在差量报告里点名并说明原来的承诺为什么不对；
新增一条同样要点名。

检验方式分五档，`check:module-ownership` 门会核对每一行的检验器是否真的存在：

| 检验方式 | 含义 | 检验器写法 |
| --- | --- | --- |
| 测试 | `spec/acceptance.test.ts` 里有以该编号开头的用例 | `spec/acceptance.test.ts` |
| 类型 | 由类型定义钉死，改不了 | `src/<文件路径>.ts::<类型名>` |
| 门禁 | 由仓库门禁脚本机械核对 | `check:<门名>` |
| 运行时 | 实现里有断言，违反即抛 `INVARIANT` | `src/impl/<文件>.ts` |
| 文字 | 目前只有文字描述，没有机器检验 | 留空 |

文字档在模块卡片的健康栏里显示为「未验证」，不算通过。

编号只增不重排。INV-1 曾是「与 project 空间判定一致」，那是跨包约束，不属于本模块，已移到仓库级 `tests/capabilities/command-danger-parity.test.ts`。
INV-2（只读判定是白名单加整体否决）、INV-3（递归删除一律判危险）、INV-18（白名单必须严格）随命令策略移到 `@velaros-ai/shell-command`，那边的 INV-1、INV-2、INV-4；本包只留用它的方式（INV-4 审批形状、INV-29 并发）。

| 编号 | 不变量 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-4 | 危险命令的审批是高风险、手动、不可按类记忆的确认，并标明精确命令；真正的授权门在宿主的 ApprovalPort | 测试 | `spec/acceptance.test.ts` |
| INV-5 | 受约束的进程模式没有可用后端时失败关闭，拒绝执行而不是退回裸进程 | 测试 | `spec/acceptance.test.ts` |
| INV-6 | 约束证据如实上报：审批事实与约束事实分开记录，未受约束就写 `enforcement: none`，不冒充隔离 | 测试 | `spec/acceptance.test.ts` |
| INV-7 | wire 面入参用严格 schema，未知字段在解析宿主上下文之前就被拒绝，并带出字段路径；唯一例外是无参的 `system:refresh-environment`，多余字段不报错、只在结果里提醒 | 测试 | `spec/acceptance.test.ts` |
| INV-8 | 对外只发布 canonical 的 `system:` 工具，不发布项目发现或诊断快捷工具 | 测试 | `spec/acceptance.test.ts` |
| INV-9 | 每个工具声明权威的副作用种类，只读工具与副作用一致，一个工具只属于一个职责类别 | 测试 | `spec/acceptance.test.ts` |
| INV-10 | 输出被截断时返回窗口保留末尾且末尾真实，并给出可执行的召回续接；后台命令的状态续接指向 `system:list-tasks`，不交给内核 `job:*` | 测试 | `spec/acceptance.test.ts` |
| INV-11 | 管道分块不会打碎 UTF-8 字符，子进程退出码原样透传，shell 描述符里不带 `env` | 测试 | `spec/acceptance.test.ts` |
| INV-12 | 超时或取消后进程管理最终收敛：终止信号无人响应、close 永不到达时也在期限内结束，并如实标记清理未完成 | 测试 | `spec/acceptance.test.ts` |
| INV-13 | 常驻工具只有读、看、改、跑四个；后台任务、环境刷新按需装入 | 测试 | `spec/acceptance.test.ts` |
| INV-14 | 内核模块注册精确的七个工具，权限清单不含通配 | 测试 | `spec/acceptance.test.ts` |
| INV-15 | `nativeCommand` 只供宿主组合能力使用，永不出现在模型工具 schema 中 | 测试 | `spec/acceptance.test.ts` |
| INV-16 | 文件分工与对外边界不塌：全部工具定义在一个工具文件里；合同、类型、常量分开：合同只有产品面登记、注入面、常量表三个文件且接口的每个成员有中文说明，类型目录一个值都没有、公开数据不带函数成员；实现目录扁平、一类一文件、类实现接口且公开成员不超出接口、按登记分层引用；utils 只放带中文说明的函数与常量；对外入口只转发，导出的类型只来自公开接口与数据、导出的值只能是按公开接口标注的实例与工厂或契约常量表，类、utils 函数、内部接口不出包，导出的数据正好是公开签名用到的数据；环境变量全部登记；渲染进程可加载的入口不碰 Node 内置模块 | 门禁 | `check:module-ownership` |
| INV-17 | 输出窗口的 `endPreserved` 恒为 true，由类型钉死 | 类型 | `src/types/system.ts::SystemCommandOutputWindow` |
| INV-19 | 写系统敏感路径与凭证文件前必须经审批端口确认，按解开符号链接后的真实路径判定；被拒整批不写，临时目录不打扰用户 | 测试 | `spec/acceptance.test.ts` |
| INV-20 | `system:edit` 一批全成或全不成：任何一处定不下来、被拒或文件在核对后被改，什么都不写，并按 not-applied 报告每个问题 | 测试 | `spec/acceptance.test.ts` |
| INV-21 | 文本改动无损：只按认得出的编码（UTF-8、带 BOM、UTF-16、GB18030）严格解码，非法字节按二进制拒改、不读成替换字符；解码再编码得不到原字节的文件拒改，写不成原编码的新文本（孤立代理项、GB18030 表示不了的字符）整批不写；已有的二进制文件不许整个覆盖，符号链接写到它指向的文件、链接本身不变 | 测试 | `spec/acceptance.test.ts` |
| INV-22 | 一次 `system:read` 最多 20 万字符：预算用完后的文件不读盘、不问用户，那一项是失败条目并在 note 里说明 | 测试 | `spec/acceptance.test.ts` |
| INV-23 | 演练沙箱里的命令一律受进程约束：cwd 落在镜像根之内就只能写镜像和它自己的临时目录；没有约束后端的宿主建不出沙箱，不留没有约束的副本；清单读不出来时镜像根里的命令拒绝执行，不退回裸进程 | 测试 | `spec/acceptance.test.ts` |
| INV-24 | 落回只写清单记过的文件：源目录里任何一处自建沙箱以来变过就整批不落，按 not-applied 报出冲突；任何一层的 `.git`（含嵌套仓库）永远不落 | 测试 | `spec/acceptance.test.ts` |
| INV-25 | 丢弃沙箱只删沙箱基目录下面正好一层的目录：id 不合形状、这一项是符号链接、路径解开链接后不在基目录之下或就是基目录本身，一律拒绝 | 测试 | `spec/acceptance.test.ts` |
| INV-26 | 镜像仓库推不出去：镜像里每个仓库（含嵌套仓库、子模块）的每个远端都被改成无效的推送地址，节头写法（CRLF、大小写、尾随空白、旧式 `[remote.x]`）不影响；指向源目录外真实仓库的 `.git` 链接文件不进镜像；网络缺省切断 | 测试 | `spec/acceptance.test.ts` |
| INV-27 | 落回只落用户确认过的那份差量：确认按完整差量计数、列出删除与覆盖、扫敏感路径，确认之后镜像又变过就整批不落（`SYSTEM_SANDBOX_CHANGED`，not-applied） | 测试 | `spec/acceptance.test.ts` |
| INV-28 | 落回只写在源目录之内、要么全落要么报清落了哪些：上级路径是符号链接或文件（又不在这次删除之列）按冲突整批不落；内容先暂存，拷不全什么都不落；挪到位途中失败在 context.applied 里点名已落回的路径 | 测试 | `spec/acceptance.test.ts` |
| INV-29 | system:run 只在入参声明 `parallel: true`、命令只读、不转后台、无需确认时才与别的调用并发 | 测试 | `spec/acceptance.test.ts` |
| INV-30 | 命令只在挑定的那个 shell 里跑：`shell` 给的种类本机没有就在起进程之前拒绝，报错点名可用的有哪些、哪个是默认，绝不换默认 shell 照跑；不给 `shell` 才用默认的那个 | 测试 | `spec/acceptance.test.ts` |
| INV-31 | 代码面与工具面是**同一批操作方法、同一批入参校验**的两个出口：操作表登记的名字与生成声明里的函数名逐个对上（一边有另一边没有都红）；入参没过校验时程序还没动手，回的话点名是哪个字段（`files[0].path`），不是一句「参数不合法」。模型面只有生成的那份声明，表这一侧不写一个字给模型 | 测试 | `spec/acceptance.test.ts` |
