# 插件备份与恢复（dsh-plugin-backup）

DSH 更新后插件被清掉、被禁用或版本漂移时，用这份清单**一键恢复全部历史插件**，不必逐个重新下载。

## 它做什么

1. **备份**：把当前 profile 已安装的插件（包名、精确版本、安装来源 spec、每个插件行的启用状态）
   写成可读 JSON，落在 **profile 目录之外**：
   `C:\Users\<你>\.dsh\plugin-backup\latest.json`
   因此 DSH 升级、profile 重建、插件目录被替换都不会清掉它。
2. **检测**：Harness 更新后对比"备份 vs 当前"，列出五类差异：
   | 差异 | 含义 |
   | --- | --- |
   | `missing` | 备份里有，现在完全没装 |
   | `version-mismatch` | 装了，但版本和备份不同 |
   | `disabled` | 装了，但整个 bundle 被禁用 |
   | `row-disabled` | bundle 在，个别插件行被禁用 |
   | `row-missing` | 该插件行在当前 profile 里不存在 |
3. **恢复**：在界面上勾选后一键恢复，走 Harness 官方插件安装接口
   （`pluginManager.installBundle` / `removeBundle` / `setBundleEnabled` / `setPluginEnabled`）。

## 怎么用

安装后打开 **设置 → 插件 → 「备份与恢复」** 页，从上到下是六块：

- **顶部** — 上次备份时间、插件数量、当前安装数量、备份目录；「立即备份」「刷新」。
  （启动时也会自动备份：清单变了、或距上次超过一天。）
- **备份存储位置** — 把备份目录指到 `.dsh` **之外**（见下节）。
- **从指定 JSON 文件恢复** — 指定任意一份清单 JSON（移动硬盘/网盘里的旧备份、自己手写的都行），
  按它恢复，不改变上面的备份位置。
- **已备份的插件** — 快照里到底备份了哪些插件，一行一个：插件名、备份时的版本、
  当前状态（`已安装` / `未安装` / `版本不同` / `已禁用` / `部分异常`），以及备份时的插件行数。
  **即使当前一切正常、没有任何差异，这份清单也照样完整显示**——这是"我到底备份了什么"的答案。
  没有安装来源的插件在这里会标出「无安装来源，需手工安装」。
- **检测到的差异** — 只有出问题的项，逐个带说明；默认全选，可勾选后「恢复所选」。
- **日志** — 每次备份/恢复/单项结果都记在每个备份目录下的 `log.jsonl`。

恢复前会二次确认，逐个插件执行并实时显示进度。

也可以直接问 Agent：`plugin_backup` 工具支持 `status`（位置 + 已备份清单 + 差异）、
`backup`（落快照）、以及可选参数 `file`（读某一份指定清单）。
**恢复是安装包的动作，只保留为用户在界面上的显式操作**，工具不会安装任何东西。

## 把备份放到 .dsh 之外（重要）

Harness 更新有可能重置整个 `.dsh`。默认把清单放在 `.dsh` 里，等于**备份和要被备份的东西
放在同一个篮子里**。所以存储位置是可配置的：

1. **界面** — 「备份存储位置」→「更改位置」→ 填一个新目录（如 `D:\dsh-backups`）→「保存位置」。
   保存前会真的写一个探测文件验证目录可写，不可写直接拒绝。
2. **环境变量** — 设 `DSH_PLUGIN_BACKUP_DIR=D:\dsh-backups` 后重启 DSH。优先级最高。

优先级：`DSH_PLUGIN_BACKUP_DIR` > `.dsh` 里的 settings.json > 主目录镜像 > 默认目录。

### 位置指针本身也会被重置，所以存两份

只把指针存在 `.dsh` 里有一个陷阱：升级重置 `.dsh` 时，指针和默认位置的备份一起没了，
插件会**静默退回默认目录**，看起来就像"备份全丢了"——其实外部目录里的快照还好好的。

所以位置记录写两份：

| 文件 | 作用 |
| --- | --- |
| `$DSH_HOME/plugin-backup/settings.json` | 正式记录 |
| `~/.dsh-plugin-backup-location.json` | 主目录镜像，**.dsh 被重置后靠它找回目录** |

界面看到来源标为「自定义（靠主目录镜像找回）」时，说明 `.dsh` 被重置过：
备份没丢，点一次「保存位置」把正式记录补回去即可。

### 指定任意 JSON 文件恢复

