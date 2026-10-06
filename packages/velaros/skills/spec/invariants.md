# Skill 运行环境不变量

| 编号 | 承诺 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | 纯说明与 npm 贡献安装为同一类包，失败不修改当前索引。 | 测试 | `spec/acceptance.test.ts` |
| INV-2 | 环境锁定安装代次，升级和卸载不破坏持有租约的文件。 | 测试 | `spec/acceptance.test.ts` |
| INV-3 | 未授权、已停用或版本失效的宿主能力不得执行。 | 测试 | `spec/acceptance.test.ts` |
| INV-4 | 文件越界、清单损坏和内容篡改必须显式失败。 | 测试 | `spec/acceptance.test.ts` |
| INV-5 | 同名公开依赖和能力的冲突在环境装配前明确失败。 | 测试 | `spec/acceptance.test.ts` |
