# 无损轨迹产物 v2

`traces.json` 和每条 `trace-progress.jsonl` 记录使用 `{ "artifactSchema": 2, "data": <原记录> }`。只替换根/支线 turn 的 `invocations` 数组成员；输入参数、stdout、模型内容里的同名字段保持普通数据。

数组成员变为 `{ sessionId, id, sha256 }`。同目录固定文件 `trace-invocations.jsonl` 保存实体：`{ schema: 1, sessionId, id, sha256, json }`；`json` 是整个原 invocation 的 JSON 字符串，`sha256` 是该字符串 UTF-8 字节的 SHA-256。身份包含 session，内容版本由 hash 区分。pending、settled、其他字段变化各自形成版本；重复引用相同版本不重写正文。实体先落盘，再写引用它的 checkpoint。

调用正文及 summary 全字段保留。写入器只缓存固定 body/summary.input/summary.output 的小指纹和引用，不驻留历史大正文；原始内容不裁剪。RuntimeTrace 的关联查询合同保持原样。

读取入口：

- JS `readTraceArtifact(path)`：读取最终产物，返回与旧格式相同的对象；`readTraceProgress(path)`：恢复 provisional 增量视图。
- Python `read_trace_artifact(path)`：供 installed agent 和 metrics 使用。report、工具分层统计及 ATIF 接收还原后的完整字段。
- 无 `artifactSchema` 的旧原始文件直接读取。旧 progress 的 schema 1 记录继续可恢复。

缺失实体、hash 不匹配、跨 session 引用、未知 schema、完整非法 JSON 行均明确失败。运行中允许实体仓和 progress 各自有一条未写完的尾行；只恢复此前完整行，任何已完成 checkpoint 引用缺失实体仍失败。最终读取不接受未完成实体尾行。

复制或归档 v2 轨迹时必须把同目录实体仓一并保留。`trajectory.json` 继续使用原 ATIF 完整格式。准备候选会将 `trace-artifact.mjs` 与其他 runner 文件一起复制、计入 fingerprint 和 bundle seal；Python `trace_artifact.py` 纳入冻结 harness。

54c 原轨迹离线交错回放（全部 progress、final trace 和 ATIF；不含未变化的 RuntimeTrace RPC）：累计写入 328.89 MB → 52.49 MB；两次导出耗时 raw 2.117/2.207 s、v2 1.577/1.622 s；逐字段还原相同。这仅证明局部导出与读取收益，不是端到端任务加速结论。原始历史文件保留，后续新候选采用新格式。
