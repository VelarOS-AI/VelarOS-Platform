/** 使用标准 Web Crypto 计算请求指纹，不引入 Node 专用依赖。 */
export async function shortHash(text:string):Promise<string>{
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))
 return Array.from(new Uint8Array(bytes).slice(0,8),byte=>byte.toString(16).padStart(2,'0')).join('')
}
