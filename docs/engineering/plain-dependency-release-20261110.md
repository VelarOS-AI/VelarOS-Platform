# 正式普通依赖发行 0.9.7

用户明确要求 overrides 只用于开发，正式发行和消费者不写覆盖。0.9.6 已有基础归档与源码质量证明，但实际仓外 Bun 1.4.3 对两份官方 URL 的普通无覆盖安装，会为 capabilities 的精确基础 peer 请求 npm registry 并得到 404。本次在 Platform 发行元数据根修，不修改旧归档、不让产品补覆盖或兼容别名，也不重做 26 模块行为审查。

## 确定的依赖合同

基础与能力继续同版、同 tag 交付：`@velaros-ai/velaros@0.9.7`、`@velaros-ai/capabilities@0.9.7`，火车标签 `v0.7.8`。能力包对基础使用普通必需 dependencies，值为该 tag 官方基础归档的 canonical URL；移除 registry-only base peer，不改成 optional peer 或运行时兜底。下载 URL 由仓库身份、tag 与文件名同一 helper 生成并保留仓库路径大小写。真实仓根决定源身份，源码包不能另报一个仓库。

装配能力的产品在普通 dependencies 中同时使用两份 canonical URL，锁文件保留真实来源与 SRI。开发 overrides/resolutions 从正式清单剔除；消费者也不写。独占本地候选只改清单并经现有 safePackPackage 打包，用来验证边界：canonical HTTPS 宿主的普通安装、冻结安装与唯一基础实例通过；同字节 file 宿主混用能力包的 HTTPS 基础依赖时，实际安装出第二个基础实例。因此文件缓存可以校验或恢复下载，不能代替成对依赖的 canonical 身份，不向产品交付这个本地候选。仅使用基础的消费者不涉及能力共享解析边界。

## 正式归档与晋升

现有基础同字节消费、Git/tag/干净源、冻结安装与安全打包门继续保留。为打破“新 canonical URL 尚未可下载”的循环，两份实际归档先完整上传 draft，再公开为 prerelease/non-latest 待验。发布器下载真实 URL，逐项核大小、SHA-256、SHA-512 和本次保留原件，使用仓外独占目录、冷缓存、无覆盖普通安装和冻结安装；核锁 v2 的精确 URL 与直接 SRI、无第二基础、真实版本与同一解析实例、严格声明及一次 Project 实际文件事务。

真实 pair 收据必须持久化并在晋升前重读核对；源身份、两份字节、同版、canonical 来源与全部验证项再次通过，才上传最终收据并晋升 stable/latest。失败尝试恢复 draft；恢复失败与主错共同保留，不声明正式成功。临时更改依赖或只测基础不能替代该证明，待验版本不交给产品作为最终身份。

实现差量只包括发行声明/暂存器、普通 pair 验收和 publisher 晋升，以及版本/生成目录和文档。基础执行实现未再改动；既有 53 个场景与各模块绿色证明保留。新正式包的摘要和验证身份以本 tag 的 `release-manifest.json`、`release-validation.json` 为准；源码基准与发行实际安装证明分别记录。

源码交付核验：新增相关 17 项测试、改动发行脚本 lint、`bun run format`、离线 lockfile/catalog 刷新、`release:preflight` 与 26 模块 `check:module-ownership` 全部通过。严格声明与 Project 事务夹具已用同 API 的既有本地候选预检通过；这只验证夹具可运行，正式普通 pair 结论仍由本次实际发布流水线的收据决定。

## 正式交付结果

[发布流水线 42747321692](https://github.com/VelarOS-AI/VelarOS-Platform/actions/runs/42747321692) 成功，源码固定为 `30982bfc1ae92912aa734ea5be2acf01687d87ed`，`v0.7.8` 已为 stable/latest。相同源码的 [main CI](https://github.com/VelarOS-AI/VelarOS-Platform/actions/runs/42747292541) 通过。实际官方 pair 的普通安装、冻结安装、单一基础实例、严格声明、真实 Project 事务、来源和 SRI 六项均通过；随后独立公开下载两份归档，再核大小、SHA-256/SHA-512、内部清单与公开收据一致。

| 归档 | 字节数 | SHA-256 |
| --- | ---: | --- |
| [基础 0.9.7](https://github.com/VelarOS-AI/VelarOS-Platform/releases/download/v0.7.8/velaros-ai-velaros-0.9.7.tgz) | 2265406 | `d4f3e502eb59e4a3d42e5ca66a8aa55d3da06586e7ce79e699644cdbe51a9d69` |
| [能力 0.9.7](https://github.com/VelarOS-AI/VelarOS-Platform/releases/download/v0.7.8/velaros-ai-capabilities-0.9.7.tgz) | 7170390 | `8bf90825f5f4a40b7ead3320ac0bdde1331d49546a44a2f6a39342bb124c25f9` |

正式摘要见 [release-manifest.json](https://github.com/VelarOS-AI/VelarOS-Platform/releases/download/v0.7.8/release-manifest.json)，实际消费证明见 [release-validation.json](https://github.com/VelarOS-AI/VelarOS-Platform/releases/download/v0.7.8/release-validation.json)。产品交接已发送机器收据，未等待分支整理，也未向产品交付临时改写包。

分支整理已完成：本地与远端 heads 仅保留 main，默认分支 main；未采纳的 Dependabot PR #3/#4 关闭且未合入。删除前所有旧 refs 已存入完整 Git bundle，逐 ref 隔离恢复验证通过；bundle SHA-256 为 `07b1214cbbded509401090cd5f3746f506205ae5b33d739a7a40d6dbcc915a15`，另留持久备份。原 D 与旧发布 checkout 仅在原 commit 脱离已退役分支，保留目录；原 D 用户文件、index 物理字节、index blob 和状态前后相同。tags 与旧 releases 保留。本文收尾提交只记录交付结果，不改变发布源码或资产身份。
