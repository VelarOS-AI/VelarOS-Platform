# Script 宿主进程与共享 worker

## 当前结构

`@velaros-ai/script` 持有程序检查、共享父端运行器、QuickJS 执行核心和能力桥。宿主只负责建立受信进程、投递消息、回收进程。单次程序使用单次进程；模型源码通过消息传递，不写入临时文件。

`createSubprocessCodeRunner({ launch })` 接受 `SubprocessCodeRunnerOptions`。`ScriptProcessEvents` 提供接收消息、stderr、异常和退出事件；`ScriptProcess` 提供发送与终止回执。共享 `SubprocessCodeRunner` 统一执行预算、暂停程序时钟、日志与输出采集、能力回执、自证检查和收尾。

`@velaros-ai/script/worker` 是独立的运行环境入口，公开 `startScriptWorker`。它只加载 QuickJS 及纯程序构造逻辑，不加载编译器、Node fork 或父进程运行器。宿主经 `ScriptWorkerOptions` 注入 send、onMessage、exit。初始化失败保留原异常；正常终态交付后，由父进程统一终止与等待退出，避免无 flush 回执的消息端口提前退出丢失结果。

Node 宿主的 `nodeSubprocessCodeRunner` 通过 `NodeScriptProcess` 使用同一个共享父端运行器；`bin/script-child.mjs` 只是 Node IPC 启动壳，调用相同 worker 入口。Electron 宿主必须显式提供自己的进程适配器，Node 默认入口不选择 Electron 可执行文件。

## 对外合同差量

- 新增 `createSubprocessCodeRunner`：宿主可以注入进程创建，不复制计时、能力桥与结果语义。
- 新增 `SubprocessCodeRunnerOptions`、`ScriptProcessEvents`、`ScriptProcess`：进程事件、消息和回收合同不带 Node ChildProcess 或 Electron 类型。
- 新增 `ScriptWorkerOptions`、`ScriptWorkerCommand`、`ScriptWorkerEvent`：共享 worker 与宿主通信，命令和事件是可序列化的数据形状。
- 新增 `./worker` 运行环境入口及 `startScriptWorker`：受信 worker 可独立加载，包内 bin 与外部宿主使用同一执行核心。
- `CodeRunOutcome.pendingCalls` 保存程序停止瞬间待决能力调用的身份，防止等待进程回收期间的迟到回执擦掉既有 unsettled 承诺。
- `CodeRunnerApi`、`CodeRunRequest` 及模型能力操作保持现有语义；本轮不修改模型可调用操作、schema 或工具定义。
- 运行完成现在等待 `terminate()` 回执；预取消不启动进程，创建期间取消仍回收返回的句柄，完成后的异步能力回执不会再次投递。
- `ScriptProcessEvents.onExit` 表示宿主确认进程退出且已交付其收取的 stderr，不绑定 Node 的流关闭事件；Node 适配器仍等待 close。
- 能力调用用实际 try/finally 恢复程序时钟与待决集合，同步抛错和异步拒绝遵循同一收尾规则，guest 捕获调用错误后继续等待也受原超时预算约束。

## 验收承诺

新增 INV-28 覆盖宿主注入、启动与发送故障、取消、终态回收以及迟到能力回执。INV-9 明确 Node 默认入口识别其运行环境，QuickJS 自证继续检查 guest 不能访问 process、require、fetch 或 WebSocket。

INV-26 保持“已经发出的能力调用在程序取消后被中止并列入 unsettled”的承诺。原测试在提交前启动 300ms 计时器，可能在编译或进程初始化期间取消，使能力尚未发出；改为在实际 invoke 开始后取消，直接核验承诺要求的中途取消场景。

部署隔离仍由宿主实际验收；Node 默认运行器的发布认证常量保持 false。Electron 的发布验收需在实际应用与 ASAR 资源布局中验证 worker 启动、QuickJS WASM、能力回调、输出和取消回收。
