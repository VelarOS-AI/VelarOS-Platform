import {isUndefined} from '@velaros-ai/core'

import type { ProviderRequestFingerprint,ProviderRequestSnapshot } from '../types/compiler.js'

import { shortHash } from './provider-hash.js'
/** 请求指纹同时绑定实际消息、模型、系统指令、响应格式和输出预算。 */
export async function requestFingerprint(input:Pick<ProviderRequestSnapshot,'model'|'system'|'messages'|'responseFormat'|'outputTokens'>):Promise<ProviderRequestFingerprint> {
 const systemHash=await shortHash(input.system); const messageHash=await shortHash(JSON.stringify(input.messages))
 const responseFormatHash=isUndefined(input.responseFormat)?undefined:await shortHash(JSON.stringify(input.responseFormat))
 const prefixHash=await shortHash(JSON.stringify({model:input.model,systemHash,responseFormatHash}))
 return {id:await shortHash(JSON.stringify({prefixHash,messageHash,outputTokens:input.outputTokens})),systemHash,messageHash,prefixHash,responseFormatHash}
}
