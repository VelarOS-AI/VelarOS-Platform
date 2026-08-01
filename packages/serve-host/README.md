# Velar Host

`@velaros-ai/serve-host` 是可选的独立 VelarOS Kernel 产品进程。它复用与 Desktop / Workbench
相同的可注入 Kernel 模块，但拥有自己的数据根、进程生命周期和权限配置；不启动 Electron，也不
包含聊天界面。

## 使用

```sh
# 可选：显式安装 Host 自己的隔离 Computer Python 运行时
velaros serve computer install

# 启动无界面 Host；命令会打印控制页地址和短期插件配对码
velaros serve --workspace-root /path/to/project

velaros serve status
velaros serve control
```

打开控制页可以启停工作区读写、屏幕观察和鼠标键盘控制，安装或检查 Computer 运行时，并管理
Chrome 插件配对。模型、推理档位和对话仍由当前网页模型（目前是 ChatGPT）拥有；Host 只提供
Kernel 工具与策略，不保存模型凭据。

## 本地入口

- Kernel local RPC：仅给受信任的本机原生客户端使用。
- External Agent Bridge v2：给 VelarOS Chrome 插件使用，设备令牌与 RPC 凭据完全分离。
- loopback 控制页：只监听 `127.0.0.1`，API 使用独立 bearer token；token 放在 URL fragment，
  不进入请求行或 Host 状态文件。

插件的每次工具调用都经过 `KernelClient -> Kernel permission broker -> capability module`。默认只开放
工作区读取；工作区写入、屏幕观察和输入控制分别需要显式确认，未知模块与未知权限一律拒绝。
截图通过 `@velaros-ai/surface-protocol` 的有界图片附件返回，不会把 base64 塞进模型文本。

## 产品边界

Host 是“进程可选”，不是把 Kernel 从库改成服务。Desktop / Workbench 继续进程内组合 Kernel 是
当前正确形态；未来 Web、移动端或原生产品可以在自己的认证网关后消费 `kernel-client` 与
`surface-protocol`，不共享 Host 数据库，也不把产品 UI 塞进本包。
