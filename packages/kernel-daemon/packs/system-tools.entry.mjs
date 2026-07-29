import { importSibling, resolvePackagesRoot } from './pack-resolve.mjs'

const packagesRoot = resolvePackagesRoot(import.meta.url)
const systemMod = await importSibling(
  packagesRoot,
  'system-tools/dist/index.js',
)

export default systemMod.createSystemToolsKernelModule({})
