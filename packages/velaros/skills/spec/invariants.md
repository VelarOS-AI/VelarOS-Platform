# Skill 运行环境不变量

| 编号 | 承诺 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | 纯说明与 npm 贡献安装为同一类包，失败不修改当前索引。 | 测试 | `spec/acceptance.test.ts` |
| INV-2 | 环境锁定安装代次，升级和卸载不破坏持有租约的文件。 | 测试 | `spec/acceptance.test.ts` |
| INV-3 | 安装不自动加载；能力授权只属于所选会话，卸载或升级阻止旧代次后续调用。 | 测试 | `spec/acceptance.test.ts` |
| INV-4 | 文件越界、清单损坏和内容篡改必须显式失败。 | 测试 | `spec/acceptance.test.ts` |
| INV-5 | 不同 Skill 可以分别安装；同次选择的公开依赖和第三方能力入口冲突在环境装配时明确失败。 | 测试 | `spec/acceptance.test.ts` |
| INV-6 | 开发规范与示例从 velaros:skills 按需查询；校验只读、写操作经宿主确认、成功变更通知订阅者；旧索引迁移不自动加载。 | 测试 | `spec/acceptance.test.ts` |
| INV-7 | 内置 Skill 与安装包共用选择和固定环境；宿主绑定缺失时失败，共用宿主能力逐次核对有效授权，专项 npm 包仅由所选 Skill 提供。 | 测试 | `spec/acceptance.test.ts` |
