# Factory Switch

在本机备份并切换 Factory 桌面版（和命令行 `droid`）的登录账号，切换后左侧会话仍然可见。

## 使用

```bash
pnpm install
pnpm start        # 开发运行
pnpm dist         # 打包成 release/mac-arm64/Factory Switch.app
pnpm test         # 核心逻辑测试，只用临时目录，不碰真实 ~/.factory
```

添加新账号：「备份当前账号」→「删除本地凭证」→ 在 Factory 登录新号 → 回来再点「备份当前账号」。之后在列表里点「切换」。

## Factory 的本地数据（逆向得到，Factory 升级后可能变化）

- 凭证：`~/.factory/auth.v2.loginkeychain`，格式 `iv:tag:密文`（均 base64），AES-256-GCM。明文 JSON 含 `access_token`（JWT）、`refresh_token`、`active_organization_id`。
- 密钥：钥匙串 service `Factory CLI`、account `auth-encryption-key-security-cli`，值是 base64 的 32 字节。所有账号共用同一把密钥，所以备份凭证文件即可。
- 账号身份：JWT 的 `sub` 是用户 ID，`active_organization_id`（等于 JWT 的 `external_org_id`）是 Factory 组织 ID。
- `org-managed-settings.cache.json(.backup)`：按组织缓存的管理设置，跟着账号一起备份和换入。
- Factory 运行时会刷新 token 并重写凭证文件（启动时、运行中都会），所以凭证必须在 Factory 和 `droid daemon` 都退出后再替换。
- 会话：`~/.factory/sessions/<项目目录>/<id>.jsonl`，首行 `session_start` 带 `organizationId`。左侧列表读 `~/.factory/cache/session-index/index.db`，可见规则是 `org_id IS NULL OR org_id = 当前组织`。索引更新时新值为空会保留旧值，所以去掉会话文件的标记后必须让索引重建。

## 行为

### 备份当前账号

读取并解密当前凭证得到身份，把这一份内容（不重新读，避免读写之间被 Factory 刷新）连同组织缓存存到 `~/.factory-switch/accounts/<userId>__<orgId>/`。首次备份要起名字，已备份过的直接覆盖更新并沿用原名。不需要退出 Factory。

### 删除本地凭证

1. 终端里还有 `droid` 进程就拒绝（它会继续用旧 token 并可能写回凭证）。
2. 退出 Factory，等主进程和 daemon 都退出，最多 20 秒，超时中止且不改文件。
3. 当前账号已备份的话，先用退出后的最新凭证更新备份。
4. 凭证和组织缓存移到 `~/.factory-switch/backups/<时间>-delete-credentials/`，没备份过的账号也能从这里找回。
5. 去掉会话组织标记、清掉会话索引和账号相关缓存（见下文），然后重新打开 Factory。

不调用 Factory 的「登出」，所以服务端 token 不会被吊销，备份一直可用。

### 切换

1. 先校验目标备份能解密且身份与记录一致；目标就是当前账号时什么都不做。
2. 当前账号没备份就拒绝，且不退出 Factory。
3. 检查终端 `droid`，退出 Factory，把当前账号最新凭证存回它的备份（防止 refresh token 轮换后旧备份失效）。
4. 处理会话，再换入目标账号文件（凭证最后写），记录使用时间，重新打开 Factory。

### 会话处理

- 所有会话文件首行去掉 `organizationId`，原文件先备份到本次操作的备份目录；写回后恢复原修改时间，列表排序不变。
- `cache/session-index/index.db*`、`cache/feature-flags.json`、`cache/connector-tool-catalogs` 移到备份目录，Factory 启动时重建。
- 这只影响本机列表；云端会话列表仍按组织区分。

### 安全约束

- token 只在主进程内存里解密使用，页面只拿到邮箱、名字、用户 ID、组织 ID。
- 所有写入都是临时文件加改名，权限 600；删除操作都是移进 `~/.factory-switch/backups`，不直接删。
- 同一时间只允许一个修改操作。

## 已知限制

- 依赖逆向得到的文件格式，Factory 升级改了存储方式后读身份会失败，界面显示「读不出当前凭证」。
- 重装 Factory 若换了钥匙串密钥，所有备份都会解不开。
- 程序没签名，首次打开需要在 Finder 里右键「打开」。
