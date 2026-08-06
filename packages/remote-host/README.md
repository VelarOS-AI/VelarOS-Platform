# Remote Host

`@velaros-ai/remote-host` 是**远程能力节点**的传输实现:让一台机器成为另一台机器上 Kernel 的
能力提供者(典型场景——Mac 上跑 Agent 大脑,Windows 上做构建、USB Token 代码签名与只有
Windows 才有的软件)。

wire 契约不在本包,在 `@velaros-ai/kernel/contracts/protocol` 的 `remote-node`。本包只实现两端。

## 职责

| 子路径 | 角色 | 内容 |
| --- | --- | --- |
| `./node` | 被调侧(无头能力提供者) | WebSocket 监听、配对与验签、能力派发、幂等去重、截止与取消、审计 JSONL |
| `./client` | 主调侧(完整宿主) | 连接与重连、`isolation: 'remote'` 隔离适配器、清单投影与命名空间化、凭据端口 |
| `.` | 两侧共享 | 帧编解码、Ed25519 密钥与 challenge、清单摘要 |

## 边界

- **不做授权策略。** 两端各自的 permission broker 说了算:主调侧在帧离开本机**之前**逐权限
  判定(这正是调用要绕 Kernel 而不是直连 socket 的原因),被调侧再按自己的配置开关拦一道。
  本包只负责把判决如实搬运,不新增第三份策略。
- **不做会话权威。** 节点零会话、零 Agent 主干(宪章 §15 原则三:每份状态单一 owner)。
- **不自建 TLS。** 应用层做设备密钥认证;网络层的加密与隔离交给私有覆盖网(Tailscale /
  WireGuard)。绑定地址默认 `127.0.0.1`,**必须显式配置才对外监听**。
- **不碰凭据明文。** 私钥永不上线、永不进日志、永不进协议帧;审计行刻意不含 input/output。

## 消费方

- `@velaros-ai/serve-host` 消费 `./node`,让 `velaros serve` 成为可被远程驱动的节点。
- Desktop 消费 `./client`。

设计判决与 Windows 侧欠账见 VelarOS-Desktop 的 `docs/remote-capability-node.md`。
