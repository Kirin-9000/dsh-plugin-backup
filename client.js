/**
 * dsh-plugin-backup —— 浏览器半侧（Client half）
 *
 * 在「设置 → 插件」里增加一个「备份与恢复」页：展示上一次备份、当前安装情况、
 * 由宿主算好的差异清单（缺失 / 版本漂移 / 被禁用），勾选后一键恢复。
 *
 * 约束：
 *   - 不 require 任何 Harness Client 包（只 require 模块表里的 react），
 *     控件自己写，颜色只用 --dsw-alias-* 主题令牌。
 *   - 安装插件是重活：界面只发请求 + 轮询进度，安装动作全部由 Host 半侧
 *     调用官方 pluginManager 接口完成。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-backup',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'plugin-backup'
    const API_PREFIX = 'plugin-backup/api'

    // ── 与宿主通信 ────────────────────────────────────────────────────────

    /**
     * 把插件自己的 Host 路由解析成绝对 URL。基准取页面自身 base，
     * 这样反代目录前缀与桌面自定义 scheme 都能对上。
     * @param {string} method 路由方法名
     * @returns {string} 请求 URL
     */
    function hostUrl(method) {
      const base = typeof document !== 'undefined' && typeof document.baseURI === 'string' ? document.baseURI : 'http://dsh.internal/'
      const url = new URL(`${API_PREFIX}/${method}`, base)
      url.search = ''
      url.hash = ''
      return url.toString()
    }

    /**
     * 调用自己的 Host 路由（POST + JSON）。
     * @param {string} method 方法名
     * @param {object} [payload] 请求体
     * @returns {Promise<object>} 响应体
     */
    async function callHost(method, payload) {
      const response = await fetch(hostUrl(method), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload === undefined ? {} : payload),
      })
      let body
      try {
        body = await response.json()
      } catch {
        throw new Error(`${method}: HTTP ${response.status}`)
      }
      if (!response.ok || body === null || body.ok === false) {
        throw new Error(typeof body?.error === 'string' ? body.error : `${method}: HTTP ${response.status}`)
      }
      return body
    }

    // ── 文案 ──────────────────────────────────────────────────────────────

    const zh = {
      nav: '备份与恢复',
      title: '插件备份与恢复',
      desc: '把已安装的插件清单写成 JSON。备份目录可以指到 .dsh 之外——Harness 更新有可能重置整个 .dsh，那样备份会和要备份的东西一起丢。也可以指定任意一份 JSON 清单，直接按它恢复。',
      backupNow: '立即备份',
      backingUp: '备份中…',
      refresh: '刷新',
      restoring: '恢复中…',
      restoreSelected: '恢复所选',
      selectAll: '全选',
      clearAll: '清空',
      lastBackup: '上次备份',
      never: '还没有备份',
      currentCount: '当前安装',
      backupDir: '备份位置',
      diffTitle: '检测到的差异',
      noDiff: '当前安装与备份一致，没有需要恢复的插件。',
      needBackup: '还没有任何备份，请先点「立即备份」写下当前清单。',
      plugins: '个插件',
      running: '恢复进行中',
      finished: '恢复结束',
      progress: '进度 {done}/{total}',
      workingOn: '正在处理',
      summary: '结果',
      logTitle: '最近日志',
      showLog: '显示日志',
      hideLog: '隐藏日志',
      loadFailed: '读取备份状态失败',
      nothingSelected: '请先勾选要恢复的插件。',
      confirmTitle: '确认恢复以下插件',
      confirmBody: '将通过官方插件安装接口逐个恢复；已满足的项自动跳过，失败项记录到日志后继续处理下一项。',
      cancel: '取消',
      confirm: '开始恢复',
      kindMissing: '未安装',
      kindVersion: '版本不同',
      kindDisabled: '已禁用',
      kindRowDisabled: '行已禁用',
      kindRowMissing: '行缺失',
      backedUpTitle: '已备份的插件',
      backedUpEmpty: '快照里没有记录任何插件。',
      stateOk: '已安装',
      stateMissing: '未安装',
      stateVersion: '版本不同',
      stateDisabled: '已禁用',
      statePartial: '部分异常',
      rows: '个插件行',
      notRestorable: '无安装来源，需手工安装',
      live: '当前',
      ok: '成功',
      fail: '失败',
      noSource: '清单里没有可用的安装来源，请手工安装或补充清单',
      pendingBuilds: '需要在「设置 → 插件」里批准安装脚本后再试',
      managerMissing: '宿主缺少 pluginManager 服务，无法恢复',
      // 存储位置
      locationTitle: '备份存储位置',
      locationDesc: '默认在 .dsh 里。Harness 更新有可能重置整个 .dsh，建议把备份目录指到别的地方（如 D:\\dsh-backups）。',
      locationSourceDefault: '默认位置',
      locationSourceSettings: '自定义',
      locationSourceEnv: '来自环境变量 DSH_PLUGIN_BACKUP_DIR',
      locationSourceMirror: '自定义（靠主目录镜像找回）',
      mirrorWarning: 'DSH 更新似乎重置过 .dsh：位置记录是从用户主目录的镜像里恢复的。点一次「保存位置」把正式记录补回去。',
      mirrorHint: '位置镜像存于',
      changeDir: '更改位置',
      useDefaultDir: '恢复默认',
      applyDir: '保存位置',
      customDirPlaceholder: '例如 D:\\dsh-backups 或 ~/dsh-backups',
      dirSaved: '备份位置已切换',
      dirInvalid: '这个目录不能用',
      dirWritable: '可写',
      dirNotWritable: '不可写',
      settingsFile: '位置配置存于',
      // 指定 JSON 文件
      sourceTitle: '从指定 JSON 文件恢复',
      sourceDesc: '指定任意一份插件清单 JSON（可以是移动硬盘/网盘里的旧备份），按它的内容恢复。不改变上面的备份位置。',
      sourcePlaceholder: '清单文件完整路径，例如 D:\\dsh-backups\\latest.json',
      sourcePick: '读取这份文件',
      sourceClear: '改回当前备份',
      sourceLoaded: '已读取',
      sourceFailed: '读取失败',
      sourceActive: '正在使用指定的清单文件',
      sourceBundles: '文件里有 {count} 个插件',
      usingDefaultSnapshot: '当前使用备份目录里的最新清单',
      browse: '选择文件…',
      browseFileHint: '打开后只会列出 .json 文件，点一下即可读取。',
      browseDirHint: '用宿主的原生选择器挑一个目录',
      pickerTitle: '选择一个插件清单 JSON',
      pickerClose: '关闭',
      pickerLoading: '正在读取目录…',
      pickerEmpty: '这个目录里没有子目录，也没有 .json 文件。',
      pickerOnlyJson: '只显示 .json 文件；其它类型不会出现在这里。',
      noPicker: '宿主没有提供原生选择器，请直接输入路径',
    }

    const en = {
      nav: 'Backup & Restore',
      title: 'Plugin backup and restore',
      desc: 'Writes the installed plugin manifest as JSON. Point the backup directory outside .dsh — a Harness update can reset all of .dsh, which would take the backup down with the thing it backs up. You can also name any JSON manifest and restore from it directly.',
      backupNow: 'Back up now',
      backingUp: 'Backing up…',
      refresh: 'Refresh',
      restoring: 'Restoring…',
      restoreSelected: 'Restore selected',
      selectAll: 'Select all',
      clearAll: 'Clear',
      lastBackup: 'Last backup',
      never: 'No backup yet',
      currentCount: 'Installed now',
      backupDir: 'Backup location',
      diffTitle: 'Detected differences',
      noDiff: 'The installed set matches the backup; nothing to restore.',
      needBackup: 'There is no snapshot yet. Use “Back up now” to record the current list first.',
      plugins: 'plugins',
      running: 'Restore in progress',
      finished: 'Restore finished',
      progress: '{done}/{total} done',
      workingOn: 'Working on',
      summary: 'Result',
      logTitle: 'Recent log',
      showLog: 'Show log',
      hideLog: 'Hide log',
      loadFailed: 'Could not read the backup status',
      nothingSelected: 'Select at least one plugin to restore.',
      confirmTitle: 'Restore these plugins',
      confirmBody: 'Each plugin is restored through the official plugin install API. Items already satisfied are skipped; failures are logged and the run continues.',
      cancel: 'Cancel',
      confirm: 'Start restore',
      kindMissing: 'Not installed',
      kindVersion: 'Version differs',
      kindDisabled: 'Disabled',
      kindRowDisabled: 'Row disabled',
      kindRowMissing: 'Row missing',
      backedUpTitle: 'Backed-up plugins',
      backedUpEmpty: 'The snapshot records no plugins.',
      stateOk: 'Installed',
      stateMissing: 'Not installed',
      stateVersion: 'Version differs',
      stateDisabled: 'Disabled',
      statePartial: 'Partly broken',
      rows: 'rows',
      notRestorable: 'No install source — install it manually',
      live: 'current',
      ok: 'OK',
      fail: 'Failed',
      noSource: 'No install source recorded; install it manually or fix the snapshot',
      pendingBuilds: 'Approve the install scripts in Settings → Plugins, then retry',
      managerMissing: 'The host has no pluginManager service, so restore cannot run',
      // Storage location
      locationTitle: 'Backup location',
      locationDesc: 'Defaults to a folder inside .dsh. A Harness update can reset all of .dsh, so point this somewhere else (for example D:\\dsh-backups).',
      locationSourceDefault: 'default',
      locationSourceSettings: 'custom',
      locationSourceEnv: 'from DSH_PLUGIN_BACKUP_DIR',
      locationSourceMirror: 'custom (recovered from the home-directory mirror)',
      mirrorWarning:
        'A Harness update appears to have reset .dsh: the location came from the mirror in your home directory. Press “Save location” once to restore the primary record.',
      mirrorHint: 'Location mirror lives in',
      changeDir: 'Change location',
      useDefaultDir: 'Use default',
      applyDir: 'Save location',
      customDirPlaceholder: 'e.g. D:\\dsh-backups or ~/dsh-backups',
      dirSaved: 'Backup location changed',
      dirInvalid: 'That directory cannot be used',
      dirWritable: 'writable',
      dirNotWritable: 'not writable',
      settingsFile: 'Location setting lives in',
      // Specific JSON file
      sourceTitle: 'Restore from a chosen JSON file',
      sourceDesc: 'Name any plugin manifest JSON (an old backup on another drive, for instance) and restore from it. This does not change the backup location above.',
      sourcePlaceholder: 'Full path to a manifest, e.g. D:\\dsh-backups\\latest.json',
      sourcePick: 'Read this file',
      sourceClear: 'Back to the current backup',
      sourceLoaded: 'Loaded',
      sourceFailed: 'Could not read',
      sourceActive: 'Using the chosen manifest file',
      sourceBundles: 'The file lists {count} plugins',
      usingDefaultSnapshot: 'Using the newest manifest in the backup folder',
      browse: 'Choose file…',
      browseFileHint: 'Only .json files are listed; click one to load it.',
      browseDirHint: 'Pick a directory with the host’s native chooser',
      pickerTitle: 'Choose a plugin manifest JSON',
      pickerClose: 'Close',
      pickerLoading: 'Reading the directory…',
      pickerEmpty: 'This directory has no subdirectories and no .json files.',
      pickerOnlyJson: 'Only .json files are shown; other types never appear here.',
      noPicker: 'The host offers no native picker; type the path instead',
    }

    const KIND_KEY = {
      missing: 'kindMissing',
      'version-mismatch': 'kindVersion',
      disabled: 'kindDisabled',
      'row-disabled': 'kindRowDisabled',
      'row-missing': 'kindRowMissing',
    }

    /**
     * 备份条目的状态 → 文案键。
     * @param {string} state ok / missing / version-mismatch / disabled / partial
     * @returns {string} 文案键
     */
    function stateKey(state) {
      if (state === 'missing') return 'stateMissing'
      if (state === 'version-mismatch') return 'stateVersion'
      if (state === 'disabled') return 'stateDisabled'
      if (state === 'partial') return 'statePartial'
      return 'stateOk'
    }

    /**
     * 备份条目的状态 → 标签样式类后缀（复用差异标签的配色）。
     * @param {string} state 状态
     * @returns {string} 样式后缀
     */
    function stateTag(state) {
      if (state === 'missing') return 'missing'
      if (state === 'version-mismatch') return 'version-mismatch'
      if (state === 'disabled') return 'disabled'
      // 部分行有问题：既不是完全正常也不是完全缺失，用 warn 色
      if (state === 'partial') return 'row-disabled'
      return 'ok'
    }

    /**
     * 极简模板插值。
     * @param {string} template 含 {key} 的模板
     * @param {Record<string, unknown>} values 替换值
     * @returns {string} 结果
     */
    function format(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (match, key) => (values[key] === undefined ? match : String(values[key])))
    }

    /**
     * ISO 时间戳 → 本地可读时间。
     * @param {unknown} iso 时间戳
     * @returns {string} 可读时间，无法解析时原样返回
     */
    function formatTime(iso) {
      if (typeof iso !== 'string' || iso === '') return ''
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return iso
      const pad = (value) => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    // ── 样式（只引用主题令牌，亮/暗自动跟随） ─────────────────────────────

    const CSS = [
      '.pb-root{display:flex;flex-direction:column;gap:14px;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary);max-width:720px}',
      '.pb-card{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:10px}',
      '.pb-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.pb-grow{flex:1 1 auto;min-width:0}',
      '.pb-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.pb-sub{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.pb-caption{font-size:11px;color:var(--dsw-alias-label-caption)}',
      // 普通按钮：文字跟随主题的主文字色
      '.pb-btn{appearance:none;font-family:inherit;font-size:12px;line-height:18px;padding:5px 12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer}',
      '.pb-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-interactive-bg-hover)}',
      '.pb-btn:disabled{opacity:.5;cursor:default}',
      // 主按钮：用 DSH 自己的按钮配色组合。
      // 关键是不能写字面 #fff —— --dsw-alias-brand-primary 在浅色主题下是近黑、
      // 在深色主题下是近白，白字压上去就看不见了。反色文字用 label-primary-inverted，
      // 它是随主题翻转的那一个令牌。
      '.pb-btn-primary{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted)}',
      '.pb-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);border-color:var(--dsw-alias-button-primary-hover);color:var(--dsw-alias-label-primary-inverted)}',
      '.pb-list{display:flex;flex-direction:column;gap:2px}',
      '.pb-item{display:flex;align-items:flex-start;gap:10px;padding:8px 10px;border-radius:8px}',
      '.pb-item:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.pb-item input{margin:3px 0 0;accent-color:var(--dsw-alias-brand-primary)}',
      '.pb-name{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:var(--dsw-alias-label-primary);word-break:break-all}',
      '.pb-detail{font-size:12px;color:var(--dsw-alias-label-secondary);word-break:break-word}',
      '.pb-tag{font-size:11px;line-height:16px;border-radius:4px;padding:0 6px;border:1px solid currentColor;white-space:nowrap}',
      '.pb-tag-missing,.pb-tag-row-missing{color:var(--dsw-alias-state-error-primary)}',
      '.pb-tag-version-mismatch,.pb-tag-disabled,.pb-tag-row-disabled{color:var(--dsw-alias-state-warn-primary)}',
      '.pb-tag-ok{color:var(--dsw-alias-state-success-primary)}',
      '.pb-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary);word-break:break-all}',
      '.pb-log{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.7;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:10px 12px;max-height:220px;overflow:auto;white-space:pre-wrap;word-break:break-all}',
      '.pb-err{font-size:12px;color:var(--dsw-alias-state-error-primary)}',
      '.pb-ok{font-size:12px;color:var(--dsw-alias-state-success-primary)}',
      '.pb-confirm{border-color:var(--dsw-alias-state-warn-primary)}',
      '.pb-input{appearance:none;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px;padding:5px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);min-width:0;flex:1 1 260px}',
      '.pb-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.pb-hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.pb-warn{font-size:12px;color:var(--dsw-alias-state-warn-primary)}',
      '.pb-divider{height:1px;background:var(--dsw-alias-border-l1);margin:2px 0}',
      '.pb-picker{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}',
      '.pb-crumbs{display:flex;flex-wrap:wrap;gap:2px;align-items:center}',
      '.pb-crumb{appearance:none;border:none;background:none;padding:1px 5px;border-radius:4px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);cursor:pointer;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.pb-crumb:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
      '.pb-picker-list{display:flex;flex-direction:column;gap:1px;max-height:260px;overflow:auto}',
      '.pb-picker-row{appearance:none;border:none;background:none;display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;cursor:pointer;text-align:left;font-family:inherit;color:var(--dsw-alias-label-primary);width:100%}',
      '.pb-picker-row:hover{background:var(--dsw-alias-bg-layer-1)}',
      '.pb-picker-file .pb-name{word-break:break-all}',
      '.pb-picker-icon{width:18px;flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);text-align:center}',
    ].join('\n')

    // ── 组件 ──────────────────────────────────────────────────────────────

    /**
     * 备份与恢复面板。
     * @param {{ t: (key: string) => string }} props 注入的翻译函数
     * @returns {import('react').ReactElement}
     */
    function BackupPanel(props) {
      const t = props.t
      /** 原生目录选择器（可能不可用，见 apply 里的说明） */
      const pickDirectory = props.pickDirectory
      const [status, setStatus] = React.useState(undefined)
      const [error, setError] = React.useState(undefined)
      const [busy, setBusy] = React.useState(undefined)
      const [note, setNote] = React.useState(undefined)
      const [selected, setSelected] = React.useState(() => new Set())
      const [confirming, setConfirming] = React.useState(false)
      const [showLog, setShowLog] = React.useState(false)
      /** 备份目录编辑框（undefined = 未在编辑） */
      const [dirDraft, setDirDraft] = React.useState(undefined)
      /** 指定清单文件路径 */
      const [sourceFile, setSourceFile] = React.useState('')
      /** 已读取的指定文件预览结果 */
      const [sourcePreview, setSourcePreview] = React.useState(undefined)
      /** JSON 文件浏览器是否打开 */
      const [pickerOpen, setPickerOpen] = React.useState(false)
      /** 文件浏览器当前目录内容 */
      const [pickerListing, setPickerListing] = React.useState(undefined)
      /** 文件浏览器错误 */
      const [pickerError, setPickerError] = React.useState(undefined)
      /** 用户是否手动改过勾选（改过就不再自动全选差异） */
      const touchedRef = React.useRef(false)
      /** 轮询定时器 id */
      const pollRef = React.useRef(undefined)

      const running = status !== undefined && status.job !== undefined && status.job.running === true

      /** 指定的（已确认可用的）清单文件；空字符串表示用备份目录的最新清单 */
      const activeSourceRef = React.useRef('')

      /** 拉取一次状态。 */
      const load = React.useCallback(async () => {
        try {
          const payload = activeSourceRef.current === '' ? {} : { sourceFile: activeSourceRef.current }
          const next = await callHost('status', payload)
          setStatus(next)
          setError(undefined)
          if (!touchedRef.current) {
            setSelected(new Set((next.diff === undefined ? [] : next.diff).map((item) => item.name)))
          }
          return next
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : String(caught))
          return undefined
        }
      }, [])

      // 首次加载；卸载时清掉定时器
      React.useEffect(() => {
        void load()
        return () => {
          if (pollRef.current !== undefined) clearTimeout(pollRef.current)
        }
      }, [load])

      // 恢复任务运行期间轮询进度
      React.useEffect(() => {
        if (!running) return undefined
        const tick = async () => {
          const next = await load()
          if (next !== undefined && next.job !== undefined && next.job.running === true) {
            pollRef.current = setTimeout(tick, 1200)
          }
        }
        pollRef.current = setTimeout(tick, 800)
        return () => {
          if (pollRef.current !== undefined) clearTimeout(pollRef.current)
        }
      }, [running, load])

      /** 立即备份。 */
      const onBackup = async () => {
        setBusy('backup')
        setNote(undefined)
        try {
          const result = await callHost('backup')
          setNote({ ok: true, text: `${t('lastBackup')}: ${formatTime(result.createdAt)} · ${result.count} ${t('plugins')}` })
          touchedRef.current = false
          await load()
        } catch (caught) {
          setNote({ ok: false, text: caught instanceof Error ? caught.message : String(caught) })
        } finally {
          setBusy(undefined)
        }
      }

      /** 提交恢复。 */
      const onRestore = async () => {
        setConfirming(false)
        const names = [...selected]
        if (names.length === 0) {
          setNote({ ok: false, text: t('nothingSelected') })
          return
        }
        setBusy('restore')
        setNote(undefined)
        try {
          const payload = { targets: names }
          if (activeSourceRef.current !== '') payload.sourceFile = activeSourceRef.current
          const result = await callHost('restore', payload)
          setNote({
            ok: true,
            text: result.message === undefined ? `${t('restoring')} ${result.accepted} ${t('plugins')}` : result.message,
          })
          touchedRef.current = false
          await load()
        } catch (caught) {
          setNote({ ok: false, text: caught instanceof Error ? caught.message : String(caught) })
        } finally {
          setBusy(undefined)
        }
      }

      /** 用原生选择器挑目录；不可用时把当前值保留，让用户手输。 */
      const onBrowseDir = async () => {
        if (typeof pickDirectory !== 'function') return
        const picked = await pickDirectory()
        if (picked !== undefined) setDirDraft(picked)
      }

      /** 推断文件对话框/浏览器的起始目录。 */
      const guessInitialDir = () => {
        const typed = sourceFile.trim()
        if (typed !== '') {
          // 已填的是 .json 文件就用它的目录；否则当作目录
          const separator = Math.max(typed.lastIndexOf('\\'), typed.lastIndexOf('/'))
          if (/\.json$/i.test(typed) && separator > 0) return typed.slice(0, separator)
          return typed
        }
        if (status !== undefined && status.location !== undefined) return status.location.backupDir
        return ''
      }

      /**
       * 把已读取的清单合并进界面状态。
       * @param result Host 返回的清单结果
       */
      const applyLoadedSnapshot = (result) => {
        if (result.file !== undefined) {
          activeSourceRef.current = result.file
          setSourceFile(result.file)
        }
        if (result.snapshot !== undefined && Array.isArray(result.bundles)) {
          setSourcePreview({
            ok: true,
            file: result.file,
            count: result.snapshot.count === undefined ? result.bundles.length : result.snapshot.count,
            bundles: result.bundles,
            diff: Array.isArray(result.diff) ? result.diff : [],
          })
        }
        setPickerOpen(false)
        touchedRef.current = false
        void load()
      }

      /** 选择文件：优先系统原生对话框，宿主不支持时退回内置 .json 浏览器。 */
      const onBrowseFile = async () => {
        setPickerError(undefined)
        setBusy('source')
        try {
          const result = await callHost('pick-file', { initialDir: guessInitialDir() })
          if (result.unsupported === true) {
            // 非 Windows / 没有 PowerShell：退回内置浏览器
            setPickerOpen(true)
            await openPickerAt(guessInitialDir())
            return
          }
          if (result.cancelled === true) return
          applyLoadedSnapshot(result)
        } catch (caught) {
          // 原生对话框自身出错：给一次内置浏览器的机会，而不是让用户卡住
          setPickerError(caught instanceof Error ? caught.message : String(caught))
          setPickerOpen(true)
          await openPickerAt(guessInitialDir())
        } finally {
          setBusy(undefined)
        }
      }

      /**
       * 让文件浏览器列出某个目录。
       * @param dir 目标目录；给的是文件路径时自动取其所在目录
       */
      const openPickerAt = async (dir) => {
        setPickerError(undefined)
        try {
          const listing = await callHost('list-files', { dir: dir === undefined ? '' : dir })
          setPickerListing(listing)
        } catch (caught) {
          setPickerListing(undefined)
          setPickerError(caught instanceof Error ? caught.message : String(caught))
        }
      }

      /** 在文件浏览器里选中一个 .json 文件并直接读取它。 */
      const onPickFile = async (path) => {
        setPickerOpen(false)
        setSourceFile(path)
        setBusy('source')
        setSourcePreview(undefined)
        try {
          const result = await callHost('load-file', { file: path })
          activeSourceRef.current = result.file
          setSourceFile(result.file)
          setSourcePreview({
            ok: true,
            file: result.file,
            count: result.snapshot.count,
            bundles: result.bundles,
            diff: result.diff,
          })
          touchedRef.current = false
          await load()
        } catch (caught) {
          activeSourceRef.current = ''
          setSourcePreview({ ok: false, error: caught instanceof Error ? caught.message : String(caught) })
        } finally {
          setBusy(undefined)
        }
      }

      /** 保存新的备份目录。 */
      const onSaveDir = async () => {
        const draft = dirDraft === undefined ? '' : dirDraft
        setBusy('settings')
        setNote(undefined)
        try {
          const result = await callHost('settings', { backupDir: draft })
          setDirDraft(undefined)
          setNote({ ok: true, text: `${t('dirSaved')}: ${result.location.backupDir}` })
          // 换了目录，之前"指定文件"的选择也该让位给新目录里的清单
          activeSourceRef.current = ''
          setSourceFile('')
          setSourcePreview(undefined)
          touchedRef.current = false
          await load()
        } catch (caught) {
          setNote({ ok: false, text: caught instanceof Error ? caught.message : String(caught) })
        } finally {
          setBusy(undefined)
        }
      }

      /** 读取用户指定的清单文件（只预览，不改设置）。 */
      const onLoadFile = async () => {
        const path = sourceFile.trim()
        if (path === '') {
          setSourcePreview({ ok: false, error: t('sourcePlaceholder') })
          return
        }
        setBusy('source')
        setSourcePreview(undefined)
        try {
          const result = await callHost('load-file', { file: path })
          activeSourceRef.current = result.file
          setSourceFile(result.file)
          setSourcePreview({
            ok: true,
            file: result.file,
            count: result.snapshot.count,
            bundles: result.bundles,
            diff: result.diff,
          })
          touchedRef.current = false
          await load()
        } catch (caught) {
          activeSourceRef.current = ''
          setSourcePreview({ ok: false, error: caught instanceof Error ? caught.message : String(caught) })
        } finally {
          setBusy(undefined)
        }
      }

      /** 改回使用备份目录里的最新清单。 */
      const onClearSource = async () => {
        activeSourceRef.current = ''
        setSourceFile('')
        setSourcePreview(undefined)
        touchedRef.current = false
        await load()
      }

      /** 勾选/取消一个插件。 */
      const toggle = (name) => {
        touchedRef.current = true
        setSelected((previous) => {
          const next = new Set(previous)
          if (next.has(name)) next.delete(name)
          else next.add(name)
          return next
        })
      }

      const diff = status === undefined || status.diff === undefined ? [] : status.diff
      const diffNames = []
      for (const item of diff) if (!diffNames.includes(item.name)) diffNames.push(item.name)
      const snapshot = status === undefined ? undefined : status.snapshot
      const job = status === undefined ? undefined : status.job
      /** 备份里的插件清单本体（即使没有任何差异也要能看到） */
      const backedUp = status === undefined || status.backedUp === undefined ? [] : status.backedUp
      /** 当前生效的存储位置描述 */
      const location = status === undefined ? undefined : status.location
      /** 当前是否在用"指定的清单文件"（而不是备份目录的最新清单） */
      const activeSourceFileValue = activeSourceRef.current

      return h(
        'div',
        { className: 'pb-root' },

        // 概览 + 备份
        h(
          'div',
          { className: 'pb-card' },
          h('div', { className: 'pb-title' }, t('title')),
          h('div', { className: 'pb-sub' }, t('desc')),
          h(
            'div',
            { className: 'pb-row' },
            h(
              'button',
              { type: 'button', className: 'pb-btn pb-btn-primary', disabled: busy !== undefined, onClick: () => void onBackup() },
              busy === 'backup' ? t('backingUp') : t('backupNow'),
            ),
            h('button', { type: 'button', className: 'pb-btn', disabled: busy !== undefined, onClick: () => void load() }, t('refresh')),
            h('div', { className: 'pb-grow' }),
            h(
              'span',
              { className: 'pb-caption' },
              snapshot === undefined
                ? t('never')
                : `${t('lastBackup')}: ${formatTime(snapshot.createdAt)} · ${snapshot.count} ${t('plugins')}${snapshot.dshVersion === undefined ? '' : ` · DSH ${snapshot.dshVersion}`}`,
            ),
            h('span', { className: 'pb-caption' }, `${t('currentCount')}: ${status === undefined || status.current === undefined ? 0 : status.current.count} ${t('plugins')}`),
          ),
          status === undefined || status.backupDir === undefined
            ? null
            : h('div', { className: 'pb-mono' }, `${t('backupDir')}: ${status.backupDir}`),
          error === undefined ? null : h('div', { className: 'pb-err' }, `${t('loadFailed')}: ${error}`),
          status !== undefined && status.managerAvailable === false ? h('div', { className: 'pb-err' }, t('managerMissing')) : null,
          note === undefined ? null : h('div', { className: note.ok ? 'pb-ok' : 'pb-err' }, note.text),
        ),

        // 存储位置：把备份目录移出 .dsh，避免"升级把备份和插件一起重置"
        h(
          'div',
          { className: 'pb-card' },
          h(
            'div',
            { className: 'pb-row' },
            h('div', { className: 'pb-title' }, t('locationTitle')),
            h(
              'span',
              { className: 'pb-tag pb-tag-ok' },
              location === undefined
                ? '—'
                : location.source === 'env'
                  ? t('locationSourceEnv')
                  : location.source === 'mirror'
                    ? t('locationSourceMirror')
                    : location.source === 'settings'
                      ? t('locationSourceSettings')
                      : t('locationSourceDefault'),
            ),
            h('div', { className: 'pb-grow' }),
            location !== undefined && location.isDefault === false
              ? h('button', { type: 'button', className: 'pb-btn', disabled: busy !== undefined, onClick: () => setDirDraft('') }, t('useDefaultDir'))
              : null,
            h('button', { type: 'button', className: 'pb-btn', disabled: busy !== undefined, onClick: () => setDirDraft(location === undefined ? '' : location.backupDir) }, t('changeDir')),
          ),
          h('div', { className: 'pb-sub' }, t('locationDesc')),
          // .dsh 被重置过：备份还在，但正式位置记录丢了，提示用户补存一次
          location !== undefined && location.restoredFromMirror === true
            ? h('div', { className: 'pb-warn' }, t('mirrorWarning'))
            : null,
          location === undefined
            ? null
            : h(
                'div',
                { className: 'pb-mono' },
                `${location.backupDir}${location.writable === false ? `  (${t('dirNotWritable')})` : ''}`,
              ),
          location !== undefined && location.source === 'env'
            ? h('div', { className: 'pb-hint' }, `${t('locationSourceEnv')}：改环境变量后需重启 DSH`)
            : null,
          dirDraft === undefined
            ? null
            : h(
                'div',
                { className: 'pb-row' },
                h('input', {
                  className: 'pb-input',
                  type: 'text',
                  value: dirDraft,
                  placeholder: t('customDirPlaceholder'),
                  spellCheck: false,
                  onChange: (event) => setDirDraft(event.target.value),
                }),
                typeof pickDirectory === 'function'
                  ? h('button', { type: 'button', className: 'pb-btn', disabled: busy !== undefined, onClick: () => void onBrowseDir() }, t('browse'))
                  : null,
                h('button', { type: 'button', className: 'pb-btn pb-btn-primary', disabled: busy !== undefined, onClick: () => void onSaveDir() }, busy === 'settings' ? t('backingUp') : t('applyDir')),
                h('button', { type: 'button', className: 'pb-btn', disabled: busy !== undefined, onClick: () => setDirDraft(undefined) }, t('cancel')),
              ),
          h('div', { className: 'pb-hint' }, t('customDirPlaceholder')),
          location === undefined ? null : h('div', { className: 'pb-caption' }, `${t('settingsFile')}: ${location.settingsFile}`),
          location === undefined || location.mirrorFile === undefined
            ? null
            : h('div', { className: 'pb-caption' }, `${t('mirrorHint')}: ${location.mirrorFile}`),
        ),

        // 指定 JSON 文件：直接按用户挑的那份清单恢复
        h(
          'div',
          { className: 'pb-card' },
          h(
            'div',
            { className: 'pb-row' },
            h('div', { className: 'pb-title' }, t('sourceTitle')),
            activeSourceFileValue === ''
              ? h('span', { className: 'pb-caption' }, t('usingDefaultSnapshot'))
              : h('span', { className: 'pb-tag pb-tag-ok' }, t('sourceActive')),
            h('div', { className: 'pb-grow' }),
            activeSourceFileValue === ''
              ? null
              : h('button', { type: 'button', className: 'pb-btn', disabled: busy !== undefined, onClick: () => void onClearSource() }, t('sourceClear')),
          ),
          h('div', { className: 'pb-sub' }, t('sourceDesc')),
          h(
            'div',
            { className: 'pb-row' },
            h('input', {
              className: 'pb-input',
              type: 'text',
              value: sourceFile,
              placeholder: t('sourcePlaceholder'),
              spellCheck: false,
              onChange: (event) => setSourceFile(event.target.value),
            }),
            h('button', { type: 'button', className: 'pb-btn pb-btn-primary', disabled: busy !== undefined, onClick: () => void onLoadFile() }, busy === 'source' ? t('backingUp') : t('sourcePick')),
            h('button', { type: 'button', className: 'pb-btn', disabled: busy !== undefined, onClick: () => void onBrowseFile() }, t('browse')),
          ),
          h('div', { className: 'pb-hint' }, t('browseFileHint')),
          pickerOpen ? h(JsonFilePicker, {
            t,
            listing: pickerListing,
            error: pickerError,
            onOpen: (dir) => void openPickerAt(dir),
            onPick: (path) => void onPickFile(path),
            onClose: () => setPickerOpen(false),
          }) : null,
          sourcePreview === undefined
            ? null
            : sourcePreview.ok !== true
              ? h('div', { className: 'pb-err' }, `${t('sourceFailed')}: ${sourcePreview.error}`)
              : h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                  h('div', { className: 'pb-ok' }, `${t('sourceLoaded')}: ${sourcePreview.file}`),
                  h('div', { className: 'pb-caption' }, format(t('sourceBundles'), { count: sourcePreview.count })),
                  h(
                    'div',
                    { className: 'pb-hint' },
                    sourcePreview.bundles.map((bundle) => `${bundle.name}${bundle.restorable ? '' : '(无来源)'}`).join('、'),
                  ),
                ),
        ),

        // 已备份的插件清单（本体：备份里到底有哪些插件）
        h(
          'div',
          { className: 'pb-card' },
          h(
            'div',
            { className: 'pb-row' },
            h('div', { className: 'pb-title' }, t('backedUpTitle')),
            h('span', { className: 'pb-caption' }, `${backedUp.length} ${t('plugins')}`),
            h('div', { className: 'pb-grow' }),
            snapshot === undefined
              ? null
              : h('span', { className: 'pb-caption' }, `${t('lastBackup')}: ${formatTime(snapshot.createdAt)}`),
          ),
          snapshot === undefined
            ? h('div', { className: 'pb-sub' }, t('needBackup'))
            : backedUp.length === 0
              ? h('div', { className: 'pb-sub' }, t('backedUpEmpty'))
              : h(
                  'div',
                  { className: 'pb-list' },
                  ...backedUp.map((item, index) =>
                    h(
                      'div',
                      { className: 'pb-item', key: `backed-${item.name}-${index}` },
                      h(
                        'div',
                        { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: '1 1 auto' } },
                        h(
                          'div',
                          { className: 'pb-row', style: { gap: 6 } },
                          h('span', { className: 'pb-name' }, item.name),
                          item.version === undefined ? null : h('span', { className: 'pb-caption' }, `@${item.version}`),
                          h(
                            'span',
                            { className: `pb-tag pb-tag-${stateTag(item.state)}` },
                            t(stateKey(item.state)),
                          ),
                          item.liveVersion === undefined || item.liveVersion === item.version
                            ? null
                            : h('span', { className: 'pb-caption' }, `${t('live')} ${item.liveVersion}`),
                        ),
                        h(
                          'div',
                          { className: 'pb-row', style: { gap: 6 } },
                          item.rows === 0
                            ? null
                            : h('span', { className: 'pb-caption' }, `${item.rows} ${t('rows')}`),
                          // 不可自动恢复是用户必须知道的事，单独用警示色标出来，不混进灰色说明里
                          item.restorable ? null : h('span', { className: 'pb-tag pb-tag-version-mismatch' }, t('notRestorable')),
                        ),
                      ),
                    ),
                  ),
                ),
        ),

        // 差异清单
        h(
          'div',
          { className: 'pb-card' },
          h(
            'div',
            { className: 'pb-row' },
            h('div', { className: 'pb-title' }, t('diffTitle')),
            h('span', { className: 'pb-caption' }, String(diffNames.length)),
            h('div', { className: 'pb-grow' }),
            h(
              'button',
              {
                type: 'button',
                className: 'pb-btn',
                disabled: diffNames.length === 0 || running,
                onClick: () => {
                  touchedRef.current = true
                  setSelected(new Set(diffNames))
                },
              },
              t('selectAll'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'pb-btn',
                disabled: selected.size === 0 || running,
                onClick: () => {
                  touchedRef.current = true
                  setSelected(new Set())
                },
              },
              t('clearAll'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'pb-btn pb-btn-primary',
                disabled: busy !== undefined || running || selected.size === 0,
                onClick: () => setConfirming(true),
              },
              busy === 'restore' ? t('restoring') : t('restoreSelected'),
            ),
          ),
          snapshot === undefined
            ? h('div', { className: 'pb-sub' }, t('needBackup'))
            : diff.length === 0
              ? h('div', { className: 'pb-sub' }, t('noDiff'))
              : h(
                  'div',
                  { className: 'pb-list' },
                  ...diff.map((item, index) =>
                    h(
                      'label',
                      { className: 'pb-item', key: `${item.kind}:${item.name}:${item.moduleName === undefined ? '' : item.moduleName}:${index}` },
                      h('input', {
                        type: 'checkbox',
                        checked: selected.has(item.name),
                        disabled: running,
                        onChange: () => toggle(item.name),
                      }),
                      h(
                        'div',
                        { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
                        h(
                          'div',
                          { className: 'pb-row', style: { gap: 6 } },
                          h('span', { className: 'pb-name' }, item.name),
                          h('span', { className: `pb-tag pb-tag-${item.kind}` }, t(KIND_KEY[item.kind] === undefined ? 'kindMissing' : KIND_KEY[item.kind])),
                          item.moduleName === undefined ? null : h('span', { className: 'pb-caption' }, item.moduleName),
                        ),
                        h('div', { className: 'pb-detail' }, item.detail),
                        (item.kind === 'missing' || item.kind === 'version-mismatch') && item.spec === undefined
                          ? h('div', { className: 'pb-caption' }, t('noSource'))
                          : null,
                      ),
                    ),
                  ),
                ),
        ),

        // 恢复进度
        job === undefined ? null : h(RestoreProgress, { job, t }),

        // 确认框
        confirming
          ? h(
              'div',
              { className: 'pb-card pb-confirm', role: 'dialog', 'aria-modal': 'true' },
              h('div', { className: 'pb-title' }, t('confirmTitle')),
              h('div', { className: 'pb-sub' }, t('confirmBody')),
              h('div', { className: 'pb-mono' }, [...selected].join(', ')),
              h(
                'div',
                { className: 'pb-row' },
                h('button', { type: 'button', className: 'pb-btn', onClick: () => setConfirming(false) }, t('cancel')),
                h('button', { type: 'button', className: 'pb-btn pb-btn-primary', onClick: () => void onRestore() }, t('confirm')),
              ),
            )
          : null,

        // 日志
        showLog
          ? h(
              'div',
              { className: 'pb-card' },
              h(
                'div',
                { className: 'pb-row' },
                h('div', { className: 'pb-title' }, t('logTitle')),
                h('div', { className: 'pb-grow' }),
                h('button', { type: 'button', className: 'pb-btn', onClick: () => setShowLog(false) }, t('hideLog')),
              ),
              h(
                'div',
                { className: 'pb-log' },
                ...(status === undefined || status.log === undefined ? [] : status.log).map((entry, index) =>
                  h('div', { key: `log-${index}` }, describeLogLine(entry, t)),
                ),
              ),
            )
          : h(
              'div',
              { className: 'pb-row' },
              h('button', { type: 'button', className: 'pb-btn', onClick: () => setShowLog(true) }, t('showLog')),
            ),
      )
    }

    /**
     * 恢复任务的进度块。
     * @param {{ job: object, t: (key: string) => string }} props 任务状态与翻译函数
     * @returns {import('react').ReactElement}
     */
    function RestoreProgress(props) {
      const job = props.job
      const t = props.t
      const results = job.results === undefined ? [] : job.results
      return h(
        'div',
        { className: 'pb-card' },
        h(
          'div',
          { className: 'pb-row' },
          h('div', { className: 'pb-title' }, job.running === true ? t('running') : t('finished')),
          h(
            'span',
            { className: job.running === true ? 'pb-caption' : 'pb-tag pb-tag-ok' },
            format(t('progress'), { done: job.done === undefined ? 0 : job.done, total: job.total === undefined ? 0 : job.total }),
          ),
          job.current === undefined ? null : h('span', { className: 'pb-caption' }, `${t('workingOn')}: ${job.current}`),
        ),
        job.summary === undefined ? null : h('div', { className: 'pb-sub' }, `${t('summary')}: ${job.summary}`),
        job.error === undefined ? null : h('div', { className: 'pb-err' }, job.error),
        results.length === 0
          ? null
          : h(
              'div',
              { className: 'pb-list' },
              ...results.map((entry, index) =>
                h(
                  'div',
                  { className: 'pb-item', key: `result-${index}` },
                  h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
                    h(
                      'div',
                      { className: 'pb-row', style: { gap: 6 } },
                      h('span', { className: 'pb-name' }, entry.name === undefined ? '' : entry.name),
                      entry.moduleName === undefined ? null : h('span', { className: 'pb-caption' }, entry.moduleName),
                      h('span', { className: entry.ok === true ? 'pb-tag pb-tag-ok' : 'pb-tag pb-tag-missing' }, entry.ok === true ? t('ok') : t('fail')),
                    ),
                    h('div', { className: 'pb-detail' }, entry.detail === undefined ? '' : entry.detail),
                  ),
                ),
              ),
            ),
      )
    }

    /**
     * 只认 .json 的文件浏览器。
     *
     * 宿主的原生选择器只能挑目录（`pickDirectory` 走的是 `openDirectory`），
     * 所以挑"某一个清单文件"这件事由我们自己列目录实现：
     * 子目录可进入，`.json` 文件可直接点选，其它文件根本不列出来。
     *
     * @param {{ t: Function, listing: object|undefined, error: string|undefined,
     *           onOpen: (dir: string) => void, onPick: (path: string) => void,
     *           onClose: () => void }} props 属性
     * @returns {import('react').ReactElement}
     */
    function JsonFilePicker(props) {
      const t = props.t
      const listing = props.listing
      const error = props.error

      /** 把字节数变短。 */
      const sizeText = (size) => {
        if (typeof size !== 'number') return ''
        if (size < 1024) return `${size} B`
        if (size < 1024 * 1024) return `${Math.round(size / 1024)} KiB`
        return `${(size / 1024 / 1024).toFixed(1)} MiB`
      }

      return h(
        'div',
        { className: 'pb-picker', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('pickerTitle') },
        h(
          'div',
          { className: 'pb-row' },
          h('div', { className: 'pb-title' }, t('pickerTitle')),
          h('div', { className: 'pb-grow' }),
          h('button', { type: 'button', className: 'pb-btn', onClick: () => props.onClose() }, t('pickerClose')),
        ),
        error === undefined ? null : h('div', { className: 'pb-err' }, error),

        // 面包屑：任何一级都能点回去
        listing === undefined
          ? h('div', { className: 'pb-caption' }, t('pickerLoading'))
          : h(
              'div',
              { className: 'pb-crumbs' },
              ...listing.crumbs.map((crumb, index) =>
                h(
                  'button',
                  {
                    key: `crumb-${index}`,
                    type: 'button',
                    className: 'pb-crumb',
                    title: crumb.path,
                    onClick: () => props.onOpen(crumb.path),
                  },
                  crumb.name === '' ? '/' : crumb.name,
                ),
              ),
            ),

        listing === undefined
          ? null
          : h(
              'div',
              { className: 'pb-picker-list' },
              // 上一级
              listing.parent === undefined
                ? null
                : h(
                    'button',
                    { type: 'button', className: 'pb-picker-row', onClick: () => props.onOpen(listing.parent) },
                    h('span', { className: 'pb-picker-icon' }, '↑'),
                    h('span', { className: 'pb-name' }, '..'),
                  ),
              // 子目录
              ...listing.directories.map((dir) =>
                h(
                  'button',
                  { key: `dir-${dir.path}`, type: 'button', className: 'pb-picker-row', onClick: () => props.onOpen(dir.path) },
                  h('span', { className: 'pb-picker-icon' }, '📁'),
                  h('span', { className: 'pb-name' }, dir.name),
                ),
              ),
              // 可选的 .json 文件
              ...listing.files.map((file) =>
                h(
                  'button',
                  {
                    key: `file-${file.path}`,
                    type: 'button',
                    className: 'pb-picker-row pb-picker-file',
                    title: file.path,
                    onClick: () => props.onPick(file.path),
                  },
                  h('span', { className: 'pb-picker-icon' }, '{ }'),
                  h('span', { className: 'pb-name' }, file.name),
                  h('span', { className: 'pb-caption' }, sizeText(file.size)),
                ),
              ),
              listing.directories.length === 0 && listing.files.length === 0
                ? h('div', { className: 'pb-caption' }, t('pickerEmpty'))
                : null,
            ),
        h('div', { className: 'pb-hint' }, t('pickerOnlyJson')),
      )
    }

    /**
     * 一行日志的可读文本。
     * @param {object} entry 日志条目
     * @param {(key: string) => string} t 翻译函数
     * @returns {string} 文本
     */
    function describeLogLine(entry, t) {
      const at = formatTime(entry.at)
      const action = entry.action === undefined ? '' : entry.action
      const mark = entry.ok === true ? '✓' : entry.ok === false ? '✗' : '·'
      const detail =
        entry.detail !== undefined
          ? entry.detail
          : entry.message !== undefined
            ? entry.message
            : entry.count !== undefined
              ? `${entry.count} ${t('plugins')}`
              : entry.file !== undefined
                ? entry.file
                : ''
      return `${at} ${mark} ${action} ${detail}`.trim()
    }

    // ── 插件装配 ──────────────────────────────────────────────────────────

    /**
     * 浏览器半侧插件定义。
     * @param {object} ctx Client 上下文
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'plugin-backup: dictionaries')
      // 样式表带上插件标记，卸载时随 ctx.effect 一起移除
      ctx.effect(() => {
        if (typeof document === 'undefined') return () => {}
        const tag = document.createElement('style')
        tag.dataset.plugin = NS
        tag.dataset.pluginCss = `${NS}/panel.css`
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => {
          tag.remove()
        }
      }, 'plugin-backup: styles')
      const t = ctx.locale.bind(NS)

      /**
       * 原生目录选择器（可选）。
       * 宿主没提供这个服务、或调用失败时返回 undefined —— 手动输入路径始终可用，
       * 不能因为"挑目录"这个便利功能让整个面板不可用。
       * @returns {Promise<string | undefined>} 选中的目录，或 undefined
       */
      const pickDirectory = async () => {
        try {
          const workspace = ctx.get === undefined ? undefined : ctx.get('uiWorkspace')
          if (workspace === undefined || typeof workspace.pickDirectory !== 'function') return undefined
          const picked = await workspace.pickDirectory()
          return typeof picked === 'string' && picked.trim() !== '' ? picked : undefined
        } catch {
          return undefined
        }
      }

      ctx.slots.inject('settings.plugins.tab', () =>
        ctx.slots.register(
          {
            name: 'settings.plugins.tab',
            id: NS,
            order: 70,
            label: () => t('nav'),
            locale: NS,
            inject: () => ({ t }),
          },
          (ownerProps) =>
            h(BackupPanel, {
              t: ownerProps !== null && typeof ownerProps === 'object' && typeof ownerProps.t === 'function' ? ownerProps.t : t,
              pickDirectory,
            }),
        ),
      )
    }

    return {
      name: NS,
      inject: ['slots', 'locale'],
      apply,
    }
  },
})
