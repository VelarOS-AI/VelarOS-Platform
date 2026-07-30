import {
  type AgentToolSpec,
  executeWorkspaceCommitEdit,
  executeWorkspaceRead,
  executeWorkspaceRunBatch,
} from './agent-tools.js'
import { WorkspaceConcepts as C, WorkspaceInspectEvidenceProtocol } from './tool-concepts.js'
import { defineWorkspaceTool } from './tool-factory.js'
import {
  amendEditInputSchema,
  applyEditInputSchema,
  buildEvidenceInputSchema,
  commitEditInputSchema,
  diffInputSchema,
  listFilesInputSchema,
  prepareEditInputSchema,
  readInputSchema,
  resolveTargetInputSchema,
  rollbackInputSchema,
  runBatchInputSchema,
  searchInputSchema,
  statInputSchema,
  statusInputSchema,
  symbolsInputSchema,
  validateInputSchema,
} from './tool-schemas.js'
import { WorkspaceKernelToolNames as wsTool } from './workspace-tool-names.js'

/** 面向 Agent/MCP 暴露的 workspace 工具定义；描述文本统一面向模型阅读。 */
const WorkspaceAgentToolSpecs: AgentToolSpec[] = [
  defineWorkspaceTool({
    name: wsTool.status,
    role: 'inspect',
    summary: '返回工作区内核状态摘要。',
    suitable: ['需要查看插件、校验器、锁、目标与事务计数。'],
    forbidden: ['不要用它读取文件内容。', '不要用它判断未注册外部进程状态。'],
    usage: ['无需参数，直接调用。'],
    examples: [{}],
    notes: ['结果是内核视角的快照，不替代 git status。'],
    schema: statusInputSchema,
    execute: (workspace) => workspace.status(),
  }),
  defineWorkspaceTool({
    name: wsTool.read,
    role: 'inspect',
    summary: '读取已定位文件内容并附带 snapshot.revision。',
    suitable: ['需要读取已定位文件的有界正文窗口。', '编辑前需要取得最新 revision。'],
    forbidden: ['不要用于路径发现或正文搜索。', '不要默认无界读取整文件。'],
    usage: [C.boundedRead, '读取单文件传 path: "..."，读取多个文件传 path: ["...", "..."]。'],
    examples: [
      // 单文件按行范围读
      { path: 'src/app.ts', range: { startLine: 1, endLine: 120 }, maxBytes: 40000 },
      // 一次读多个文件（path 传数组）
      { path: ['src/a.ts', 'src/b.ts'], maxBytes: 20000 },
      // 读较小整文件：不传 range，用 maxChars/maxBytes 兜住预算
      { path: 'src/config.ts', maxChars: 8000 },
      // 读尾部：只给 startLine（不给 endLine）= 从该行读到文件末尾
      { path: 'src/app.ts', range: { startLine: 400 }, maxBytes: 20000 },
    ],
    notes: ['结果统一返回 { count, files }，files 内每项是单文件 read 结果。', C.revisionGuard],
    schema: readInputSchema,
    execute: executeWorkspaceRead,
  }),
  defineWorkspaceTool({
    name: wsTool.stat,
    role: 'inspect',
    summary: '获取单个路径的轻量元数据。',
    suitable: ['未知文件大小、类型、行数或 revision 时先检查。'],
    forbidden: ['不要用它获取正文。', '不要用它做正文搜索。'],
    usage: ['传相对 path；有 recommendedRead 时作为后续 read 的起点。'],
    examples: [{ path: 'src/app.ts' }],
    notes: ['行数只在成本较低时返回。'],
    schema: statInputSchema,
    execute: (workspace, input) => workspace.stat(input),
  }),
  defineWorkspaceTool({
    name: wsTool.listFiles,
    role: 'inspect',
    summary: '列目录或按文件名、目录名与 glob 发现路径。',
    suitable: ['需要按文件名、目录名、glob 或扩展名发现路径。'],
    forbidden: ['不要用它搜索文件正文。', '不要递归遍历时省略限制。'],
    usage: ['用 path、recursive、maxDepth、maxFiles 和 include/exclude 控制范围。'],
    examples: [
        // 按 glob 递归找（如所有测试文件）：递归必须给 maxDepth + maxFiles
        { path: 'src', include: ['**/*.test.ts'], recursive: true, maxDepth: 4, maxFiles: 50 },
        // 只列某目录一层（不递归）
        { path: 'src', maxFiles: 50 },
        // 按扩展名找（用 glob 表达）
        { path: '.', include: ['**/*.ts', '**/*.tsx'], recursive: true, maxDepth: 6, maxFiles: 100 },
        // 递归但排除常见噪音目录
        {
          path: '.',
          include: ['**/*.js'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          recursive: true,
          maxDepth: 5,
          maxFiles: 80,
        },
      ],
    notes: [C.pathDiscovery],
    schema: listFilesInputSchema,
    execute: (workspace, input) => workspace.listFiles(input),
  }),
  defineWorkspaceTool({
    name: wsTool.search,
    role: 'inspect',
    summary: '在文件正文内搜索字面量或正则。',
    suitable: ['需要定位真实出现在文件内容里的字符串、符号片段或正则。'],
    forbidden: ['不要用路径片段当正文查询。', '不要在整仓库运行过宽正则。'],
    usage: ['用 query 搜正文，并用 root/include/exclude/maxResults 收窄候选。'],
    examples: [
        // 字面量搜索，限定目录与文件类型
        { query: 'function normalizePath', root: 'src', include: ['**/*.ts'], maxResults: 20 },
        // 正则搜索：regex:true，query 是正则字符串
        {
          query: 'export\\s+(async\\s+)?function\\s+\\w+',
          regex: true,
          root: 'src',
          include: ['**/*.ts'],
          maxResults: 30,
        },
        // 区分大小写
        { query: 'TODO', caseSensitive: true, maxResults: 50 },
        // 全仓搜但排除测试文件
        { query: 'import', root: '.', exclude: ['**/*.test.ts'], maxResults: 40 },
      ],
    notes: [C.pathDiscovery],
    schema: searchInputSchema,
    execute: (workspace, input) => workspace.search(input),
  }),
  defineWorkspaceTool({
    name: wsTool.symbols,
    role: 'inspect',
    summary: '列出单文件中由适配器抽取的符号列表。',
    suitable: ['需要按函数、类、变量或类型名定位目标。'],
    forbidden: ['不要用它跨文件搜索正文。', '无符号适配器时改用正文搜索或有界读取。'],
    usage: ['传相对 path，根据返回 name/kind/container 继续解析稳定目标。'],
    examples: [{ path: 'src/config.ts' }],
    notes: ['返回质量取决于当前语言适配器。'],
    schema: symbolsInputSchema,
    execute: (workspace, input: { path: string }) => workspace.listSymbols(input.path),
  }),
  defineWorkspaceTool({
    name: wsTool.resolveTarget,
    role: 'inspect',
    summary: '将用户或模型给出的目标解析为带版本的 targetId；编辑应优先用 targetId 而非裸行号。',
    suitable: ['需要把符号、文本锚点或行范围变成稳定目标。'],
    forbidden: ['不要用它发现文件路径或搜索正文全集。', '不要沿用旧 revision 的 targetId。'],
    usage: ['传 path 和 target；expectedMatches 可要求唯一匹配。'],
    examples: [
        {
          path: 'src/workspace.ts',
          target: { symbol: { name: 'runWithLease' } },
          expectedMatches: 1,
        },
      ],
    notes: [C.targetIdBindsRevision],
    schema: resolveTargetInputSchema,
    execute: (workspace, input) => workspace.resolveTarget(input),
  }),
  defineWorkspaceTool({
    name: wsTool.buildEvidence,
    role: 'inspect',
    summary: '生成紧凑且可追溯的 EvidencePack。',
    suitable: ['复杂补丁、综合回答或编辑前需要紧凑且可追溯的证据包。'],
    forbidden: ['不要把它当完整文件读取。', '不要用过宽范围制造低信号 EvidencePack。'],
    protocol: WorkspaceInspectEvidenceProtocol,
    usage: ['优先传 targetId；没有 targetId 时传 path+range 和 include.currentWindow。'],
    examples: [
        {
          target: { targetId: 'target_123' },
          include: { currentWindow: true, windowLinesBefore: 8, windowLinesAfter: 8 },
        },
      ],
    notes: ['EvidencePack 应来自已定位的目标或有界范围。'],
    schema: buildEvidenceInputSchema,
    execute: (workspace, input) => workspace.buildEvidencePack(input),
  }),
  defineWorkspaceTool({
    name: wsTool.prepareEdit,
    role: 'edit',
    summary: '准备编辑事务并返回预览 diff。',
    suitable: ['需要先审阅补丁再决定是否写盘。', '需要生成 transactionId 供后续校验或应用。'],
    forbidden: ['不要把它当成实际写盘操作。', '不要在无证据的情况下准备高风险修改。'],
    usage: ['operations 每项使用 { operation } 或 { targetId, operation }。'],
    examples: [
        {
          operations: [
            {
              operation: {
                type: 'replace_text',
                path: 'src/auth.ts',
                oldText: 'return false',
                newText: 'return true',
              },
            },
          ],
        },
      ],
    notes: [C.pathInOperation, C.preferTargetId],
    schema: prepareEditInputSchema,
    execute: (workspace, input) => workspace.prepareEdit(input),
  }),
  defineWorkspaceTool({
    name: wsTool.amendEdit,
    role: 'edit',
    summary: '修补已准备的编辑事务。',
    suitable: ['预览后发现需要追加局部修改。', '需要在同一个 transactionId 内合并补丁。'],
    forbidden: ['不要用于已经应用或回滚的事务。', '不要用旧文件内容作为 staged overlay 的锚点。'],
    usage: ['传 transactionId 与增量 operations。'],
    examples: [
        {
          transactionId: 'tx_123',
          operations: [
            {
              operation: {
                type: 'add_import',
                path: 'src/app.ts',
                importStatement: "import { foo } from './foo'",
              },
            },
          ],
        },
      ],
    notes: ['oldText 与 anchor 应针对事务暂存后的内容。'],
    schema: amendEditInputSchema,
    execute: (workspace, input) => workspace.amendEdit(input),
  }),
  defineWorkspaceTool({
    name: wsTool.commitEdit,
    role: 'edit',
    summary: '一步准备、校验并按需应用编辑事务。',
    suitable: ['需要快速完成低到中风险补丁。', '希望校验失败时自动避免写盘。'],
    forbidden: [
        '不要用于需要人工审阅大型 diff 的修改。',
        '不要把格式整理检查误当作默认最终验证。',
      ],
    usage: ['传 operations；autoApply 为 false 时只返回校验结果。', C.editLifecycle],
    examples: [
        {
          operations: [
            {
              operation: {
                type: 'replace_text',
                path: 'src/auth.ts',
                oldText: 'return false',
                newText: 'return true',
              },
            },
          ],
          postconditions: [{ type: 'must_contain', value: 'return true' }],
        },
      ],
    notes: ['Prettier/ESLint 默认延后，显式放入 checks 时才运行。', C.postconditionDefault],
    schema: commitEditInputSchema,
    execute: executeWorkspaceCommitEdit,
  }),
  defineWorkspaceTool({
    name: wsTool.applyEdit,
    role: 'edit',
    summary: '应用已准备的编辑事务。',
    suitable: ['已经审阅并确认准备事务的 diff。'],
    forbidden: ['不要应用未知来源或过期事务。', '不要跳过必要校验直接写盘。'],
    usage: ['传已准备事务的 transactionId。'],
    examples: [{ transactionId: 'tx_123' }],
    notes: ['会执行 revision 与锁检查。'],
    schema: applyEditInputSchema,
    execute: (workspace, input) => workspace.applyEdit(input),
  }),
  defineWorkspaceTool({
    name: wsTool.validate,
    role: 'edit',
    summary: '运行工作区注册校验。',
    suitable: ['需要验证暂存事务或指定路径。'],
    forbidden: [
        '不要把未注册的外部命令名称当作内置校验器。',
        '不要把通过校验等同于完整测试套件通过。',
      ],
    usage: ['传 transactionId、paths 或 postconditions。'],
    examples: [
        {
          transactionId: 'tx_123',
          checks: ['core.postcondition'],
          postconditions: [{ type: 'must_contain', value: 'return true' }],
        },
      ],
    notes: [C.validatorsFromStatus],
    schema: validateInputSchema,
    execute: (workspace, input) => workspace.validate(input),
  }),
  defineWorkspaceTool({
    name: wsTool.rollback,
    role: 'edit',
    summary: '回滚已应用的编辑事务。',
    suitable: ['需要撤销先前已应用或已直接提交写入的补丁。'],
    forbidden: ['不要用于尚未应用的事务。', '不要假设它能还原事务之后的人工改动。'],
    usage: ['传已应用事务的 transactionId。'],
    examples: [{ transactionId: 'tx_123' }],
    notes: ['基于事务补丁历史生成逆向修改。'],
    schema: rollbackInputSchema,
    execute: (workspace, input) => workspace.rollback(input),
  }),
  defineWorkspaceTool({
    name: wsTool.diff,
    role: 'inspect',
    summary: '查看事务的统一 diff。',
    suitable: ['需要审阅准备中或已记录事务的补丁内容。'],
    forbidden: ['不要用它读取完整文件。', '不要把 diff 当作最新磁盘快照。'],
    usage: ['传 transactionId；省略时按内核实现返回可用 diff 信息。'],
    examples: [{ transactionId: 'tx_123' }],
    notes: ['diff 反映事务记录，不保证覆盖后续外部改动。'],
    schema: diffInputSchema,
    execute: (workspace, input) => workspace.diff(input),
  }),
  defineWorkspaceTool({
    name: wsTool.runBatch,
    role: 'execute',
    summary: '以有界并发执行工作区任务批次。',
    suitable: ['需要批量读取、搜索、解析、准备、应用或校验。'],
    forbidden: ['不要把互相依赖的任务省略 dependsOn。', '不要用过高并发压测工作区。'],
    usage: ['传 tasks，并用 concurrency、dependsOn、atomic 控制执行。'],
    examples: [
        {
          tasks: [
            { id: 'read-a', op: { kind: 'read', input: { path: 'src/a.ts', maxBytes: 20000 } } },
            {
              id: 'validate-a',
              dependsOn: ['read-a'],
              op: { kind: 'validate', input: { paths: ['src/a.ts'] } },
            },
          ],
          concurrency: 2,
        },
      ],
    notes: ['任务图按 DAG 依赖执行。'],
    schema: runBatchInputSchema,
    execute: executeWorkspaceRunBatch,
  }),
]

export { WorkspaceAgentToolSpecs }
