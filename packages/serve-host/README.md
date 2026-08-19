# Velar Host

`@velaros-ai/serve-host` 是可选的独立 VelarOS Kernel 产品进程。它复用与 Desktop / Workbench
相同的可注入 Kernel 模块，但拥有自己的数据根、进程生命周期和权限配置；不启动 Electron，也不
包含聊天界面。

## 使用

正式命令入口由 `@velaros-ai/cli` 统一提供；本包只导出 `@velaros-ai/serve-host/cli` 的
`runServeCli()` 命名空间实现，不再发布第二个同名 `velaros` 可执行文件。

```sh
# 可选：显式安装 Host 自己的隔离 Computer Python 运行时
velaros serve computer install

# 启动前台 Host；终端会打印能力摘要、桥接地址和短期插件配对码
velaros serve --project-root /path/to/project

velaros serve status
velaros serve config show
velaros serve config apply --file ./host-config-update.json
velaros serve computer probe
velaros serve extension pair
velaros serve extension disconnect
velaros serve remote pair
velaros serve remote revoke
```

`velaros serve config show > host-config-update.json` 会生成可直接编辑并交给 `config apply --file`
的完整配置；扩大高风险能力时，还必须把终端报出的确认项显式加入 `confirmations`。

Host 始终以前台进程运行；启动终端持续显示连接、配对、surface 和工具执行状态等元数据，按
`Ctrl+C` 退出。能力配置、Computer 检查/安装以及插件和远程节点配对全部通过 `velaros serve`
子命令管理。模型、推理档位和对话仍由当前网页模型（目前是 ChatGPT）拥有；Host 只提供 Kernel
工具与策略，不保存模型凭据，也不会把工具输入、结果或设备令牌打印到终端。

## 本地入口

- Kernel local RPC：仅给受信任的本机原生客户端使用。
- External Agent Bridge v2：给 VelarOS Chrome 插件使用，设备令牌与 RPC 凭据完全分离。
- Host management IPC：macOS/Linux 使用私有目录里的 Unix socket，Windows 使用命名管道；不开放
  HTTP 端口、不提供网页控制面，也不生成 bearer token。

插件的每次工具调用都经过 `KernelClient -> Kernel permission broker -> capability module`。默认只开放
工作区读取；工作区写入、屏幕观察和输入控制分别需要显式确认，未知模块与未知权限一律拒绝。
截图通过 `@velaros-ai/surface-protocol` 的有界图片附件返回，不会把 base64 塞进模型文本。

## 产品边界

Host 是“进程可选”，不是把 Kernel 从库改成服务。Desktop / Workbench 继续进程内组合 Kernel 是
当前正确形态；未来 Web、移动端或原生产品可以在自己的认证网关后消费 `@velaros-ai/kernel/client` 与
`surface-protocol`，不共享 Host 数据库，也不把产品 UI 塞进本包。

面向普通用户的独立安装包位于仓库的 [`products/host`](../../products/host) 产品组合层。它把本包
和所需运行时封装为 macOS DMG、Windows 安装程序与 Linux AppImage，但仍以系统终端/控制台作为
唯一运行界面；打包与三平台发布合同见 [`docs/host-release.md`](../../docs/host-release.md)。
