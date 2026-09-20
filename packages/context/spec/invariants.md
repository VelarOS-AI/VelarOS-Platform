# Context 不变量

| 编号 | 承诺 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | 原文可召回、CAS 提交唯一、新用户输入保留且重启可恢复 | 测试 | test/context.test.mjs |
| INV-2 | 引用作用域、预算与材料身份受控 | 测试 | test/context.test.mjs |
| INV-3 | 证据只从真实源物化，版本变化与范围撤销阻止发布，diff 需要本次基线 | 测试 | test/views.test.mjs |
| INV-4 | 需求与胶囊不能覆盖事实，未知效果先核对；取消和失效租约不能被复活 | 测试 | test/views.test.mjs |
| INV-5 | 双角色共享预算，候选和查询有界；缺口和原始用户目标不能静默删除 | 测试 | test/views.test.mjs |
| INV-6 | 模型材料保持派生来源，失效依赖传播；完成验收复核当前源 | 测试 | test/views.test.mjs |
