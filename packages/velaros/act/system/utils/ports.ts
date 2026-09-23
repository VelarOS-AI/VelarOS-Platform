import { AppError } from '@velaros-ai/core/error'
/** 调用上下文里按装配给出的端口；这次装配没给它时直接拒绝，不会有任何读写。 */
export function assembledPort<T>(port: Optional<T>, capability: string): T {
  if (!port)
    throw AppError.withFields('CAPABILITY_DENIED', `当前会话没有${capability}`, { effect: 'none' })
  return port
}
