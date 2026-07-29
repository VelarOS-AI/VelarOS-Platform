# @velaros-ai/agent/protocol

Versioned wire contracts owned by the injectable Agent capability: messages,
session trees, tool leases, turn requests, and Agent execution spans.

This package deliberately does not define Kernel module lifecycle, permissions,
state, capability routing, or product composition. Those live in the kernel base
layer: `@velaros-ai/core/kernel/abi`(module ABI)与
`@velaros-ai/core/kernel/protocol`(wire 调用信封)。

中文接口文档：[docs/api.zh-CN.md](docs/api.zh-CN.md)
