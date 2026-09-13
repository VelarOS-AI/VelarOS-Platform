# Project 2.0 第二轮：文件属性、恢复重试与 Agent 行号视图

日期：2026-09-13。承接 Platform `f1f5203`、Workbench `85f7a93`，本轮改动已整理到两个主工作目录，保留待提交状态。

## 本轮修复

| 真实问题 | 修复与证据 |
| --- | --- |
| rename/delete 后重建文件丢失权限：0751 变成 0644，0600 私有文件回滚后扩大读权限 | snapshot、暂存视图、补丁与持久恢复计划携带普通权限；缺失路径按捕获权限重建，既有文件保留当前权限。初始 6 个回归用例中 5 个失败，修复后通过。 |
| 连续 rename、amend 后的 rename 丢失 UTF-16 等编码 | 文件属性与正文一起沿事务暂存视图传递；用 UTF-16 原始字节、不同权限、连续重命名和 amend 验证。 |
| 失败恢复重写了文件，事务仍引用旧 revision，恢复后无法直接重试 | 只在恢复成功后刷新已恢复路径首个补丁的 base revision；内存恢复和重启恢复共用逻辑，保留外部修改保护。 |
| Agent 使用 replace_lines 时仍要手数段内行号 | 模型读取视图自动显示 `N\|` 行号并标记 `contentFormat=line-numbered`；原始工具结果及 recall 正文保持原样。预算包含编号成本，续读行列仍按原文计算，历史重复压缩不会重复编号。 |
| Workbench 越界 cwd 只有 UNKNOWN | 返回 Project `SCOPE_VIOLATION`，附当前根目录、请求路径、解析路径和恢复建议；run/write/edit 的 cwd 描述说明项目内目录约束。真实续作已收到新错误信封。 |
| 验收脚本硬编码旧 kernel 目录，读取失败仍可能假通过 | 从 Git 跟踪清单发现实际 kernel，逐个核对请求文件的数量、路径和完整正文；Git 路径清单使用 NUL 分隔。 |
| 验收只比正文，脚本也未进入 TypeScript 检查 | 所有回滚比原始字节和普通权限；rename 前后及 rollback 后直接执行 shebang 脚本，验证旧路径消失和目标属性保持；脚本纳入 Workbench typecheck，使用工具契约的 safeParse。 |

权限检查覆盖 POSIX 普通 rwx 位。重建原文件权限不受当前 umask 截断；普通新建仍遵循 umask。捕获权限只允许 0..0777，损坏的持久权限字段会被拒绝。

实现继续使用 files / transactions / persistence / types 的责任划分。补丁属性读取和合并集中于 `transactions/patch-attributes.ts`，不增加 Agent 编辑输入字段。

## 真实 Agent 执行

Workbench 候选宿主在独立的 `VelarOS-Workbench-project-v2-round2-test` 大型仓库 worktree 上使用 GPT-5.6 Sol 完成两次实际开发任务：修复验收盲点，再补齐 rename 阶段的原路径消失和属性比对。产出的脚本经过主任务审查，合入主工作目录，并补上类型检查与路径解析细节。

- 第一次 8,029 UTF-16 字符、10 操作的编辑成功。
- 随后的 replace_lines 首次多包含一行，触发语法校验，磁盘未写入；修正结束行后成功。这是本轮增加逐行编号的直接证据。
- 更新 Agent 读取视图后，真实续作自然使用 replace_lines，一次完成 14 行范围替换并通过验收。
- cwd 越界仍有一次实际尝试，新信封明确返回 SCOPE_VIOLATION；不把它记为零失败或泛化为整体成功率。
- 格式检查的非零退出和工具执行错误分别统计。实际记录见 [历史审计](project-v2-round2-history.json)。

这是小样本真实任务证据。确定性验收覆盖所有已暴露工具与编辑方法，不能据此声称模型自然使用过每一种方法。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| Project 完整 check：类型、lint、架构、Agent 契约、构建及测试 | 360 pass，0 fail，31 文件，1,921 断言 |
| 文件属性专项 | 16 pass，0 fail；含 50 文件批量 rename/rollback、重启恢复、恢复后重试、外部 chmod、umask 和损坏权限输入 |
| Agent 全量构建、浏览器边界与测试 | 732 pass，0 fail，109 文件，1,608 断言 |
| Agent 类型及改动文件 lint | 通过 |
| Workbench 主目录全量测试 | 601 个隔离测试 + 15 个发布目录测试，通过 |
| Workbench 候选包全量测试 | 601 个隔离测试 + 15 个发布目录测试，通过 |
| Workbench 主目录与候选包 typecheck，主目录 lint | 通过；验收脚本已纳入 typecheck |
| 新 runtime 布局 worktree 的最终真实 Provider 验收 | 53 次工具调用验收通过，8 工具、13 编辑操作、4 写入模式、7 代码查询 action，50 真实源码文件事务及回滚 |
| 旧 core 布局 worktree 的最终兼容验收 | 同样通过；两处目标 worktree 的 Git 状态均干净 |
| Workbench 候选构建及体积预算 | 通过；main 3.70/3.75 MB，renderer 最大资源 3.68/3.75 MB |
| Workbench 启动与界面核验 | ready、connected、模块 healthy，无启动错误；已保存 CLI 截图 |

工具验收包含预期失败命令的诊断断言，并非要求所有 shell 命令都返回 0。详细调用记录见 [验收记录](project-v2-round2-acceptance.json)。

候选包采用本地打包安装，版本号仍为 Agent 0.6.23 / Project 2.0.20，具体内容以 [SHA-256 清单](project-v2-round2-packages.json) 标识。

复现验收时，从 projects 父目录运行，替换为自己的候选宿主目录和干净目标 worktree：

```sh
bun --preload ./VelarOS-Workbench-project-v2-test/scripts/test/setRepositoryCwd.mjs \
  ./VelarOS-Workbench-project-v2-test/scripts/test/verifyProjectTools.ts \
  <projects>/VelarOS-Platform-project-v2-round2-test
```

本机原始日志保存在 `/tmp/project-round2-final-check.log`、`/tmp/agent-round2-tests.log`、`/tmp/workbench-round2-candidate-tests.log`、`/tmp/workbench-round2-final-acceptance.log`。候选包、启动信息、截图与新旧布局验收结果保存在 Workbench 候选目录的 `project-v2-round2-artifacts/`。

## 后续重点

长会话压缩后精确召回尚未执行的 edit 原始输入仍需要单独设计。本轮保证读取模型视图的行号、分页和再次压缩正确，没有把历史预览变成原始输入归档。
