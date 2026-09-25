# 不变量

| 编号 | 承诺 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | 实际操作、模板内容和脚本声明保持一致 | 测试 | spec/acceptance.test.mjs |
| INV-2 | 声明里写给模型的上限与常量表一致，入参核对引用同一份常量 | 测试 | spec/acceptance.test.mjs |
| INV-3 | 选择题与表单在发起前核对数量、id 与文字长度，核对不过不发起交互 | 测试 | spec/acceptance.test.mjs |
| INV-4 | 回答回到模型前按问题整理，只留下问题里有的选项、字段与对应类型的值；确认只有布尔值或带 approved 的对象算数，含糊的回答按不同意 | 测试 | spec/acceptance.test.mjs |
| INV-5 | 宿主读回的提问与 `ask` 发出的形状一致；坏形状当普通问题，返回 null | 测试 | spec/acceptance.test.mjs |
| INV-6 | 小部件核对标题与代码长度、高度收进上下限后带着调用身份交给宿主；宿主不给显示端口就没有 `velaros:widget` | 测试 | spec/acceptance.test.mjs |
