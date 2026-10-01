import { createHmac, timingSafeEqual } from 'node:crypto'

const identityFields = [
  'campaignId',
  'candidateId',
  'participantId',
  'taskId',
  'attemptId',
  'jobId',
  'phase',
]

// 控制器签发的尝试身份；客户端不能靠请求正文改写费用归属。
export function validateRequestIdentity(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== identityFields.length ||
    identityFields.some(
      (key) => typeof value[key] !== 'string' || !/^[A-Za-z0-9_.:@+/-]{1,256}$/.test(value[key])
    ) ||
    !['source', 'install', 'replay'].includes(value.phase)
  )
    throw new Error('Invalid attempt identity')
  return Object.freeze(Object.fromEntries(identityFields.map((key) => [key, value[key]])))
}

// 签名令牌只交付给对应尝试；账本仅保存核验后的公开身份，不保存令牌。
export function attemptCredential(identity, secret) {
  const payload = Buffer.from(JSON.stringify(validateRequestIdentity(identity))).toString(
    'base64url'
  )
  return `sa1.${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`
}

// 主控制器凭据与尝试凭据分开；非法签名不解析成可信身份。
export function authenticateAttempt(authorization, secret) {
  if (typeof authorization !== 'string') return null
  const supplied = Buffer.from(authorization)
  const expected = Buffer.from(`Bearer ${secret}`)
  if (supplied.length === expected.length && timingSafeEqual(supplied, expected))
    return { controller: true, identity: null }
  const match = /^Bearer sa1\.([A-Za-z0-9_-]{1,4096})\.([A-Za-z0-9_-]{43})$/.exec(authorization)
  if (!match) return null
  const actual = Buffer.from(match[2], 'base64url')
  const signature = createHmac('sha256', secret).update(match[1]).digest()
  if (actual.length !== signature.length || !timingSafeEqual(actual, signature)) return null
  try {
    return {
      controller: false,
      identity: validateRequestIdentity(
        JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'))
      ),
    }
  } catch {
    return null
  }
}
