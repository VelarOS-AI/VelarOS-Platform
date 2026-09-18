/** 落盘的小工具：先写临时文件再改名。不碰实例状态。 */

import { randomUUID } from 'node:crypto'
import { rename, writeFile } from 'node:fs/promises'

/** 先写到同目录的临时文件再改名：断在中途不会留下半个文件，读的人要么看到旧的、要么看到新的。 */
export async function writeFileAtomic(path: string, text: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, text, 'utf8')
  await rename(temporary, path)
}
