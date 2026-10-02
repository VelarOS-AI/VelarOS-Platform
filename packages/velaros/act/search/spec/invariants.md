# 不变量

| 编号 | 承诺 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | 实际操作、模板内容和脚本声明保持一致 | 测试 | spec/acceptance.test.mjs |
| INV-2 | 声明里写给模型的上限与常量表一致，入参核对引用同一份常量 | 测试 | spec/acceptance.test.mjs |
| INV-3 | 模板处理报告保留 status、缺口、覆盖范围与续查身份；current 页保留失败项、stamp、complete 和下一 offset；候选组合只将真实 read 登记成证据，读取失败与未读候选各自保留 | 测试 | spec/acceptance.test.mjs |
