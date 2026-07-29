import { importSibling, resolvePackagesRoot } from './pack-resolve.mjs'

const packagesRoot = resolvePackagesRoot(import.meta.url)
const computerMod = await importSibling(
  packagesRoot,
  'VelarOS-Capabilities/packages/computer-runtime/dist/index.js',
)

/** Cold-start computer module; owns its sidecar manager by default. */
export default computerMod.createComputerKernelModule({})
