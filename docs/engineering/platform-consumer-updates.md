# Platform 消费仓自动升级

Platform 包发布是唯一触发源。`.github/workflows/release-packages.yml` 在选定包全部成功发布后，
读取 `scripts/release/platform-consumers.json`，并为每个正式消费仓执行同一套升级器：

1. 按发布 tag 和可选 `only` 参数还原本次实际发布的包，单包发布不会碰其它包。
2. 从 GitHub Packages 验证目标版本可读；注册表尚未可见时不修改消费仓。
3. 只替换消费仓清单中的对应直连依赖，保留 `^`、`~` 或 exact 的原有范围意图。
4. 用 Bun 定向刷新锁文件，并拒绝 `file:`、`link:`、`portal:`、`workspace:` 或非
   `https://npm.pkg.github.com/download/` 的 Platform 解析。
5. 运行消费仓冻结安装与验证命令；通过后推送 `automation/platform-<tag[-selection]>` 分支并
   创建 PR，不直接写主分支。

跨仓操作使用仓库 secret `VELAROS_CONSUMER_UPDATE_TOKEN`。该凭据只应拥有正式消费仓的
`contents:write`、`pull_requests:write` 和 GitHub Packages `read` 权限。凭据缺失、包未发布、
锁文件污染、安装失败或消费仓验证失败都会让对应矩阵项失败，不创建 PR。

正式远程清单包含 Desktop、Workbench、Termel、VelarOS Labs 和 VelarScript Editor。
