import { defineConfig, definePlugin } from '@velaros-ai/arch-guard'
import {
  codeStyleChecks,
  createCodeStyleDefaults,
} from '@velaros-ai/arch-guard/checks/code-style'

/**
 * VelarOS Platform 仓库的 arch-guard 配置入口。
 *
 * 只安装公开 `code-style/*` 语言级规则集（37 条）。Platform 的领域架构约束由仓内
 * `check:*-arch` 脚本负责，覆盖关系见 `docs/gate-coverage-matrix.md`。
 *
 * **零基线策略**：语言级错误必须在源码中修复；本仓不提交 arch-guard baseline，
 * 也不通过新增豁免掩盖违规。
 *
 * arch-guard 依赖固定到公开 GitHub 仓库的完整提交，确保本地贡献者不需要私有 registry 凭据，
 * 同时避免可变标签改变 CI 判据。
 *
 * 常用命令：
 *   bun run check:code-style            # 门（compact 一行结论，CI / agent 友好）
 *   bun run check:code-style:report     # 逐条列出违规（显式禁用 baseline）
 *   bun run check:code-style:fix        # 尝试自动修复（改盘，慎用）
 */

/**
 * 本仓的扫描面坐标：规则本体与仓库无关，「扫哪些目录、豁免哪些文件」在这里一次声明，
 * 由 plugin defaults 扇出到全部 37 条规则。
 */
const platformCodeStyle = definePlugin({
  name: 'velaros-platform-code-style',
  checks: codeStyleChecks,
  defaults: createCodeStyleDefaults({
    helpers: { module: '@velaros-ai/core' },
    scope: {
      scanRoots: ['packages'],
      // 全部包的 src 都算运行时业务代码；非 src 目录已被下面的 excludePatterns 挡掉。
      runtimeRoots: ['packages/'],
      // React 面：JSX 类规则只扫这里。
      frontendRoots: ['packages/ui/src/', 'packages/html-artifacts/src/'],
      // Agent Lab 是可独立消费的 host-neutral 基础设施包，刻意不依赖 @velaros-ai/core 的
      // 全局守卫 / 缺席值 / Log 扩展；portable library 档仍由 TypeScript、ESLint、包架构门和
      // 自身测试约束，不能套用要求 Core helper 的产品运行时代码风格规则。
      portableLibraryPrefixes: ['packages/agent-lab/'],
      // 语义扩展 / 守卫 / 缺席值 helper 的实现本体不能套用自身 autofix。
      skipPatterns: [
        '^packages/core/src/typeGuards\\.ts$',
        '^packages/core/src/logger/',
        '^packages/core/src/utils/optionalWhen\\.ts$',
        '^packages/core/src/utils/mapDefined\\.ts$',
      ],
    },
    perCheck: {
      'code-style/forbid-raw-timers': {
        allowFiles: ['packages/core/src/utils/TimerScope.ts'],
      },
      'code-style/forbid-console': {
        allowFiles: [
          'packages/ui/src/conversation/internal/runtime.ts',
          'packages/memory/src/files/memory-files-probe.ts',
          'packages/memory/src/vector/memory-vector-probe.ts',
          'packages/memory/src/memory-tree/v2/storage/storage-v2-probe.ts',
        ],
      },
    },
  }),
})

export default defineConfig({
  plugins: [platformCodeStyle],
  rules: {
    // 团队语言门：默认 warning 拦不住新增，本仓钉成 error；源码必须保持零错误。
    // 公开 API JSDoc 由规则自身按文档类型分档豁免。
    'code-style/require-chinese-comments': { severity: 'error' },
  },
  files: {
    // 只覆盖各包源码；dist / test / docs / scripts 由各自的门负责。
    roots: ['packages'],
    extensions: ['.ts', '.tsx'],
    excludePatterns: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/*.d.ts',
      '**/*.generated.*',
      '**/generated/**',
      '**/fixtures/**',
      '**/fixture/**',
      '**/mocks/**',
      '**/test/**',
      '**/tests/**',
      '**/__tests__/**',
      '**/examples/**',
      '**/scripts/**',
      '**/probes/**',
    ],
  },
})
