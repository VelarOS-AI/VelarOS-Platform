import { importSibling, resolvePackagesRoot } from './pack-resolve.mjs'

const packagesRoot = resolvePackagesRoot(import.meta.url)
const systemMod = await importSibling(
  packagesRoot,
  'VelarOS-Capabilities/packages/system-tools/dist/index.js',
)

export default systemMod.createSystemToolsKernelModule({})
