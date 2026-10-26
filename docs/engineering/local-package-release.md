# GitHub 发布与验证

正式包发布由 `.github/workflows/release-packages.yml` 在 GitHub Actions 的 Linux runner 执行，不要求维护者拥有 Linux/macOS 发布机。CI 在 main 推送、PR 和手动触发时运行完整 `bun run check`；PR 不取得写权限或发布凭据。独立 CodeQL 暂未启用，现有依赖安全与架构检查仍在完整质量门中运行。

## 准备发布源

提交源码、包版本、锁文件及发布流程，等待 CI 通过。创建并推送对应版本的 tag，再从 main 手动运行 **Release packages**，输入该 tag。工作流固定从 `refs/tags/<tag>` checkout，使用 package.json 声明的 Bun 版本、Node 24.22.0 与 Linux bubblewrap。

发布器核对官方 origin、干净工作树、完整 HEAD、本地 tag 对象及官方远端 tag/peeled commit；tag 必须符合整列 `v<根版本>` 或单包 `<包名>@<版本>` 合同。身份始终由实际 Git 查询确认，不能只凭 Actions 环境变量声明。

## 检查与产物

工作流调用 `bun run release:github <tag>`。发布器执行冻结安装、完整 `bun run check` 和新构建；安装后、检查后、构建后、逐包上传前及正式公布前重新确认源码身份。真实发布不接受跳过构建、dry-run 或手动缩减整列包集合。

每个包使用 `safePackPackage` 在独占临时目录打包，保留路径边界、超时和进程组回收。发布前核对 tarball 内包名、版本、可安装依赖及 dist，并重新确认 SHA-256。GitHub Release 上传的是已核验的同一份 tarball。

所有归档先上传到 draft。`release-manifest.json` 记录 sourceSha、releaseTag、每包版本、文件名、大小、SHA-256 和 SHA-512 integrity，最后才把 draft 公布。失败不会公开不完整版本；留下的 draft 可供维护者检查，重跑前需明确清理失败 draft，发布器不会覆盖已有 release 或资产。检查和打包日志保留在对应 Actions run。

GitHub Release 资产可匿名下载，不依赖 GitHub Packages 的读取令牌。消费者应按发布清单更新源码身份、下载地址和所有摘要，再完成冻结安装与消费验证。此次入口不修改消费者仓库，也不声称旧 GitHub Packages 同版本 tarball 与新资产相同。旧 `release:local` 注册表入口仅为兼容保留，正式工作流不调用它。

## 权限与回归

工作流只允许在官方仓库 main 上手动触发，发布 job 仅授予 contents:write，使用短期 GITHUB_TOKEN，不配置个人令牌。Actions 固定到提交 SHA，checkout 不持久化凭据。并发发布串行且不会取消正在进行的发布。

`bun run check:release-source` 覆盖参数、仓库地址、轻量/annotated tag、远端不一致、检查期间身份变化、完整检查的顺序和失败传播。架构门继续独立核对发布工作流、完整检查调用与同一 tarball 发布，不再强制禁用托管 CI。
