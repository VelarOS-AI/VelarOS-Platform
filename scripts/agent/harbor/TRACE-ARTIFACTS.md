# 无损轨迹产物

v2 `traces.json` 和每条 `trace-progress.jsonl` 记录使用 `{ "artifactSchema": 2, "data": <原记录> }`。只替换根/支线 turn 的 `invocations` 数组成员；输入参数、stdout、模型内容里的同名字段保持普通数据。

数组成员变为 `{ sessionId, id, sha256 }`。同目录固定文件 `trace-invocations.jsonl` 保存实体：`{ schema: 1, sessionId, id, sha256, json }`；`json` 是整个原 invocation 的 JSON 字符串，`sha256` 是该字符串 UTF-8 字节的 SHA-256。身份包含 session，内容版本由 hash 区分。pending、settled、其他字段变化各自形成版本；重复引用相同版本不重写正文。实体先落盘，再写引用它的 checkpoint。

调用正文及 summary 全字段保留。写入器只缓存固定 body/summary.input/summary.output 的小指纹和引用，不驻留历史大正文；原始内容不裁剪。RuntimeTrace 的关联查询合同保持原样。

进度 checkpoint 仍重新查询未结束的执行，但只写入内容发生变化的 turn；指纹身份包含 session 与 turn。每条 checkpoint 继续携带当前完整分支绑定，读取器合并各 turn 的最近版本。结束时仍从运行时重新读取并生成完整快照。进度读取按完整行流式处理，可读取总长度超过 JavaScript 单字符串容量的日志；其内存仍需要容纳单条记录与最终恢复视图。

新进度文件为 `trace-progress.jsonl.gz`，每个 checkpoint 以独立 gzip member 有界追加，内部仍是同一 v2 JSONL 记录。状态文件的 `traceProgress.path/encoding` 指示实际位置；读取入口同时兼容旧 `.jsonl`。读取被中断的最后一个 gzip member 时保留此前完整记录并标记 `incompleteTail`；CRC 校验错误和完整非法 JSON 继续报错。最终轨迹与费用账本的语义不变。

读取入口：

- JS `readTraceArtifact(path)`：读取最终产物，返回与旧格式相同的对象；`readTraceProgress(path)`：恢复 provisional 增量视图。
- JS `visitTraceArtifact(path, visit, {projectInvocation})`：v3 逐 turn 校验和访问，主线在前、支线按清单顺序访问，回调带 `branchIndex`（主线为 null）。调用实体逐行验证哈希后才投影，投影必须保留身份；统计可只保留摘要索引，避免驻留全部历史正文。内存仍受最大单条实体、最大 turn 和索引规模影响；v2/旧内联产物仍须解析其完整文件。
- Python `read_trace_artifact(path)`：供 installed agent 和 metrics 使用。report、工具分层统计及 ATIF 接收还原后的完整字段。
- 无 `artifactSchema` 的旧原始文件直接读取。旧 progress 的 schema 1 记录继续可恢复。

缺失实体、hash 不匹配、跨 session 引用、未知 schema、完整非法 JSON 行均明确失败。运行中允许实体仓和 progress 各自有一条未写完的尾行；只恢复此前完整行，任何已完成 checkpoint 引用缺失实体仍失败。最终读取不接受未完成实体尾行。

复制或归档 v2 轨迹时必须把同目录实体仓一并保留。`trajectory.json` 继续使用原 ATIF 完整格式。准备候选会将 `trace-artifact.mjs` 与其他 runner 文件一起复制、计入 fingerprint 和 bundle seal；Python `trace_artifact.py` 纳入冻结 harness。

54c 原轨迹离线交错回放（全部 progress、final trace 和 ATIF；不含未变化的 RuntimeTrace RPC）：累计写入 328.89 MB → 52.49 MB；两次导出耗时 raw 2.117/2.207 s、v2 1.577/1.622 s；逐字段还原相同。这仅证明局部导出与读取收益，不是端到端任务加速结论。原始历史文件保留，后续新候选采用新格式。

L14 实际长任务的固定进度副本含 143 条 checkpoint。通过当前 exporter 离线回放，进度写入 2,337,562,956 → 1,300,596,334 字节，减少 44.36%；恢复后的 143 个主 turn、59 个分支 turn 的逐项完整内容哈希，以及全部分支绑定一致。流式读取回放日志耗时 4.126 秒。记录见 `trace-size-diagnostic-v60/replay-result-02.json`；该测量只涵盖轨迹记录和读取，运行中的冻结候选及原始证据保持原样。

最终 `traces.json` 使用 v3 清单：各 turn 替换为 `{sessionId,id,sha256}`，完整 JSON 存在同目录 `trace-turns/<sha256>.json`。写入全部正文后才原子发布清单；读取时逐文件校验 SHA-256、会话与 turn 身份，再按 v2 规则恢复 invocation。相同内容可复用，冲突内容、缺失正文和身份不符均失败。JS、Python 读取器及证据索引同时支持 v3，复制时须保留整个 `trace-turns` 目录与 invocation 仓。进度日志继续使用 v2，旧最终产物仍可读取。

完整 ATIF 按 JSON 片段有界写入，原子替换快照，避免最终合并为一个超长字符串。单个字符串和单个 turn 仍受 JavaScript 字符串容量约束。L14 原数据库的独立副本已恢复 149 个主 turn 和 60 个分支 turn，全部完整字段哈希一致，写出 793,433,596 字节；原始数据库 SHA-256 未变化。原控制器导出失败和 waiting 终态保留，恢复只补齐评估证据，不建立任务通过结论。
