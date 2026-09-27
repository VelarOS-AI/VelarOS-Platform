// 用途：钉住用户脚本匹配规则里的端口。界面新建脚本的默认规则是「当前网址的 origin + /*」，本地开发服务都带端口；
// 老写法拿「主机名:端口」去比不带端口的主机名，带端口的规则一条都匹配不上，脚本永远显示「不匹配」、永远不跑。
import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import { browserUserScriptPatternMatches } from '../../utils/user-scripts.js'

void describe('user script match patterns with ports', () => {
  void test('a port in the pattern has to match the page', () => {
    assert.equal(
      browserUserScriptPatternMatches(
        'http://127.0.0.1:8765/shop/order.html',
        'http://127.0.0.1:8765/*'
      ),
      true
    )
    assert.equal(
      browserUserScriptPatternMatches('http://127.0.0.1:9000/shop/', 'http://127.0.0.1:8765/*'),
      false
    )
    assert.equal(
      browserUserScriptPatternMatches('http://127.0.0.1/shop/', 'http://127.0.0.1:8765/*'),
      false
    )
  })

  void test('the default port counts, * is any port, and no port ignores the port', () => {
    assert.equal(
      browserUserScriptPatternMatches('https://example.com/a', 'https://example.com:443/*'),
      true
    )
    assert.equal(
      browserUserScriptPatternMatches('http://localhost:5173/app', 'http://localhost:*/*'),
      true
    )
    assert.equal(
      browserUserScriptPatternMatches('http://localhost:5173/app', 'http://localhost/*'),
      true
    )
    assert.equal(
      browserUserScriptPatternMatches(
        'https://docs.example.com:8443/x',
        '*://*.example.com:8443/*'
      ),
      true
    )
  })

  void test('IPv6 hosts keep their colons inside the brackets', () => {
    assert.equal(browserUserScriptPatternMatches('http://[::1]:3000/', 'http://[::1]:3000/*'), true)
    assert.equal(browserUserScriptPatternMatches('http://[::1]:3000/', 'http://[::1]/*'), true)
    assert.equal(
      browserUserScriptPatternMatches('http://[::1]:3000/', 'http://[::1]:4000/*'),
      false
    )
  })
})
