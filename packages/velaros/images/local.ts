/**
 * 看图的本机实现入口（`@velaros-ai/velaros/images/local`），只给 Node 宿主：本机看图端口（本机任意位置的图，macOS 上用系统自带的 sips 裁图缩图），
 * 系统空间给 `velaros:images` 用它。它的配置从根入口取。
 */

export { createLocalImagePort } from './impl/LocalImagePort.js'
