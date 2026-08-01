#!/usr/bin/env node
// 平台代一致性门:仓根声明的 velaros.platform 必须与每个已声明发布包 manifest 里的一致。
//
// 为什么单独有个入口:判据本身住在 releaseTopology 的不变量④(发布路径上自动生效),但发布
// 只在 tag 上跑——新包漏写 platform 会一路绿到打 tag 那天才炸。挂进 check:gates 让它在
// 日常门里就红,而不是攒到不可逆的那一步。
//
// 它不做别的:版本号是各包自己的事(独立 semver),这里只管「同一代」这一个承诺。
import { resolve } from 'node:path'

import { collectReleasePackages } from './releaseTopology.mjs'

const { platformGeneration, ordered } = await collectReleasePackages(
  resolve(import.meta.dirname, '../..'),
)

console.info(`[platform-generation] 通过。${ordered.length} 个已声明发布包同属平台代 ${platformGeneration}。`)
