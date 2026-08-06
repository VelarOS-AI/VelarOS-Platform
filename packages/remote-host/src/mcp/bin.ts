#!/usr/bin/env node
import process from 'node:process'

import { runRemoteNodeMcpStdio } from './stdio-entry'

runRemoteNodeMcpStdio().catch((error: unknown) => {
  // stdout 属于 MCP 帧,诊断一律走 stderr。
  process.stderr.write(
    `velaros-remote-mcp: ${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exitCode = 1
})
