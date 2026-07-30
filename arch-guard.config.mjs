import { defineConfig, definePlugin } from '@velaros-ai/arch-guard'
import {
  codeStyleChecks,
  createCodeStyleDefaults,
} from '@velaros-ai/arch-guard/checks/code-style'

/**
 * VelarOS Platform 仓库的 arch-guard 配置入口。
 *
 * **只装公开包的 `code-style/*` 语言级规则集**（37 条）——判据与 Desktop 同源、单一实现，
 * 见 Desktop `docs/code-standard.md` 附录 A。识别产品概念的 `velaros/*` 架构族住在 Desktop 私有
 * 插件里，不属于本仓；本仓各域的架构门是自持的 `check:*-arch` 脚本（见 docs/gate-coverage-matrix.md）。
 *
 * **存量策略**：接门当天的存量一次冻结进 `.arch-guard/baseline.json`（棘轮：只减不增），
 * 新增违规即红。修掉存量后跑 `bun run check:code-style:baseline` 收缩基线。
 *
 * **依赖现状(临时)**：`devDependencies` 里的 `@velaros-ai/arch-guard` 暂指 `file:../VelarOS-Arch-Guard`
 * ——含 `checks/code-style` 入口的 **0.2.0 尚未发版**（npm / GH Packages 上只有 0.1.x）。
 * 主控发布 0.2.0 后改回 `"^0.2.0"`，这条 sibling 路径依赖即可拆除。
 *
 * 常用命令：
 *   bun run check:code-style            # 门（compact 一行结论，CI / agent 友好）
 *   bun run check:code-style:report     # 逐条列出违规
 *   bun run check:code-style:fix        # 尝试自动修复（改盘，慎用）
 *   bun run check:code-style:baseline   # 重新冻结存量
 */

/**
 * 本仓的扫描面坐标：规则本体与仓库无关，「扫哪些目录、豁免哪些文件」在这里一次声明，
 * 由 plugin defaults 扇出到全部 37 条规则。
 */
const platformCodeStyle = definePlugin({
  name: 'velaros-platform-code-style',
  checks: codeStyleChecks,
  defaults: createCodeStyleDefaults({
    scope: {
      scanRoots: ['packages'],
      // 全部包的 src 都算运行时业务代码；非 src 目录已被下面的 excludePatterns 挡掉。
      runtimeRoots: ['packages/'],
      // React 面：JSX 类规则只扫这里。
      frontendRoots: ['packages/ui/src/', 'packages/html-artifacts/src/'],
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
    },
  }),
})

export default defineConfig({
  plugins: [platformCodeStyle],
  rules: {
    // 团队语言门：默认 warning 拦不住新增，本仓钉成 error——存量已冻结进基线，新增即红。
    // 公开 API JSDoc 由规则自身分档豁免（见 Desktop docs/code-standard.md §5.1）。
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
