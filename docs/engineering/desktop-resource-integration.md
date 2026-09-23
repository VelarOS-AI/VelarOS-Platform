# Desktop 资源定位接入差量

Desktop 的进程资源注册表通过 `OfficeResourcePort` 和 `ComputerResourcePort` 注入当前能力单元。安装目录、用户启停与产品目录由 Desktop 持有；平台能力每次定位读取当前端口状态。

## Office 公开面

- Node 入口使用 `createMarkItDownLocator({ resources })` 创建宿主持有的定位器。导出的 `markItDownBinaryResolver` 单例移除；调用方改为创建实例，以显式连接资源目录和停用状态。
- `OfficeSpacePort.locateMarkItDown` 的类型不变，说明明确返回 null 代表不可用。操作按端口是否存在选择来源；宿主明确返回 null 时抛 `OFFICE_MARKITDOWN_UNAVAILABLE`，没有提供端口才使用内部默认定位器。
- 模型操作、schema、效果、发现信息、声明和模板保持当前九个 Office 操作。既有缺失转换器错误承诺继续适用。回归验证宿主停用且默认目录仍有安装时，外部命令不会执行。

## Desktop 所有权

资源注册表、目录服务和安装器位于 `src/main/platform/resources`，启动层提供 Cloud 下载、配置、存储位置和窗口广播。Office 与 Computer 的工厂共享注册表，目录查询使用物理安装视图，执行定位尊重当前停用状态。

## 验证

Office 44 项测试、Velaros 类型检查和构建、模块归属与 Script 声明一致性检查通过。Desktop 的独立迁移和验证记录位于其 `docs/architecture/main-cleanup.md`。
