# Factory Switch

在本机备份并切换 Factory 桌面版（和命令行 `droid`）的登录账号，切换后左侧会话仍然可见。

## 下载安装

在 [GitHub Releases](https://github.com/yuanzhixiang/factory-switch/releases) 下载适用于 Apple Silicon（M 系列 Mac）的 DMG，将 `Factory Switch.app` 拖到 `Applications`。也提供 ZIP，解压后将应用移入 `Applications` 即可。

应用未签名、未公证。首次打开如被 macOS 拦截，请在确认下载来源后到「系统设置 → 隐私与安全性」允许打开。发布附件中的 `SHA256SUMS.txt` 可用于校验文件完整性。

## 使用

```bash
pnpm install
pnpm start        # 开发运行
pnpm dist         # 打包成 release/mac-arm64/Factory Switch.app
pnpm dist:release # 打包 Apple Silicon 的 DMG 和 ZIP，不自动上传
pnpm test         # 核心逻辑测试，只用临时目录，不碰真实 ~/.factory
pnpm test -- test/cursor-migration.test.ts # Cursor 合成数据库迁移实验，需要 Node.js 24
pnpm icon         # 改了 build/icon.svg 后重新生成 build/icon.icns，需要 rsvg-convert
```

添加新账号：「备份当前账号」→「删除本地凭证」→ 在 Factory 登录新号 → 回来再点「备份当前账号」。之后在左侧选中账号，点「切换到此账号」。

查看其他账号的用量：登录那个账号后在 app.factory.ai/settings/api-keys 创建一个 API Key，切回来后在该账号详情页「设置 API Key」。当前登录的账号不需要 Key。

关闭窗口后程序继续在后台查询用量和发通知；从 Dock 图标重新打开窗口，Cmd+Q 才真正退出。

## Factory 的本地数据（逆向得到，Factory 升级后可能变化）

- 凭证：`~/.factory/auth.v2.loginkeychain`，格式 `iv:tag:密文`（均 base64），AES-256-GCM。明文 JSON 含 `access_token`（JWT）、`refresh_token`、`active_organization_id`。
- 密钥：钥匙串 service `Factory CLI`、account `auth-encryption-key-security-cli`，值是 base64 的 32 字节。所有账号共用同一把密钥，所以备份凭证文件即可。
- 账号身份：JWT 的 `sub` 是用户 ID，`active_organization_id`（等于 JWT 的 `external_org_id`）是 Factory 组织 ID。
- `org-managed-settings.cache.json(.backup)`：按组织缓存的管理设置，跟着账号一起备份和换入。
- Factory 运行时会刷新 token 并重写凭证文件（启动时、运行中都会），所以凭证必须在 Factory 和 `droid daemon` 都退出后再替换。
- 会话：`~/.factory/sessions/<项目目录>/<id>.jsonl`，首行 `session_start` 带 `organizationId`。左侧列表读 `~/.factory/cache/session-index/index.db`，可见规则是 `org_id IS NULL OR org_id = 当前组织`。索引更新时新值为空会保留旧值，所以去掉会话文件的标记后必须让索引重建。

## 行为

### Factory / Cursor 页面

- 左侧顶部的 Factory / Cursor 按钮切换页面，并记住上次选择。Factory 的账号操作、用量查询和通知保持原有流程；修改操作进行中不可切页，点击 Factory 通知会返回 Factory 账号详情。
- Cursor 页面提供账号列表、详情、共享会话区块和添加/切换流程预览。默认显示空状态；点击「查看布局示例」显示使用 `.invalid` 邮箱的合成账号，所有示例状态明确标注，关闭页面后示例不保留。
- Cursor 页面没有文件访问或 IPC 操作，不读取真实 Cursor 的账号、进程或会话；添加账号、登录和切换仅打开说明弹窗，实际操作按钮禁用，不创建目录或退出 Cursor。

### Cursor 会话迁移实验（仅测试）

- `test/cursor-migration.test.ts` 在系统临时目录创建来源账号和目标账号的全局、工作区数据库，使用合成凭证、消息和检查点，不读取或修改真实 Cursor 数据，不启动或退出 Cursor。
- 表结构参考本机 Cursor 3.24.12：全局 `ItemTable` 保存账号状态，`cursorDiskKV` 保存会话记录，`composerHeaders` 保存列表与工作区关联。实验记录中的 `refs` 引用清单和工作区入口内容由测试定义。
- 从清单收集一条会话的依赖闭包，逐字节复制消息、检查点、Agent 状态和二进制内容，合并会话列表及工作区入口；目标原有会话保留，全局账号状态及其他工作区字段不变。
- 缺失引用、白名单之外的引用、缺少工作区入口均拒绝迁移；同键不同内容拒绝覆盖，重复导入不产生重复记录。写入异常时事务回滚；写入前使用 SQLite backup 保存包含 WAL 最新数据的快照。
- 该实验不接入应用界面或生产操作，也没有独立账号目录启动器。测试结束关闭连接并删除临时目录。

### 备份当前账号

读取并解密当前凭证得到身份，把这一份内容（不重新读，避免读写之间被 Factory 刷新）连同组织缓存存到 `~/.factory-switch/accounts/<userId>__<orgId>/`。首次备份要起名字，已备份过的直接覆盖更新并沿用原名。不需要退出 Factory。

### 删除本地凭证

1. 退出 Factory，等主进程和 daemon 都退出，最多 20 秒，超时中止且不改文件。
2. 结束其余所有 `droid` 进程（见下文「结束 droid 进程」）。
3. 当前账号已备份的话，先用退出后的最新凭证更新备份。
4. 凭证和组织缓存移到 `~/.factory-switch/backups/<时间>-delete-credentials/`，没备份过的账号也能从这里找回。
5. 去掉会话组织标记、清掉会话索引和账号相关缓存（见下文），然后重新打开 Factory。

不调用 Factory 的「登出」，所以服务端 token 不会被吊销，备份一直可用。

### 切换

1. 先校验目标备份能解密且身份与记录一致；目标就是当前账号时什么都不做。
2. 当前账号没备份就拒绝，且不退出 Factory。
3. 退出 Factory，结束其余所有 `droid` 进程，把当前账号最新凭证存回它的备份（防止 refresh token 轮换后旧备份失效）。
4. 处理会话，再换入目标账号文件（凭证最后写），记录使用时间，重新打开 Factory。

### 结束 droid 进程

- 桌面版每个会话都由 daemon 启动一个 `droid exec --input-format stream-jsonrpc` 进程，Factory 退出时它们可能残留；终端里开的 `droid` 也会继续用旧 token 并可能写回凭证。
- 所以 Factory 和 daemon 退出后，所有可执行文件名是 `droid` 的进程都会被结束，不再询问：先发 SIGTERM，5 秒内没退出再发 SIGKILL。必须在 Factory 退出后做，否则 daemon 会重新拉起会话进程。
- 仍有进程结束不了（比如属于别的用户）就中止，不换凭证，并列出这些进程；此时 Factory 已退出，可手动重新打开。

### 会话处理

- 所有会话文件首行去掉 `organizationId`，原文件先备份到本次操作的备份目录；写回后恢复原修改时间，列表排序不变。
- `cache/session-index/index.db*`、`cache/feature-flags.json`、`cache/connector-tool-catalogs` 移到备份目录，Factory 启动时重建。
- 这只影响本机列表；云端会话列表仍按组织区分。

### 用量

- 接口：`GET https://api.factory.ai/api/billing/limits`，`Authorization: Bearer <access token 或 API Key>`。这是 Factory 自己设置页用的接口，不在公开文档里。返回 Standard 和 Droid Core 两个额度池，各自有 5 小时、每周、每月的 `usedPercent` 和 `windowEnd`，另有超额余额和超额策略。
- 当前登录的账号用本地凭证里的 access token 查；查失败或其他账号用该账号保存的 API Key 查。都没有就显示「还没有设置 API Key」。
- 每 30 秒查一次所有账号，单次超时 10 秒；有切换、删除等操作进行中时跳过这一轮。查询失败时保留上一次数据并显示错误和数据时间。
- 周期结束时间已过的按 0% 显示。70% 起进度条和侧边栏数字变黄橙，100% 变红。
- 侧边栏每个账号右边显示 Standard 池的 5 小时使用率。
- 侧边栏顶部「全部账号」进入汇总页，整页共用一个 Standard / Droid Core 切换：
  - 最上面是当前登录账号的 5 小时、每周、每月用量，和账号详情页一样；没登录时不显示这一块。
  - 「全部账号合计」把所有查到用量的账号的每周、每月用量分别直接相加，显示总额度使用率（相加后除以账号数）、已用多少个账号的额度、最早一个重置的倒计时，以及 Extra Usage 合计。5 小时周期太短且各账号不同步，不做合计。侧边栏这一行显示 Standard 池的合计月度使用率。
  - 下方明细表列出各账号三个周期的用量，点击一行跳到该账号详情；行尾当前账号显示「当前登录」，其他已备份账号有「切换」按钮，确认后和详情页的「切换到此账号」走同一流程，操作进行中按钮不可点。没查到用量的账号显示「—」，不计入合计。
- API Key 保存前会先查一次用量，查不到就不保存，弹窗保留并显示原因。Key 以 `fk-` 开头，存在账号目录的 `api-key` 文件（权限 600），页面只拿到末四位。

### 通知

只看 Standard 池的 5 小时用量，阈值 70%：

- 当前登录的账号从 70% 以下涨到 70% 及以上：提醒换号。
- 其他账号从 70% 及以上回落到 70% 以下（含周期结束重置）：提醒可以切过去。
- 程序启动后第一次查到的数据、查询失败沿用的旧数据都不触发通知。点通知会打开窗口并选中对应账号。

### 安全约束

- token 和 API Key 只在主进程里使用，页面只拿到邮箱、名字、用户 ID、组织 ID 和 Key 末四位。
- 所有写入都是临时文件加改名，权限 600；删除操作都是移进 `~/.factory-switch/backups`，不直接删。
- 同一时间只允许一个修改操作。

## 已知限制

- Cursor 页面目前是界面预览，尚不能添加、登录或切换账号，也不查询用量和执行会话同步。侧边栏和页脚不代表真实 Cursor 运行状态。
- Cursor 实验只证明合成夹具的完整迁移及目标本地账号状态不变，不证明真实 Cursor 能加载、续聊或保持服务端登录有效。真实引用格式、外部附件、云端资源、搜索索引、子会话和跨版本兼容性仍需验证；实验白名单不能直接用于真实数据。
- Cursor 实验覆盖普通异常下两份目标数据库的事务回滚，不保证 WAL 模式下跨数据库的断电原子性；正式实现需要崩溃恢复日志和更完整的冲突处理。
- 依赖逆向得到的文件格式，Factory 升级改了存储方式后读身份会失败，界面显示「读不出当前凭证」。
- 重装 Factory 若换了钥匙串密钥，所有备份都会解不开。
- 程序没签名，首次打开需要在 Finder 里右键「打开」。
- 用量接口不是公开接口，Factory 改了路径或返回格式后用量会查不到；API Key 能查用量是按接口行为推断的（无效 Key 返回 401 而不是格式错误），以实际设置结果为准。
- Factory 打开或新建会话时会重新给会话写上组织标记，所以每次切换都会重新去一遍标记。
- 切换和删除本地凭证会直接结束终端里正在运行的 `droid`，里面进行中的任务会中断。
- 汇总页假设各账号的每周、每月额度一样大，额度不同的账号直接相加百分比会有偏差。