「从指定 JSON 文件恢复」里可以直接填路径，也可以点「选择文件…」。

**「选择文件…」打开的是系统原生的文件对话框** —— 就是你熟悉的 Windows「打开」窗口：
可自由切换盘符、进「此电脑」、用左侧快速访问和收藏夹，默认只列 `.json`
（过滤器同时保留「所有文件」，以防你手上有别的扩展名）。

为什么没复用 Harness 自带的选择器：它的 `directoryPicker` 走 Win32 COM `IFileOpenDialog`，
但把 options 硬编码成 `104`（`FOS_PICKFOLDERS | FORCEFILESYSTEM | PATHMUSTEXIST`），
**只能选文件夹**。所以插件自己拉起同一个系统对话框（.NET `OpenFileDialog`），
去掉 PICKFOLDERS，得到的就是标准文件选择。

实现上的几个坑（都已验证并写成测试）：

- 对话框跑在独立 PowerShell 子进程里 —— 宿主进程没有消息循环，直接开窗会挂住。
- 脚本内容**必须纯 ASCII**：Windows PowerShell 5.1 按系统 ANSI 代码页读 `.ps1`，
  脚本里有中文会被解析坏，表现为「对话框弹出但永远不返回结果」。中文标题经环境变量传入。
- 写 `.ps1` 时带 UTF-8 BOM，这是 5.1 识别 UTF-8 的唯一可靠方式。
- 选中的路径经 **UTF-8 文件**回传而不是 stdout，否则中文路径乱码
  （实测 `D:\dsh\扩展记录插件` 曾变成 `D:\dsh\��չ��¼���`）。
- 非 Windows / 没有 PowerShell 时，自动退回内置 `.json` 浏览器。

选定后自动读取并预览（不落盘、不改设置），确认插件清单和差异后再「恢复所选」。

- 文件不必在备份目录里，名字也不必叫 `latest.json`。
- 接受两种格式：标准快照 `{ "bundles": [ ... ] }`，或直接一个插件数组 `[ { "name": ..., "version": ... } ]`。
- 每条只需 `name`；`version` 决定重装到哪个版本，`source` 决定从哪儿装（缺 `source` 会标"无安装来源"）。
- 坏文件（不存在 / 不是 JSON / 缺 `bundles` / 传了目录）都会明确报错，不会静默失败。

内置浏览器是兜底路径（原生对话框不可用时）：Host 列目录、界面渲染，只显示 `.json`，
子目录可进、面包屑可回跳，隐藏文件与 `node_modules` 跳过。

## 设计上的几个约定

- **备份位置在 profile 之外，且可配置**：默认 `$DSH_HOME/plugin-backup/`，建议改到 `.dsh` 外。
  快照按时间戳保留最多 20 份。
- **界面展示的是"清单"而不只是"差异"**：`/status` 除差异外还返回 `backedUp`——快照里每个插件的
  名称、版本、行数、当前状态、能否自动恢复。没有差异时页面也不会变成一片空白。
- **不记录 DSH 安装自带的 bundle**（`availability: 'installation'`）：它们随 DSH 升级自己会回来，
  记进来只会在恢复时制造无意义的失败。
- **恢复钉到备份时的精确版本**：注册表包写成 `包名@精确版本`，保证"恢复成原来那份"，
  而不是悄悄升到 latest。git / tarball / 本地目录来源按原样重装。
- **没有安装来源就不猜**：`source` 是唯一能说明包从哪儿来的信息。缺失时**不会**凭版本号
  拼一个 `包名@版本` 去装——那会把本机自建/手工放置的包（例如 `dsh-ua-proxy`）当成 npm 包，
  报出误导性的 `not-found`。这种情况明确提示"清单里没有安装来源"，交给用户手工处理。
- **幂等**：每一步先读当前真实状态，已满足就跳过；`already-installed` 时按官方插件页同样的两步法
  （先 `removeBundle` 再装）。重复点恢复不会产生重复安装。
- **失败不中断**：任一项失败只记录日志并继续下一项，结束时给出成功/失败汇总。
- **不代批安装脚本**：遇到 `pendingBuilds` 会停下来，提示你去「设置 → 插件」自行确认，插件不替你批准。
- **只写自己的文件**：备份目录、`.dsh/plugin-backup/settings.json`、`~/.dsh-plugin-backup-location.json`；
  不改 `package.json` / `cordis.patch.yml`。
