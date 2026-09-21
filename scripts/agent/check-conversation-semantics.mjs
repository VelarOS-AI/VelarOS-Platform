#!/usr/bin/env bun
// 宿主事件投影只发布完整接受的消息，预览和恢复拒绝不变成历史事实。
import assert from 'node:assert/strict'
import {createActEventProjector} from '../../packages/velaros/dist/act/runtime/renderer.js'
import {resolveChatMessageConversationKind} from '../../packages/ui/src/conversation/contracts/conversation.ts'
const view=createActEventProjector()
const push=(sequence,event)=>view.apply({sequence,sessionId:'s',runId:'r',event:{runId:'r',...event}})
push(1,{type:'turn',turnId:'t'});push(2,{type:'text',text:'preview'})
assert.equal(view.snapshot().runs.r.messages.length,0)
push(3,{type:'rejected',turnId:'t',message:'cancelled'});assert.equal(view.snapshot().runs.r.preview,'')
push(4,{type:'accepted',turnId:'t2',text:'accepted',ref:{sessionId:'s',id:'raw'}})
assert.equal(view.snapshot().runs.r.messages.length,1)
assert.equal(resolveChatMessageConversationKind({role:'user',conversationKind:'run-guidance'}),'run-guidance')
assert.equal(resolveChatMessageConversationKind({role:'user',conversationKind:'turn-input'}),'turn-input')
console.log('Act presentation and UI input semantics verified')
