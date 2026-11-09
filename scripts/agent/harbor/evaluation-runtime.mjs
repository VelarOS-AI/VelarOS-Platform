import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'

// 评测宿主显式冻结与原工作负载相同的模型工具预算；不是基础 Runtime 的默认能力。
const searchProfile = Object.freeze({
  modelCalls: 24,
  modelTokens: 1_000_000,
  finalizationTokens: 65_536,
  timeoutMs: 1_200_000,
  callTimeoutMs: 120_000,
  finalizationMs: 90_000,
  outputTokens: 8_192,
  projectionChars: 48_000,
  sourceQueries: 128,
  candidates: 256,
  readBytes: 2_000_000,
})

// 显式解析评测冻结的模型配置，让主线与子任务、搜索共享同一真实驱动。
export function evaluationModel(model, modelPackage) {
  if (typeof model.stream === 'function') return model
  assert(model.limits, 'Evaluation model configuration must freeze its token limits')
  const composition = modelPackage.createModelRuntimeComposition({
    environment: {},
    providerScripts: { configPaths: [] },
  })
  const factory = composition.modelAdapterRegistry.createLanguageModelFactory(model)
  return modelPackage.createAiSdkModelDriver({
    id: `${model.provider}/${model.model}`,
    model: factory(model.model),
    limits: model.limits,
  })
}

// 评测任务自己选择项目、代码、图像、搜索与子任务；只复用候选提供的公共工厂。
export async function evaluationCapabilities({
  projectPackage,
  imagePackage,
  root,
  stateDirectory,
  model,
  project = false,
  code = false,
  images = false,
  agents = false,
  search = false,
}) {
  const modules = [],
    sources = [],
    snapshots = []
  if (project || code || images) {
    const actual = await realpath(root)
    const kernel = await projectPackage.createProjectKernel({
      root: actual,
      transactionStatePath: join(
        stateDirectory,
        'projects',
        createHash('sha256').update(actual).digest('hex'),
        'transactions.json'
      ),
    })
    const noGraph = { isAvailable: () => false, query: async () => ({}) }
    const port = {
      getRootPath: () => actual,
      kernel: async () => kernel,
      queryCode: projectPackage.createProjectCodeQuery(
        typeof code === 'object' ? code : noGraph,
        code ? undefined : []
      ),
    }
    if (project) {
      modules.push(
        projectPackage.createProjectCapabilityModule({ instanceId: actual, project: port })
      )
      sources.push(projectPackage.createProjectContextSource({ id: 'project', kernel }))
      snapshots.push(projectPackage.createProjectObservationProvider())
    }
    if (code)
      modules.push(projectPackage.createProjectCodeModule({ instanceId: actual, project: port }))
    if (images)
      modules.push(
        projectPackage.createProjectImagesModule({
          instanceId: actual,
          project: port,
          resizeImage: imagePackage.createLocalImagePort({ resolvePath: (path) => path })
            .resizeImage,
        })
      )
  }
  assert(
    !search || (model && sources.length),
    'Evaluation search requires its model and project evidence'
  )
  assert(!agents || model, 'Evaluation workers require a resolved model')
  return {
    modules,
    context: { sources, snapshots },
    ...(search
      ? {
          search: {
            model,
            profiles: {
              standard: {
                ...searchProfile,
                outputTokens: Math.min(searchProfile.outputTokens, model.limits.outputTokens),
              },
            },
            defaultProfile: 'standard',
          },
        }
      : {}),
    ...(agents
      ? {
          agents: {
            profiles: {
              worker: {
                model,
                node: true,
                modules: [
                  ...modules.map((module) => module.binding.moduleId),
                  ...(search ? ['velaros:search'] : []),
                ],
              },
            },
            concurrency: 4,
            maxChildren: 256,
          },
        }
      : {}),
  }
}
