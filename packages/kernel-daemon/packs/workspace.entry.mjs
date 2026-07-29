import { importSibling, resolvePackagesRoot } from './pack-resolve.mjs'

const packagesRoot = resolvePackagesRoot(import.meta.url)
const workspaceMod = await importSibling(
  packagesRoot,
  'workspace/dist/index.js',
)

const root = process.env.VELAROS_WORKSPACE_ROOT?.trim() || process.cwd()

/** Cold-start workspace module owned by the Kernel process. */
export default workspaceMod.createWorkspaceKernelModule({
  workspace: { root },
})
