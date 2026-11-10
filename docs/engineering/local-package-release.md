# GitHub 发布与验证

正式包发布由 `.github/workflows/release-packages.yml` 在 GitHub Actions 的 Linux runner 执行，不要求维护者拥有 Linux/macOS 发布机。CI 在 main 推送、PR 和手动触发时运行完整 `bun run check`；PR 不取得写权限或发布凭据。独立 CodeQL 暂未启用，现有依赖安全与架构检查仍在完整质量门中运行。

## 准备发布源

提交源码、包版本、锁文件及发布流程，等待 CI 通过。创建并推送对应版本的 tag，再从 main 手动运行 **Release packages**，输入该 tag。工作流固定从 `refs/tags/<tag>` checkout，使用 package.json 声明的 Bun 版本、Node 24.22.0、Linux bubblewrap 和 ripgrep。

发布器核对官方 origin、干净工作树、完整 HEAD、本地 tag 对象及官方远端 tag/peeled commit；tag 必须符合整列 `v<根版本>` 或单包 `<包名>@<版本>` 合同。身份始终由实际 Git 查询确认，不能只凭 Actions 环境变量声明。

## 检查与产物

工作流调用 `bun run release:github <tag>`。发布器执行冻结安装、`release:preflight`、`release:check` 与新构建；完整 `bun run check` 由 CI 独立执行；安装后、检查后、构建后、逐包上传前及正式公布前重新确认源码身份。真实发布不接受跳过构建或 dry-run。整列 tag 默认交付整体 `@velaros-ai/velaros`，内部源码模块不再作为该次发布的独立安装资产；工具包仍可按显式单包 tag 独立发布。

每个包使用 `safePackPackage` 在独占临时目录打包，保留路径边界、超时和进程组回收。发布前核对 tarball 内包名、版本、可安装依赖及 dist，并重新确认 SHA-256。GitHub Release 上传的是已核验的同一份 tarball。

所有归档先完整上传到 draft。基础与能力的真实 URL 互相闭合后，候选才以 prerelease/non-latest 供验证器普通下载；实际已上传两份字节通过无覆盖安装、冻结、摘要/锁来源、唯一基础、严格声明和真实项目事务后，上传 `release-manifest.json` 与 `release-validation.json` 并再次核对，最后晋升 stable/latest。清单记录 sourceSha、releaseTag、每包版本、canonical URL、文件名、大小、SHA-256 和 SHA-512 integrity。待验失败尝试恢复 draft，不晋升正式；恢复失败与验证原错同时保留。重跑前需明确处理失败候选，发布器不覆盖已有 release 或资产。检查和打包日志保留在对应 Actions run。

GitHub Release 资产可匿名下载，不依赖 GitHub Packages 的读取令牌。消费者按清单更新源码身份、两份 canonical URL 和摘要，再完成冻结安装与消费验证。能力包对基础是固定官方 URL 的普通必需依赖；成对消费不把宿主改成另一 file 来源，不写 overrides/resolutions。覆盖只供开发，不进入正式清单。正式基础/能力成对发布走 GitHub 工作流；独立工具包保留自身发布路径，不用 registry 发布伪代两份 URL 的真实消费证明。

## 权限与回归

工作流只允许在官方仓库 main 上手动触发，发布 job 仅授予 contents:write，默认使用短期 GITHUB_TOKEN。若目标提交与 main 的工作流文件不同，GitHub 创建 Release 可能额外要求 Workflows 写权限；可通过仓库 secret `PLATFORM_RELEASE_TOKEN` 提供限于本仓库、具备 Contents 与 Workflows 写权限的发布身份。该凭据只注入正式发布步骤，不进入 PR 检查；临时配置应在发布后移除。权限规则见 [GitHub Release API](https://docs.github.com/en/rest/releases/releases#create-a-release)。Actions 固定到提交 SHA，checkout 不持久化凭据。并发发布串行且不会取消正在进行的发布。

`bun run check:release-source` 覆盖参数、仓库地址、轻量/annotated tag、远端不一致、检查期间身份变化、完整检查的顺序和失败传播。架构门继续独立核对发布工作流、完整检查调用与同一 tarball 发布，不再强制禁用托管 CI。
