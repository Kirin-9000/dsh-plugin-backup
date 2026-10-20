/**
 * 用真实的备份目录跑一遍文件浏览器的数据来源，确认用户点开"选择文件…"
 * 时看到的就是备份目录里的 .json 清单。
 *
 * 只读，不写任何东西。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
/**
 * 断言。
 * @param {boolean} condition 条件
 * @param {string} message 说明
 */
function check(condition, message) {
  if (condition) console.log(`  ✓ ${message}`)
  else {
    failures += 1
    console.log(`  ✗ ${message}`)
  }
}

// 复制真实备份目录结构到一个临时目录（不碰真实数据）
const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const realRoot = join(home, 'plugin-backup')
const sandboxHome = mkdtempSync(join(tmpdir(), 'live-browse-'))
const sandboxRoot = join(sandboxHome, 'plugin-backup')
mkdirSync(join(sandboxRoot, 'snapshots'), { recursive: true })

// 用真实 latest.json 的内容当素材
const { readFileSync: read, existsSync } = await import('node:fs')
const source = join(realRoot, 'latest.json')
if (existsSync(source)) writeFileSync(join(sandboxRoot, 'latest.json'), read(source), 'utf8')
writeFileSync(join(sandboxRoot, 'snapshots', '2026-01-01.json'), read(source), 'utf8')
writeFileSync(join(sandboxRoot, 'log.jsonl'), '{"action":"backup"}\n', 'utf8')

process.env.DSH_HOME = sandboxHome
process.env.DSH_PLUGIN_BACKUP_MIRROR = join(sandboxHome, 'location.json')
const { apply } = await import('../index.js')

let route
const ctx = {
  get: () => undefined,
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  webServer: {
    register(spec) {
      route = spec
      return () => {}
    },
  },
  tools: { register: () => () => {} },
}
apply(ctx)

/**
 * 调路由。
 * @param {string} method 方法
 * @param {object} [payload] 请求体
 * @returns {Promise<object>} 响应体
 */
async function call(method, payload = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  let text = ''
  await route.handler(
    {
      method: 'POST',
      url: `/plugin-backup/api/${method}`,
      async *[Symbol.asyncIterator]() {
        yield body
      },
    },
    {
      writeHead() {},
      end(chunk) {
        text = String(chunk)
      },
    },
  )
  return JSON.parse(text)
}

console.log('[live] 备份目录里的文件浏览器')
const listing = await call('list-files', { dir: sandboxRoot })
check(listing.ok === true, '能列出备份目录')

const names = listing.files.map((file) => file.name)
console.log(`  看到 ${listing.files.length} 个文件：${names.join(', ')}`)

check(names.includes('latest.json'), '能看到 latest.json（最新清单）')
check(listing.directories.some((dir) => dir.name === 'snapshots'), '能看到 snapshots 子目录')
check(!names.includes('log.jsonl'), 'log.jsonl 不在列表里（不是 .json 清单）')

// 进入 snapshots
const snapshots = listing.directories.find((dir) => dir.name === 'snapshots')
const inner = await call('list-files', { dir: snapshots.path })
check(inner.ok === true, '能进入 snapshots 子目录')
check(inner.files.some((file) => file.name.endsWith('.json')), 'snapshots 里的历史清单可见')
check(typeof inner.path === 'string' && inner.path.endsWith('snapshots'), '当前路径正确')

// 点选最新清单应能直接预览
const latest = listing.files.find((file) => file.name === 'latest.json')
const preview = await call('load-file', { file: latest.path })
check(preview.ok === true, '点选 latest.json 能直接预览')
check(preview.bundles.length > 0, `预览出 ${preview.bundles.length} 个插件`)

rmSync(sandboxHome, { recursive: true, force: true })

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures} 项)`}`)
process.exit(failures === 0 ? 0 : 1)
