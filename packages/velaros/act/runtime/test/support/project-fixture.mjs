import { realpath } from 'node:fs/promises'

import { createLocalImagePort } from '../../../../dist/images/local.js'
import {
  createProjectCapabilityModule,
  createProjectCodeModule,
  createProjectCodeQuery,
  createProjectContextSource,
  createProjectImagesModule,
  createProjectKernel,
  createProjectObservationProvider,
  createSkillProjectCodeQuery,
} from '../../../../dist/project/index.js'

/** 测试产品显式选择 Project、代码智能和看图；不会由执行目录推导能力。 */
export async function projectFixture({
  root,
  transactionStatePath,
  codeIndex,
  images = false,
  skills,
  resolveProject,
}) {
  const canonical = await realpath(root)
  const kernel = await createProjectKernel({ root: canonical, transactionStatePath })
  const project = {
    getRootPath: () => canonical,
    kernel: async () => kernel,
    queryCode: codeIndex
      ? skills
        ? createSkillProjectCodeQuery(codeIndex, skills)
        : createProjectCodeQuery(codeIndex)
      : undefined,
  }
  return {
    modules: [
      createProjectCapabilityModule({ instanceId: canonical, project, resolveProject }),
      ...(codeIndex ? [createProjectCodeModule({ instanceId: canonical, project })] : []),
      ...(images
        ? [
            createProjectImagesModule({
              instanceId: canonical,
              project,
              resizeImage: createLocalImagePort({ resolvePath: (path) => path }).resizeImage,
            }),
          ]
        : []),
    ],
    context: {
      sources: [createProjectContextSource({ id: 'project', kernel })],
      snapshots: [createProjectObservationProvider()],
    },
  }
}

/** 测试组合根把显式领域模块与其他来源合并，不覆盖维护和观察策略。 */
export async function withProjectFixture(options, configuration) {
  if (configuration.enabled === false) return options
  const project = await projectFixture(configuration)
  return {
    ...options,
    modules: [...(options.modules ?? []), ...project.modules],
    context: {
      ...options.context,
      sources: [...(options.context?.sources ?? []), ...project.context.sources],
      snapshots: [...(options.context?.snapshots ?? []), ...project.context.snapshots],
    },
  }
}

/** 仅有语言服务、没有项目图谱时的明确测试端口。 */
export const unavailableCodeIndex = Object.freeze({
  isAvailable: () => false,
  query: async () => ({}),
})
