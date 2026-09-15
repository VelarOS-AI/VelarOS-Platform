# @velaros-ai/rehearsal-sandbox

演练沙箱的公共契约与规则，system 空间、project 空间与宿主的沙箱实现共用一份：

- `./contracts`：沙箱数据（`SandboxRecord`、`SandboxDiff`、`SandboxApplyOptions` 等）、公开上限 `RehearsalSandboxLimits`、落回审批的操作身份。
- `rehearsalSandboxRules.prepareApply(...)`：落回前的核对与确认请求——只认不截断的完整差量，点名了没有变化的路径在问用户之前就拒绝，条数与敏感路径按完整三列算，审批的操作身份带差量指纹。确认的就是要落的。

镜像、差量、落回的引擎仍在各空间的宿主实现里（本机是 `@velaros-ai/system` 的本地内核）。模块卡片见 [MODULE.md](./MODULE.md)。
