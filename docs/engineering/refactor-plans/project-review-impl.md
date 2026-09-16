# `@velaros-ai/project` 实现层评审

复现脚本在 `scratchpad/project-review-impl/exp*.ts`，用 `spec/support.ts` 同款假宿主（真内核 + InMemoryContextPayloadStore），临时目录建在草稿区、跑完即删；沙箱用例接了真 `@velaros-ai/system` 本地内核。project 源码在草稿区 `shadow/` 里字节级复制自仓库（agent 包被并行实例改动中，用 HEAD 版 agent dist 快照跑，不受影响）。

## 高
- **P1 事务状态文件按整份正文无界增长，几次编辑就锁死整个工作区的编辑能力**。`FileProjectTransactionStateStore.commit`（persistence/FileProjectTransactionStateStore.ts:103-125）把 1000 个保留事务的 oldContent+newContent+baseSnapshots+base64 字节计划整份 JSON 落盘，硬顶 256 MiB（utils/transactions/transaction-state.ts:34）。给 transactionStatePath 时，改一个约 3 MB 文件每次 apply 状态涨约 22 MiB，第 11 次撞顶抛 TRANSACTION_RECOVERY_CONFLICT，此后 apply 与 prepareEdit 全部失败直到事务被 LRU 淘汰。复现 exp06/exp06b。
- **P2 同一物理文件的项目内别名(symlink/大小写)被当两文件，事务半写后失败破坏 INV-4**。canonicalPath 只做词法 toRel(toAbs())、不 realpath（transactions/TransactionPlanner.ts:169）。一次 project:edit 改 link.ts+real.ts（同 inode）时先写一个、再处理另一个触发冲突，磁盘停在半写，报 TRANSACTION_RECOVERY_CONFLICT。disk BEFORE "L1\nL2\nL3\n" -> AFTER "A\nL2\nL3\n"。复现 exp28/exp02。
- **P3 大小写不敏感盘上 readDeny/writeDeny/protectedFiles/generatedFiles 全可被大小写变体绕过**。authorize 的 rel 取模型原样大小写、glob nocase:false（files/FileStore.ts:128-158, utils/glob.ts:9）。read .ENV 读到被 deny 的 .env；PACKAGE.json 覆盖 protected package.json；api.GENERATED.ts 编辑 generated 文件。复现 exp03/exp04。
- **P4 project:sandbox 源经项目内 symlink 指项目外，apply 写出项目根(越界)**。resolveSourceInsideProject 只做词法包含判断、不 realpath（utils/agent/sandbox.ts:19），系统内核随后 realpath 到项目外做镜像，apply 落回外部目录。复现 exp07(接真 system)。

## 中
- **P5 项目内 symlink 目录/大小写别名使 readDeny 与宿主 fileFilter 读遮挡失效**。cfg->secrets 的链接使 read cfg/prod.key 读到 deny 内容；SECRETS/prod.key 同穿透。复现 exp05。
- **P6 project:sandbox apply 绕过全部写治理、run 读 readDeny 且不脱敏不逐条确认**。落回只走一次 prepareMutation+一次确认，不过 deny/protected/generated；run 输出不经 secretRedaction。writeDeny/protected/generated 路径被覆盖，cat 私钥/sk-live-... 明文返回，confirmations=0。复现 exp17/exp18。ProjectExecutionOperations.ts:70-109。
- **P7 .git 可写 + 内核在根里跑 git → 普通编辑即触发任意命令执行**。默认策略无 .git deny（.git/** 只是搜索缺省排除 utils/files/queries.ts:14）；模型 overwrite .git/config(core.fsmonitor) 或 create .git/hooks/*，内核自身的 git add -N/check-ignore(ProjectGitIndex.ts:48, file-listing.ts:50) 即执行注入命令。Desktop 有 fileFilter 兜底，但 Workbench 宿主(ProjectCapabilityProvider.ts:109)不装 fileFilter。复现 exp09/exp09b。
- **P8 搜索片段先按窗口截断后脱敏，边界密钥泄漏(read 会脱敏、search 不会)**。TextFileAdapter.ts:36 片段 slice(±120)，脱敏在 ProjectQueries.ts:372 对已截断片段做；被切断的 sk- 长串匹配不中原样返回。适配器回退是所有非 UTF-8 文件的必经路径。复现 exp14。
- **P9 durable pending 单槽位，并发 apply 抹掉另一事务恢复计划，崩溃后半写无从恢复**。pending 单值(FileProjectTransactionStateStore.ts:109)，每次非 pending commit 以 undefined 覆盖(LocalProjectKernel.ts:361)；LockManager 允许不相交路径的两个 apply 并发。复现 exp11。
- **P10 模型正则进 new RegExp 对整文件执行，V8 灾难回溯阻塞主进程(ReDoS)**。TextFileAdapter.ts:42 new RegExp(query,'gi') 对整文件 exec；V8 下 (x+x+)+y 在 28 字符输入耗时 1.3s、约 4 倍/字符增长。Bun 用 RE2 无回溯故本地不卡，但生产是 Electron/V8。复现 exp13/exp13-node-regex.mjs。text-match-feedback.ts:420 同类。

## 低
- **P11 无 durable 时每次编辑仍常驻整份正文**：60 次改 1MB 文件 +630MiB(保留 60 事务)；变更记录 replace_content 意图带整份 expectedContent+content(20 次改 500KB → changes.jsonl 58MiB)。复现 exp25/exp08。
- **P12 超大文件签发可编辑 fileRef 但编辑必 NOT_SUPPORTED**(source-window.ts:53 vs PreparedContentStrategy.ts:33)。复现 exp19。
- **P13 变更记录追加中途崩溃后二次重开把残行拼进后续记录，feed 永久损坏**(FileProjectChangeFeed.ts:36-61，'a' 模式只容忍末行残缺)。复现 exp16。
- **P14 project:change 的 move/create 撤销后留空目录**(LocalProjectKernel.ts:1229 只删文件不清空父目录)。复现 exp27。
- **(疑似中, Windows)** NodeCommandProvider 经 which@2，Windows 语义先查 cwd 再查 PATH；内核在项目根跑 git/rg，项目里的 git.cmd/rg.exe 会被优先执行。which@2 Windows 分支模拟已确认(exp21)，真机待复验。

## 核对为符合预期(未计入)
字节保真 INV-9 11 例全过(exp10)；可见范围 INV-2 拦越界编辑(exp15)；脱敏行不签发可编辑 fileRef(exp26，但该正则会误遮普通 accessToken/refresh_token，属过度匹配的可用性问题)；atomicWriter 拒多硬链接、保 mode、fsync+rename+目录 fsync 稳妥；悬空/越界 symlink 写被 realpath 拦(exp24)。
