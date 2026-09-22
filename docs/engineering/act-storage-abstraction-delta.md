# 存储适配边界差量

## 原因与结果

现有 ContextStorage / StoreStorage 已经隔离 SQL 操作，但默认装配静态导入的 LocalContextStorage 在模块求值时加载 `node:sqlite`。实际验证中，禁用 SQLite 会在导入 Runtime 阶段报 ERR_UNKNOWN_BUILTIN_MODULE，宿主来不及注入自己的存储。

本轮沿原端口收敛：SQLite 仅在创建本地适配器时加载；独立后端可以通过原 `storage` 配置进入正式 Runtime。没有增加模型操作、系统模块或第二条 Runtime 入口。

## 对外合同与实现

- `context/src/contract/requires.ts`：明确 ContextStorage 的一致快照、跨实例 CAS、正文先持久化、不透明对象 ID、可选索引/回收、连接所有权与幂等关闭。明确 StoreStorage 事务边界及等待在关闭时释放的要求。方法签名保持一致。
- `velaros/act/runtime/contract/requires.ts`：明确已有 storage 注入的默认选择、成功后的所有权转移、初始化失败时的连接所有者。
- `LocalContextStorage.ts`：按需取得 SQLite 内置模块；不支持时报告 STORAGE_UNAVAILABLE；初始化失败关闭新连接；close 幂等并终止所属等待。
- `LocalStoreStorage.ts`：wait / waitEvents 同时监听调用取消与存储生命周期，关闭时立即释放订阅及计时器，避免稍后查询已关闭数据库。
- `storage-contract.mjs`：可复用于后续适配器的合同测试。SQLite 验证完整共享空间合同，异步不透明 ID 测试替身验证 ContextStorage 非 SQL 路径；替身只供测试。
- Runtime 新增禁用 SQLite 子进程验收，走正式模型请求、ScriptAct、Project 修改、下一轮观察、追踪和会话恢复。既有验收承诺保留。

## 验证与边界

实际验证结果：

- `bun run --cwd packages/context test`：62 项 Node 测试和 8 项 Bun 测试通过。包含 14 项适配器验收与初始化故障清理测试。
- `node --test packages/velaros/act/runtime/test/*.test.mjs packages/velaros/act/system/spec/*.test.mjs packages/velaros/act/search/spec/*.test.mjs packages/velaros/act/agents/spec/*.test.mjs`：367/367 通过，包含禁用 SQLite 的正式 Runtime 验收。
- Context、Velaros 构建与类型检查通过，修改文件 ESLint 通过。
- `check:module-ownership`、`check:code-style` 的 37 项检查及本轮差量空白检查通过。

上述计数包含新增用例，不再另加。新合同测试覆盖两种 ContextStorage 实现以及 SQLite 的对象/消息原子性、幂等、恢复与关闭等待。验证使用确定性模型，没有供应商真实调用。

PostgreSQL 等后端及数据迁移器尚需实现；新适配器必须另证实际数据库的崩溃持久性。适配规范见 `docs/architecture/storage.md`。本轮不改变模型协议、权限、上下文编译或领域文件存储的职责。
