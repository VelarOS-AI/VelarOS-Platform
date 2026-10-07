# 不变量

| 编号 | 承诺 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | 请求租约撤销后，迟到与跨请求回复不得受理 | 测试 | spec/acceptance.test.mjs |
| INV-2 | 模型只接收供应商完整结束的原始文本，JSON 使用当前正式 schema 校验 | 测试 | spec/acceptance.test.mjs |
