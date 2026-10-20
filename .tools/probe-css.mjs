// 在前端 CSS 里找 DSH 自己按钮的文字颜色做法（on-brand / 反色文字怎么取）。
import { readFileSync } from 'node:fs'

const archive = process.argv[2]
const needles = process.argv.slice(3)
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

const isText = (path) => /\.(css|js|json)$/.test(path)
for (const entry of entries) {
  if (!isText(entry.path)) continue
  if (entry.size > 8_000_000) continue
  const text = b.subarray(base + entry.offset, base + entry.offset + entry.size).toString('utf8')
  for (const needle of needles) {
    let index = -1
    let count = 0
    while ((index = text.indexOf(needle, index + 1)) >= 0 && count < 3) {
      count += 1
      console.log(`\n[${entry.path}] ${needle} @${index}`)
      console.log('  ' + text.slice(Math.max(0, index - 260), index + 260).replace(/\n/g, ' '))
    }
  }
}
