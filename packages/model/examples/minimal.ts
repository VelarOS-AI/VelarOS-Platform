import {
  ModelRequestClient,
  type ModelRequestLanguageModel,
  type ModelRequestTransport,
} from '@velaros-ai/model'
import {
  DefaultModelRuntimeComposition,
} from '@velaros-ai/model/node'

declare const transport: ModelRequestTransport
declare const model: ModelRequestLanguageModel

const models = new DefaultModelRuntimeComposition({
  providerScripts: {
    configPaths: ['./providers.json'],
    hostBridge: {
      getUserDataPath: () => './data',
      getAppVersion: () => '1.0.0',
      openExternal: async (url) => {
        console.info('open', url)
      },
    },
  },
})

models.velarCloudRuntime.register({
  baseURL: 'https://model-gateway.example.com',
  fetch,
})

const selection = models.providerCollection.resolveModelSelection(
  'openai',
  'gpt-5.5'
)

const client = new ModelRequestClient({ transport })
const text = await client.generateText({
  endpoint: 'my-app.summary',
  model,
  prompt: '请概括这段内容',
})

void selection
void text
