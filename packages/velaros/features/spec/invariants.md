# Feature 不变量

| 编号 | 承诺 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | 安装与卸载在副作用前由宿主授权；拒绝后没有写入。 | 测试 | `spec/acceptance.test.ts` |
| INV-2 | 加载复用本轮固定身份与取消信号。 | 测试 | `spec/acceptance.test.ts` |
