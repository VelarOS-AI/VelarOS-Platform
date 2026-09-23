// 域：模块清单的克隆与冻结。
import type { KernelModuleManifest } from '../../types/kernel.js'

/** 深冻结一份模块清单的副本，之后模块再改自己那份也影响不到宿主记下的这份。 */
export function cloneManifest(manifest: KernelModuleManifest): KernelModuleManifest {
  return Object.freeze({
    ...manifest,
    provides: Object.freeze(
      manifest.provides.map((capability) =>
        Object.freeze({ id: capability.id, version: capability.version })
      )
    ),
    requires: Object.freeze(
      manifest.requires.map((requirement) => Object.freeze({ ...requirement }))
    ),
    optionalRequires: Object.freeze(
      manifest.optionalRequires.map((requirement) => Object.freeze({ ...requirement }))
    ),
    permissions: Object.freeze([...manifest.permissions]),
  })
}