- **请求有同源围栏**：HTTP 路由复用宿主自己的 `connection.requestRejection`，任意网页无法触发本机安装。
- **零依赖**：只用 node 内置模块 + 宿主提供的 `pluginManager` / `webServer` / `tools` 服务，
  不 require 任何 Harness Client 包，降低版本差异导致的加载失败风险。

## 快照格式

```json
{
  "schemaVersion": 1,
  "createdAt": "2026-10-20T06:12:19.508Z",
  "dshVersion": "0.2.1-rc.2",
  "profile": "desktop",
  "bundles": [
    {
      "name": "dsh-better-sidebar",
      "version": "0.28.0",
      "source": "dsh-better-sidebar@^0.28.0",
      "enabled": true,
      "rows": [
        { "rowId": "better-sidebar", "moduleName": "dsh-better-sidebar", "entryId": "include:better-sidebar", "enabled": true }
      ]
    }
  ]
}
```

- `schemaVersion` 变了说明字段结构有调整，读取方按版本兼容。
- `source` 是 pnpm 记录的依赖值；`installTarget`（官方目录条目才会有）优先于它。
- 手动修清单后可以直接重新恢复——这是刻意设计的"用户可修正"通道。

## 排障

| 现象 | 处理 |
| --- | --- |
| 差异里某插件没有"安装来源" | 该条 `source`/`version` 都缺；手工装上后在界面点「立即备份」刷新清单 |
| 恢复提示"安装脚本待批准" | 去「设置 → 插件」批准该包的 build script，再回来重试 |
| 恢复提示"与当前 DSH 版本不兼容" | 该插件版本不支持当前 DSH；等插件更新，或在插件页显式授予版本豁免 |
| 恢复后提示"重启后生效" | `restart-required` 属正常：该包替换了已加载模块，重启 DSH 后生效 |
| 想恢复某个已删掉的插件 | 快照里还留着它——只要没超过 20 份快照的保留窗口，勾上恢复即可 |

## 文件

```text
index.js            宿主半侧：清单采集 / 位置配置 / 差异计算 / 恢复编排 / HTTP 路由 / plugin_backup 工具
client.js           浏览器半侧：设置→插件里的「备份与恢复」页
cordis.patch.yml    bundle 行声明（id: plugin-backup）
locale/{en,zh}.json 插件列表里的标题与描述
icon.svg            插件图标
```

## HTTP 接口

浏览器半侧用到的（都是同源 POST + JSON）：

| 方法 | 作用 |
| --- | --- |
| `status` | 位置信息 + 已备份清单 + 当前安装 + 差异 + 恢复进度 + 日志；可选 `{ sourceFile }` |
| `backup` | 立即备份到当前目录 |
| `restore` | 按勾选恢复；可选 `{ sourceFile }` 从指定清单恢复 |
| `settings` | 无参读取位置；`{ backupDir }` 改位置（空串=恢复默认） |
| `load-file` | 只读预览一份指定清单 `{ file }`，不落盘不改设置 |
| `pick-file` | 拉起系统原生文件对话框选 `.json`；不支持时回 `unsupported` |
| `list-files` | 列目录供内置浏览器用 `{ dir }`；只回 `.json` 文件与子目录 |
| `log` | 最近日志 |

## 开发期验证

```bash
node .tools/verify-host.mjs          # 宿主行为：备份/差异/恢复/两步法/改目录/指定文件/列目录/无 .tmp 残留，共 15 组
node .tools/verify-client.mjs        # 浏览器半侧：模块注册、字典、槽位、面板渲染、原生/兜底两条选文件路径
node .tools/verify-meta.mjs          # 展示元数据：locale/icon 可被宿主解析
node .tools/verify-live.mjs          # 真实快照与 profile 现状的一致性
node .tools/verify-external.mjs      # 外部目录 + .dsh 重置 + 指定文件恢复的端到端
node .tools/verify-browse-live.mjs   # 内置浏览器读真实备份目录时看到的项
node .tools/verify-script-ascii.mjs  # 原生对话框脚本纯 ASCII + BOM/W 编码约束
node .tools/verify-native-picker.mjs # 真拉起系统文件对话框并自动选中（会弹窗，需桌面会话）
```

> 测试全部把 `DSH_HOME` 与 `DSH_PLUGIN_BACKUP_MIRROR` 指向临时目录，
> 不会碰你真实的 `~/.dsh` 和主目录指针。
