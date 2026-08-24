import { describe, expect, test } from 'bun:test'

import {
  ExternalAgentBridgeCommandQueue,
  ExternalAgentBridgeEventWindow,
  ExternalAgentBridgePairingThrottle,
  externalAgentBridgeTokensEqual,
  isExternalAgentBridgeExtensionOrigin,
} from '../src/bridge'

describe('External Agent Bridge shared state', () => {
  test('bounds command replay and validates acknowledgements', () => {
    const queue = new ExternalAgentBridgeCommandQueue<'update'>(2)
    queue.enqueue('update', { value: 1 })
    queue.enqueue('update', { value: 2 })
    queue.enqueue('update', { value: 3 })
    expect(queue.sequence).toBe(3)
    expect(queue.after(0).map((command) => command.sequence)).toEqual([2, 3])
    queue.acknowledge(2)
    expect(queue.after(0).map((command) => command.sequence)).toEqual([3])
    expect(() => queue.acknowledge(4)).toThrow('out of range')
  })

  test('deduplicates a bounded event window', () => {
    const window = new ExternalAgentBridgeEventWindow(2)
    expect(window.accept('a')).toBe(true)
    expect(window.accept('a')).toBe(false)
    expect(window.accept('b')).toBe(true)
    expect(window.accept('c')).toBe(true)
    expect(window.accept('a')).toBe(true)
  })

  test('blocks repeated pairing failures and resets explicitly', () => {
    let now = 1_000
    const throttle = new ExternalAgentBridgePairingThrottle(() => now)
    for (let attempt = 0; attempt < 5; attempt += 1) throttle.reject()
    expect(throttle.isBlocked).toBe(true)
    now = throttle.blockedUntil
    expect(throttle.isBlocked).toBe(false)
    throttle.reset()
    expect(throttle.blockedUntil).toBe(0)
  })

  test('uses strict extension origins and timing-safe token equality', () => {
    expect(isExternalAgentBridgeExtensionOrigin(`chrome-extension://${'a'.repeat(32)}`)).toBe(true)
    expect(isExternalAgentBridgeExtensionOrigin('https://example.test')).toBe(false)
    expect(externalAgentBridgeTokensEqual('secret', 'secret')).toBe(true)
    expect(externalAgentBridgeTokensEqual('secret', 'different')).toBe(false)
  })
})
