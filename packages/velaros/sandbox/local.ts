/**
 * 演练沙箱的本机实现入口（`@velaros-ai/velaros/sandbox/local`），只给 Node 宿主：本机演练沙箱（镜像、清单、差量、落回、丢弃，
 * 镜像里的命令经 shell 的受约束执行器钉在镜像根）。空间给 `velaros:sandbox` 装端口时把它原样接上，自己只补 `resolveSource`。
 * 它的接口与配置从根入口取。
 */

export { createLocalSandboxHost } from './impl/LocalSandboxHost.js'
