# 继续轮次的生产模块覆盖

本表只记 0.9.5 后这轮语义审查，不用旧“26 模块基础通读”填平本轮。模块以 `governed-modules.mjs` 为准；整读指手写生产源与合同/README/invariants对照，生成面/模板只作合同参考，测试/vendor不计生产覆盖。已完成 R1/E1/R2/A1/S1/C1 的具体链路不循环重审。

| 治理模块 | 本轮状态/边界 | 结果或有限后续组 |
| --- | --- | --- |
| act/runtime | 重点链路已审；装配/历史owner/Control/子任务收尾及events/inspect已修 | 其余手写生产文件列入 G7；旧具体修复保留 |
| agent | Supervisor、ActRunService相关链路已审；取消/结果失败归集已修 | ActLoop/ContextPlanner其余职责 G7 |
| context | 存储owner/恢复租约相关链路已审 | 未覆盖的存储、证据物化、账本等生产职责 G7 |
| execution | 命令受理、PTY、真实close与dispose相关链路已审 | 其余环境/进程采样等手写职责 G7 |
| features | **整读9份手写TS**及合同/模板 | 管理请求跨await原input可变已独立根修，授权与写目标固定 |
| sessions | **整读10份手写TS**及合同/模板 | 本轮无新缺陷；保留宿主单一排队权威与调用者等待取消，既有workspace能力不搬进Runtime |
| memory | **整读13份手写TS**及合同/模板 | 本轮无新缺陷；保留入口快照、条目锁内revision/标签核验、原子发布与真实提交事实，不吞磁盘错 |
| core/platform | **整读10份手写TS**及合同 | Windows打开规格经CMD二次解析候选，先独立核对设计；路径安全比较仍按实例平台绝对路径 |
| core/text-files | **整读13份手写TS**及合同 | GB18030等宽前像核对已独立根修；保留提交后真实结果与文件句柄收尾 |
| core/path-rules | **整读15份手写TS**及合同 | 本轮无新缺陷；Git非null结论为权威、null才本地规则，派生匹配器缓存不成为规则权威，产品glob与Git语义不混并 |
| images | **整读14份手写TS**及合同 | 本轮无新缺陷；保留locate权限/realpath权威、整批先校验、原字节重试与独占临时资源收尾，取消在图片间生效 |
| web | **整读17份手写TS**及合同 | 本轮无新缺陷；每次尝试独占page，晚到页面仍关闭，取消保留原原因，Google并发gate先占位；页面时间与已保存正文状态分开 |
| script | **整读49份手写TS（含1声明引用）**，另1生成surface | 本轮无新缺陷；保留原生Node与显式合同检查差异、单次调用身份/账/停表、真实进程收束后释放租约，原值与展示预算分开 |
| agent-lab | **整读46份手写TS（含1声明引用）+1 CLI**及合同 | 原子注册及不可变归档首次发布已分别根修，精确字节幂等/冲突条件已核消费约束。保留原生态驱动与归档/测量分工、完整唯一leg覆盖与缺项/丢失事实、真实任务HTML隐私闭集 |
| act/bridge | **整读9份手写TS**及合同 | finally撤销失败与主错已共同保留；严格信封、双身份租约、先登记后发送与完整结束/JSON校验不变 |
| act/agents | **整读16份手写TS**及生成面/3模板 | 本轮无新缺陷；parent来自真实调用身份，waitAny先全核归属，runSignal与call signal各管运行/等待，子运行own数据不扩大 |
| act/search | **整读13份手写TS**及生成面/2模板 | 本轮无新缺陷；候选与已读证据分开，每轮核权/发布前复核、CAS激活身份与逐项清理聚合均保留 |
| kernel | **整读115份手写TS（含1声明引用），18953行**及手写schema | 启动关闭取消、旧信任晚到回放、Launcher并发点火三个owner候选独立根修中。内部并发replace另记具体边界，不冒充公开调用路径；保留默认拒绝、逐权限核验、真实处理器收束与同信任重连回放 |
| model | **整读85份手写TS（含1声明引用），11123行**及合同 | UserJs导出/临时槽在VM墙外触发用户代码，有限根修中，保留named/default/getter/Proxy合法导出。其余保留对象图隔离、目录缓存waiter代次、真实usage/校准分开及continuation/SSE完整结束核对 |
| act/system | **整读42份手写TS**，另对照生成面/13模板 | 本轮无新确认缺陷；装配身份按真实调用取，Store授权/消费者身份、材料键命名空间与CAS引用保留，正式OperationRuntime输入递归复制冻结，不机械为不可达别名添第二层；整理原文页只在接受后确认、暂存校验后单次CAS，环境候选/租约/实际发布事实分开 |
| skills | **整读15份手写TS**及资源合同 | 本轮无新缺陷；保留暂存发布/收据、锁内重读、固定代次租约与逐次assertGranted；第三方provider沿受控Node和父Kernel身份模式，未重复改已绿收尾链 |
| project | G5切片读取中，清单201份生产TS | 已读71，余语言/插件/registry/其余utils与types/入口；已确认端口跨授权await原options及证据authorize吞未知IO两候选，独立根修中 |
| sandbox | **整读16份手写TS**，另对照生成面/模板 | 审批后原command可变已根修；保留全量差量指纹、源前像/镜像版本复核、首提交后真实收敛与partial路径结果、失败进程owner重试 |
| browser | 本轮未整读 | G6 |
| computer | G6只读整读中，19份手写TS清单（另1生成面） | 当前已读README/invariants与注入面；原生runtime资产另列，不把TS清单当完整覆盖 |
| office | 本轮未整读 | G6 |

G1为features/sessions/memory，G2为Core三底层单元/images/web。随后按G3→G6补整读，G7只补前四模块未覆盖职责；每组有明确终点，发现实质缺陷再按所属模块独立修复/提交，无问题记录具体保留理由，不以改动数量为目标。Core包其余基础原语不在上述治理26单元中；本轮尚未整体通读，另行列边界，不假记整读。

当前整读18个治理模块、507份手写生产TS（含4份ambient引用）及1个CLI；4个模块只声明具体链路覆盖，Project/Browser/Computer/Office四个尚未整读。Windows打开规格已形成有限ShellExecute设计并向协调报实际消费/合法用途/行为差量，不以简单拒绝字符收窄合同，也不永久挂“以后设计”。
