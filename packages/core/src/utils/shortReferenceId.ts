import { AppError } from '../error'

/** 签发 8 位十六进制引用；占用检查必须包含已退役身份，禁止把旧引用重新指向新对象。 */
export function shortReferenceId(
  occupied: (id: string) => boolean,
  candidate: (attempt: number) => string = () => crypto.randomUUID().slice(0, 8)
): string {
  for (let attempt = 0; attempt < 64; attempt++) {
    const id = candidate(attempt)
    if (!/^[a-f0-9]{8}$/.test(id))
      throw new AppError('INTERNAL', '短引用生成器必须返回 8 位十六进制')
    if (!occupied(id)) return id
  }
  throw new AppError('CONFLICT', '短引用连续冲突，未签发身份')
}
