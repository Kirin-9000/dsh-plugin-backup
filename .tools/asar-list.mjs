// 列出 asar 内匹配的条目（简单版 asar 读取）。
import { readFileSync } from 'node:fs'

const archive = process.argv[2]
const filter = process.argv[3]
const b = readFileSync(archive)
const jsonLength = b.readUInt32LE(12)
const header = JSON.parse(b.subarray(16, 16 + jsonLength).toString('utf8'))
const base = 16 + Math.ceil(jsonLength / 4) * 4
const entries = []
;(function walk(node, prefix) {
  for (const [name, value] of Object.entries(node.files ?? {})) {
    const full = prefix === '' ? name : `${prefix}/${name}`
    if (value.files) walk(value, full)
    else entries.push({ path: full, size: value.size, offset: Number(value.offset) })
  }
})(header, '')
for (const entry of entries) {
  if (filter === undefined || entry.path.includes(filter)) console.log(`${String(entry.size).padStart(9)} ${entry.path}`)
}
