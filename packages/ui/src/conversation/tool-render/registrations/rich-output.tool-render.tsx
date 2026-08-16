import { lazy } from 'react'

import type { ToolRenderRegistration } from '../ToolRenderRegistry'
import {
  ArtifactRenderToolNames,
  MemoryRecallRenderToolNames,
  SearchResultRenderToolNames,
  WebReadRenderToolNames,
} from '../toolRenderToolNames'

// PERF GUARD: 注册文件会被 eager 扫描；每种 rich output 都要独立 lazy，不能恢复为一个
// 静态聚合 renderer，否则任意一种结果都会把全部 artifact/search/memory 视图一起加载。
// 不要增加静态聚合 renderer；它会绕过这里的分包边界并让任一结果加载全部 rich output 视图。
const LazyArtifactToolRender = lazy(async () =>
  import('../richOutput/renderers/ArtifactToolRender').then((module) => ({
    default: module.ArtifactToolRender,
  }))
)
const LazyMemoryRecallToolRender = lazy(async () =>
  import('../richOutput/renderers/MemoryRecallToolRender').then((module) => ({
    default: module.MemoryRecallToolRender,
  }))
)
const LazySearchResultToolRender = lazy(async () =>
  import('../richOutput/renderers/SearchResultToolRender').then((module) => ({
    default: module.SearchResultToolRender,
  }))
)
const LazyWebReadToolRender = lazy(async () =>
  import('../richOutput/renderers/WebReadToolRender').then((module) => ({
    default: module.WebReadToolRender,
  }))
)

const registrations: ToolRenderRegistration[] = [
  {
    toolNames: SearchResultRenderToolNames,
    component: LazySearchResultToolRender,
  },
  {
    toolNames: WebReadRenderToolNames,
    component: LazyWebReadToolRender,
  },
  {
    toolNames: ArtifactRenderToolNames,
    component: LazyArtifactToolRender,
  },
  {
    toolNames: MemoryRecallRenderToolNames,
    component: LazyMemoryRecallToolRender,
  },
]

export default registrations
