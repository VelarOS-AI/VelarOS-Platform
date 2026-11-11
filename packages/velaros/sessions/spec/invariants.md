# 会话协作不变量登记

编号保持稳定；验收覆盖现有会话协作。目录归属、排队、死锁及投递由宿主判断，本模块只验证输入并转交调用和取消。

| 编号 | 不变量 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | list 无入参，原样返回宿主目录；self 标识发起会话，宿主只被调用一次 | 测试 | `spec/acceptance.test.ts` |
| INV-2 | ask 必填 to/task；to 去除首尾空白，task 原样；只向宿主传递这两个字段 | 测试 | `spec/acceptance.test.ts` |
| INV-3 | 不提供新建工作区入口；旧 workspace/root/site 字段作为未知字段拒绝，不调用宿主 | 测试 | `spec/acceptance.test.ts` |
| INV-4 | 宿主结果与拒绝原样交回，不翻译或掩盖宿主错误 | 测试 | `spec/acceptance.test.ts` |
| INV-5 | tell 必填 to/message；to 去除首尾空白，message 原样，结果为宿主接纳的 queued | 测试 | `spec/acceptance.test.ts` |
| INV-6 | 输入类型、未知字段、空白正文及缺失目标以 SessionsErrorCodes 失败；message 点名问题，宿主不被调用 | 测试 | `spec/acceptance.test.ts` |
| INV-7 | 预取消不调用宿主；调用信号原样转交；取消后不再等待，迟到失败被观察 | 测试 | `spec/acceptance.test.ts` |
| INV-8 | 真实代码面可执行 list、并行 ask 和 tell，程序可以处理错误码 | 测试 | `spec/acceptance.test.ts` |
| INV-9 | 模板只有一次 import，使用真实声明且整份可运行；只寻址现有非 self 会话，不创建工作区 | 测试 | `spec/acceptance.test.ts`、`test/template.test.ts` |
| INV-10 | 三个操作效果为 none，list 无入参，ask/tell 只允许 execute；私有端口和旧工作区字段不出现在模型面 | 测试 | `spec/acceptance.test.ts` |
| INV-11 | 合同、类型、实现及工具函数遵守所有权；contracts 入口不加载 Node 内置模块 | 门禁 | `check:module-ownership` |
