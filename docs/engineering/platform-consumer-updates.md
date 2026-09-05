# Platform 消费仓自动升级

`.github/workflows/release-packages.yml` 在 tag 上发布选定的包。手动运行时可显式启用
`update_consumers`，在发布成功后读取 `scripts/release/platform-consumers.json`，并为每个
正式消费仓执行同一套升级器。默认只发布包，产品可在完成对应源码迁移后自行升级依赖。
启用自动升级后的流程：

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
