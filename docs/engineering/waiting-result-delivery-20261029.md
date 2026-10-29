# 模型响应期间完成的执行结果失唤醒

## 真实证据与归因

来源是 Desktop 的 `artifacts/showcase/2026-10-28/browser-r2-independent-audit.json`，会话 `showcase-browser-20261029-r2`，正式运行包为 v0.6.73。以下时间均为 UTC：

- 06:05:01.166，请求 `b52056b4` 发出，尚不含 UI 验收结果。
- 06:05:03.896，执行 `c542dcfe-d5d3-40f2-9847-6e971225a551` 完成，结果 `fcf1b340`，exitCode 0；控制终态于 06:05:03.930 完成。
- 06:05:23.891，响应 `d39d09e3` 已接受，done=false，仅表示等待验收；不是供应商仍在生成。
- 06:05:23.924，送达记录 `88d1b541` 对应旧帧 `db3e652c`，没有 `fcf1b340`。
- 06:05:23.930，进入 waiting（记录 `ff258ccf`，交互 pending=[]）；另有普通临时预览服务仍运行。审计至 06:13:00 没有进一步执行，主任务 06:33 再次确认停滞。
- 主任务随后通过真实 guidance 恢复，06:34:02 出现新请求。录制作为失败稳定性证据保留，未把它宣称为完整成功演示。

ActLoop 原先仅在 `done=true` 且没有后台执行时检查 `frames.needsRefresh`。当响应仅表示等待，已有新结果会被仍运行的其他执行遮住。Runtime 的等待订阅只接收之后的变化，无法重放订阅前已经完成的通知。此链路解释本次失唤醒，不应归因于模型错误或供应商延迟。

## 最小修复及边界

- 有后台执行时，先建立本次等待订阅，再检查已发送帧是否存在尚未展示的新结果；有新结果立即进入下一轮。
- 先订阅再检查，保证快照核对期间完成的执行也能唤醒，不留下检查与订阅之间的竞态窗口。
- 本次等待结束或被刷新取代后取消并回收其订阅。取消只作用于等待，运行级后台信号不变。
- 无后台执行时，也在文本等待返回之前检查新结果。没有新结果时仍真正等待，不进行模型轮询。
- 不修改执行预算、并发槽、权限、done 终态验收或后台程序生命周期。

同时修正 memory 的发现摘要：按实际四种装配明确工作记忆、可选上下文整理、可选长期记忆；系统目录仅在已授权 memory.organize 时包含“上下文整理”，中文查询能找到真实操作。没有此操作或没有授权时不宣称或泄露能力。接口、操作合同与生成声明未改变。

## 定向验证

- 旧 v0.6.73 构建：真实 Node + Runtime 的 tools/text 两种协议都复现短脚本完成后继续等待长服务，由 15 秒测试看门狗结束，未进入含新结果的下一帧。
- 修复后的 agent 构建与 velaros 构建均通过。
- `packages/agent/spec/acceptance.test.ts`：94 pass / 0 fail。新增 6 项覆盖模型生成期间完成、检查/订阅竞态、无剩余执行时刷新；并核对没有新结果不轮询、已送达不重复唤醒、取消后订阅数归零，以及刷新前或清理期间的非取消等待错误仍会失败，不被吞掉。
- `execution-observability.test.mjs` 定向 4 pass / 0 fail：两种传输都在模型生成期间释放真实 Node 短脚本，等待实际终态；下一帧必须带对应 resultRef 和真实输出正文，长期服务此时仍在运行，然后通过控制 stop 完成。另保留既有临时服务终态规则的两项回归。
- `system/spec/runtime.test.mjs` 定向 4 pass / 0 fail：四种 memory 装配核对真实 Kernel 描述、中文目录查询、发现后的操作合同，以及无授权时的空结果。
- 定向日志位于 `out/platform-fixes/wakeup-agent-build.log`、`wakeup-velaros-build.log`、`wakeup-agent-acceptance.log`、`wakeup-runtime-targeted.log`、`memory-discovery-targeted.log`。

Windows 完整 `bun run check` 已实际启动，完成 build、typecheck、lint、format 后在 Runtime 测试阶段未通过，并中止了仅属于本次检查的进程树。已独立确认两类本地限制：widget 模板的生成正文 LF 与 checkout CRLF 严格比较失败；默认 Runtime 的单步脚本在进入 ActLoop 之前就返回 `SHELL_CONFINEMENT_UNAVAILABLE`（win32 不支持 read-only 进程约束，capabilityCalls=0）。后者解释同配置子任务的写入次数为零，不放宽进程约束。其余未完成测试不宣称通过，完整日志为 `out/platform-fixes/check-074-windows.log`；单步证据为 `windows-runtime-default-diagnostic.log`，模板明细为 `wakeup-widget-diagnostic.log`。

第一轮 Linux 完整 CI（40832734211，提交 279ed5ba）通过所有测试，Runtime 汇总 1227 pass / 0 fail / 8 skip；新增回归也全部通过。随后公开接口门检出独立 Agent 包版本升级遗漏了 API 基线的版本绑定。按 `check:agent-public-api` 官方更新机制只把 `acceptedPackageVersion` 从 9.9.1 绑定到 9.9.2，声明及指纹均未变化，仍需补提交后的完整门禁重新通过；没有降低检查阈值或预算。

继续检查后置门时，按错误处理规则把等待的空 catch 改成显式成功/失败回执，只有与本次 AbortSignal.reason 同一身份的取消才作为清理结束；新增三条失败传播回归，包含新引导取消等待时同时出现的真实内部错误。另同步 `ProjectPackageVersion` 到所属 velaros 包 0.6.13，仅为内置插件版本身份。Windows 的宿主合同隔离消费安装在 Resolving dependencies 阶段达到既有 120 秒上限并被安全回收，没有提高期限；该门在第一轮 Linux CI 已通过，后续正式门仍完整执行。

Windows DevTools 引擎重现门的另一个本地失败已做独立只读比较：现有 vendor 2508341 字符，pinned Bun 新构建 2507922 字符，归一化 CRLF/LF 后文本完全相等。没有重写 vendor 或放宽检查，`out/platform-fixes/devtools-build-diagnostic.log` 保留比较结果；正式 Linux 门仍必须通过。

以上不等同于正式发布或 Desktop 集成验收。当前运行的 Desktop 快照未改变。发布版本计划为 train v0.6.74、agent 9.9.2、velaros 0.6.13，其他包版本不变；仍必须由同一源码的 Linux CI 和正式发布完整门禁通过，再下载校验实际八包资产，由 Desktop 固定消费并做短实际运行验证。用户要求修好后暂停后续录制与制作。

补充本机验证：Bun 1.4.3 的 Agent 验收 94 pass / 0 fail。固定 Bun 1.3.13 的同文件运行已通过新增六项和既有引导回归，但在后续既有子任务用例停滞，核对所属进程后中止；不宣称该次完整通过，正式 Linux 继续使用固定版本完整检查。
