# 主分支与工作树整合

用户要求核对不同提交，整合进 main 后清理其他开发分支和多余工作树。原仓库 `D:/Projects/VelarOS-Platform` 保持 main；历史发行标签、Release 与恢复备份保留，不重发归档。

## 提交核对

核对起点为 main `b3d5fe9d2fec1c84fa7d7526a350251b9239fb35`，已 fetch 并与 origin/main 一致。3 份额外工作树均无未提交源码或 main 之外的提交：dynamic-models 在 `39aa7399`，observe-dynamic 在 `b3d5fe9d`，release-092 在 `308b3f30`；这些提交均为 main 的祖先或 main 本身。

原 D 盘目录的游离提交 `9d30c7ee` 有 5 条非 main 祖先。`git cherry main 9d30c7ee` 确认下列 4 条已存在等价补丁：

- `c86aa8b7` → `e13aaa34`：输入与写结果边界。
- `4198b12c` → `31580ca6`：模块生命周期与输出边界。
- `97fb61ca` → `0b1b0e4b`：官方 Bun 资产安装。
- `2726dd8f` → `308b3f30`：权责与物理资源所有权。

第 5 条 `9d30c7ee` 的子会话上下文装配已由 main 的 `fcfa0b96` 采纳。对两提交逐文件提取实际增删行并比较，差异为 0；`range-diff` 的差别来自周围主线修复及上下文。main 后续 `27b7d3e1` 又统一主会话和子任务的 `prepareSession` 接口，并保留独立装配和资源回收验收。把旧实现再覆盖回来会撤销主线后续工作。

本次使用 ours 合并策略记录这 5 条已采纳提交的祖先关系；该策略以本次等价核对为前提，仅补齐历史，不替换现有实现。本次除本文以外，源码、合同、生成面、版本和依赖清单均不改变；不新增运行时行为，也不扩大既有验收承诺。既有功能验证保持，本次核对历史覆盖和模块所有权。

## 清理与恢复边界

整合前 main、所有 refs、原游离历史均有完整 Git bundle，已运行 bundle verify。额外保留当前临时工作树的 341 份忽略文件（128099673 字节）的证据归档，包括发布收据、测试日志和候选归档；依赖安装目录和编译输出可重新生成，未递归跟随指向原仓库 node_modules 的 junction。证据 tar 名单与原文件名单逐项一致。

主历史 bundle SHA-256：`2628f1374cfdcf9279ac007013f3f9a7d9bc34082290600ef62dfb8fed87acc0`。证据 tar SHA-256：`57d596017b9e4c2e178314824a76bc04bad053d88cb40445d38a3b52a9f6d039`。本地恢复目录与逐文件摘要记录于独立的 backup-receipt.json。

本次 `bun run check:module-ownership` 在原 D 盘 main 目录通过，26 模块全部通过，沿用原互斥锁执行并正常释放。没有源码变更，不重做既有构建或功能场景测试。

额外工作树通过应用归档入口处理。应用拒绝删除仍被其他聊天使用的工作树时，保留其目录和引用，不用命令行绕过占用保护；占用处置及最后核验状态另记本地整合收据。历史 tag 和已发布资产不删除。

当前应用明确拒绝归档 release-092（`Another active task still uses this worktree.`），也拒绝归档本聊天的 observe-dynamic 主目录（`The task's primary checkout cannot be removed.`）。dynamic-models 目录由另一正在运行的聊天使用。清理目录前须先迁移对应聊天；提交整合与主分支推送独立完成，目录清理不能冒称已完成。
