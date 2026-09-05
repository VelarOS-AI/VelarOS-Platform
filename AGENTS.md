# 仓库打包规则

- 临时核验 workspace tarball 时，使用 `bun run check:package-pack -- <包目录名>`，例如 `bun run check:package-pack -- browser`。
- `bun pm pack` 只打包当前工作目录，不接受包目录位置参数；仓库脚本与临时命令都不得从 workspace 根目录直接调用它。
- 打包目标必须是本次运行独占的临时子目录，不得直接使用 `/tmp`、`/private/tmp` 或系统临时目录根。
- 新增打包流程必须复用 `scripts/release/safe-package-pack.mjs`，保留超时、进程组回收和路径边界校验。
