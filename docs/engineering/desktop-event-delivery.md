# Desktop 事件交付屏障沉淀差量

日期：2026-09-22。目标是消除“执行已完成，但产品事件尚未落盘”的收尾窗口，并把有序交付机制供宿主复用。

## 对外合同

- Runtime 根入口增加 `createEventDelivery` 工厂和 `EventDeliveryApi<Value>`；产品面登记在 contract/provides.ts。append 冻结可结构化克隆的输入，等待其持久写入及按序交付；flush 等待调用前已接收的事件；close 同时封闭新输入，重复调用保留原有成功或失败。
- contract/requires.ts 增加 `EventDeliveryOptions<Value, Receipt>`。persist 由宿主按调用顺序分配持久身份并在持久化完成后返回；不同 persist 可以同时等待以支持合批。deliver 串行消费成功回执，拒绝会停止后续交付。
- 没有增加模块工具、模型操作、schema 或包子路径；已有会话及事件合同不变。

## 失败与恢复

持久化或传输失败时，当前通道保留首个错误；已接收的在途写入仍被等待，但后续回执不再交付。append、flush、close 均将错误交给调用者。输入不可克隆同样使交付失败，不能越过它发送终态。

通道只负责当前进程内的写入和交付顺序。持久日志序号、重放游标、重启修复以及权威会话快照确认后的裁剪由宿主存储负责。传输层完成不代表用户已读，也不代表产品快照已保存。Platform 事实日志到 Desktop 产品日志的跨存储故障恢复仍需后续单独接入。

## Desktop 接入

ChatStreamBridge 等待恢复日志初始化后创建交付通道，所有文本和结构化事件共用一个顺序。persist 复用 StreamRecoveryStore 的合批写入及 sync；deliver 使用原 IPC 发送路径。窗口关闭或 IPC 不可用时，已有日志留待恢复请求，保持原有行为。

PlatformSessionRuntime 发出终态后必须等待 stream.flush，completed 才能成功；写入失败会使 completed 拒绝。等待交付期间运行句柄已关闭，状态查询不再访问它。EngineHookEventBridge 透传 flush，保证实际装配链上的观测装饰器不丢失屏障。

## 验收差量

新增 INV-40，覆盖持久化前不交付、乱序写入完成仍按序交付、保留合批、写入失败及传输失败拦截终态、关闭排空所有在途写入、输入冻结和失败可观察。

Desktop 增加完成回执等待屏障、持久化失败拒绝 completed，以及真实 Bridge 的初始化排队、写入乱序、失败停发、初始化失败和 hook 转发回归。既有断流恢复和确认裁剪用例的行为承诺保持。

## 验证

- Platform 交付机制 5 项通过；新增测试已登记包级 test 命令。
- Desktop 真实 Runtime 16 项、Bridge/hook 4 项通过；Electron Node 环境合计 20 项通过。
- 既有断流恢复组合回归 11 项通过；21 个受影响类型分区通过。
- Platform 7 包拓扑构建、Desktop 生产构建及 Electron 入口产物核验通过。
- 两仓 module ownership 和 git diff --check 通过。
- Desktop 架构差量检查仍有 document-renderer README 的 6 项既有错误，该文件本轮无改动。
