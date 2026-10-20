/**
 * 端到端验证 dsh-plugin-backup 的 Host 路由。
 * 复用宿主当前的启动令牌：先 GET / 拿 Cookie（仅本进程令牌可用），
 * 之后按浏览器同样的方式 POST 各方法。
 *
 * 用法：node .tools/verify-routes.mjs [origin]
 */
const origin = process.argv[2] ?? process.env.DSH_WEB_URL ?? 'http://127.0.0.1:52157'

/** 先访问根路径，让宿主下发它自己的签名 Cookie。 */
const root = await fetch(origin, { redirect: 'manual' })
const cookies = root.headers.getSetCookie === undefined ? [] : root.headers.getSetCookie()
const cookie = cookies.map((entry) => entry.split(';')[0]).join('; ')
console.log(`root: HTTP ${root.status}, cookies: ${cookies.length}`)

/**
 * 调一个插件方法。
 * @param {string} method 方法名
 * @param {object} [payload] 请求体
 * @returns {Promise<object>} 响应
 */
async function call(method, payload = {}) {
  const response = await fetch(`${origin}/plugin-backup/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie === '' ? {} : { cookie }) },
    body: JSON.stringify(payload),
  })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  console.log(`\n=== ${method} → HTTP ${response.status}`)
  return { status: response.status, body }
}

const status = await call('status')
console.log(JSON.stringify({
  ok: status.body.ok,
  backupDir: status.body.backupDir,
  snapshot: status.body.snapshot,
  currentCount: status.body.current?.count,
  diff: status.body.diff,
  managerAvailable: status.body.managerAvailable,
  logLines: status.body.log?.length,
}, null, 2))

const backup = await call('backup')
console.log(JSON.stringify(backup.body, null, 2))

const restoreNoop = await call('restore', { targets: [] })
console.log(JSON.stringify(restoreNoop.body, null, 2))

const log = await call('log')
console.log(`log entries: ${Array.isArray(log.body.entries) ? log.body.entries.length : 'n/a'}`)
