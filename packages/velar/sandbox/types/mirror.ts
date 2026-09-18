/**
 * 本机演练沙箱引擎的工作类型：镜像清单与文件印记、落回时的冲突、登记表里的一项。只在单元内用，不出包。
 */

import type { ConfinedShellRunnerApi } from '@velaros-ai/velar/shell'

import type { SandboxRecord } from './rehearsal-sandbox.js'

/** 镜像里一个文件的印记：大小、修改时间、权限位；符号链接记它指向哪。 */
export interface SandboxFileStamp {
  size: number
  mtimeMs: number
  mode: number
  link?: string
}

/** 遍历一棵树得到的印记表：相对 posix 路径 → 印记。 */
export type SandboxStampTable = Record<string, SandboxFileStamp>

/**
 * 镜像清单，落在沙箱目录旁的 manifest.json，内核重启后仍能用。
 * files 是创建时源目录里每个文件的印记（落回前核对源目录有没有变过），mirror 是刚复制完镜像里每个条目的印记（算镜像相对创建时的变化）；两边修改时间不同，所以分两张表。
 */
export interface SandboxManifest {
  version: 1
  record: SandboxRecord
  files: SandboxStampTable
  mirror: SandboxStampTable
}

/** 落回时的一处冲突：源目录里这个文件自镜像以来被改过、丢了、凭空出现了，或者它的上级路径是符号链接（落回会写到源目录外）。 */
export interface SandboxConflict {
  path: string
  reason: 'changed' | 'missing' | 'appeared' | 'link'
  message: string
}

/** 登记表里的一项：沙箱记录、清单所在目录和专属的受约束执行器。 */
export interface LocalSandboxEntry {
  /** 沙箱记录。 */
  record: SandboxRecord
  /** 沙箱目录（清单、镜像根、沙箱自己的临时目录都在里面）。 */
  directory: string
  /** 专属的受约束执行器，约束钉在镜像根。 */
  runner: ConfinedShellRunnerApi
}
