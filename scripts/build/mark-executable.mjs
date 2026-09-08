import { chmod } from 'node:fs/promises'
import { resolve } from 'node:path'

const target = process.argv[2]

if (!target || process.argv.length !== 3) {
  throw new Error('Usage: node scripts/build/mark-executable.mjs <path>')
}

// Windows does not expose POSIX execute bits, but fs.chmod remains a portable no-op-compatible
// operation. Keeping this in Node avoids requiring a Unix chmod executable in local releases.
await chmod(resolve(target), 0o755)
