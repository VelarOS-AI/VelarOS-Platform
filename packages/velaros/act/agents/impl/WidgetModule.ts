import type { OperationModuleDefinition } from '@velaros-ai/kernel'

import { VelarosRuntimeContract } from '../../runtime/contract/constants.js'
import { capabilityModules } from '../../runtime/impl/CapabilityModules.js'
import type { WidgetHost } from '../contract/requires.js'
import { VelarWidgetModule } from '../contract/surface.js'

import { widgetOperations } from './WidgetOperations.js'

/** 在对话里给用户显示小部件，交给宿主显示。 */
export interface WidgetModuleApi {
  /** 注入宿主端口，装配到共享 Kernel。 */
  create(host: WidgetHost): OperationModuleDefinition
}

class WidgetModule implements WidgetModuleApi {
  public create(host: WidgetHost): OperationModuleDefinition {
    return capabilityModules.create({
      surface: VelarWidgetModule,
      implementation: widgetOperations,
      instanceId: 'standard:widget',
      generation: VelarosRuntimeContract.generation,
      summary: '在对话里给用户显示小部件（图表、示意图、可交互的小工具）',
      context: (call) => ({
        show: async (widget) => {
          await host.show(widget, call.invocation.sessionId)
        },
        invocationId: call.invocation.id,
        abortSignal: call.signal,
      }),
    })
  }
}

/** 注入端口之后接入唯一调用链。 */
export const widgetModule: WidgetModuleApi = new WidgetModule()
