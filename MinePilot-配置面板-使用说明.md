# MinePilot 配置面板 —— 使用说明

> 结论先说：**MinePilot 模组本身没有任何 Web 面板**（源码里只有 `mcp/LoopbackMcpServer.java` 一个回环 MCP，`grep -rn "HttpServer\|WebSocket\|text/html\|/api/"` 只命中它）。
> 所以已经**从零新建并部署了一个**：容器 `mcai-panel`，端口 **25800**。

---

## 1. 怎么访问

| 项 | 值 |
|---|---|
| 地址 | **http://<SERVER_IP>:25800** |
| 鉴权 | 需要令牌（`X-Panel-Token` 头或 `?token=`） |
| 令牌 | 48 字符，本地存 `panel_token.txt`（部署时随交付物提供） |
| 容器 | `mcai-panel`（`node:22-alpine`，`restart: unless-stopped`） |
| 部署目录 | `<COMPOSE_DIR>/`（Docker Compose 项目目录） |

首次打开会看到令牌闸门（`#gate`），把 `panel_token.txt` 的内容粘进去即可。从此令牌记在浏览器本地，右上角有「退出」清除。

> 直接走私网 IP + 端口，未做反代/HTTPS。**25800 不要直接暴露到公网**（面板挂了 `docker.sock`，等于给了宿主 Docker 控制权）。

---

## 2. 面板有 6 个页签

顶部状态区常驻：**两个状态点**（`dotMc` = mc-server 是否 running、`dotAi` = AI bot `MCAI` 是否在线）、**在线玩家**（RCON `list` 实时）、**容器信息**、**自动刷新开关**。

### ① AI 配置页（写 `config/mcai-companion.toml`）
| 卡片 | 字段 | 说明 |
|---|---|---|
| 模型连接 | `baseUrl` / `name` / `soft` / `hard` | 模型地址、模型名、软/硬超时 |
| API Key | （只写不回显） | 写 `secrets/mcai-api-key`，只显示字节数/字符数/权限位 |
| MCP | `mcpEnabled` / `mcpPort` | 是否开 MCP、端口 |
| 权限白名单 | `chatAllowed` / `waypointAllowed` | **UUID 列表**，逗号分隔 |
| 皮肤 | `skinAuto` / `skinArm` | 自动导入 `config/mcai-companion/skin.png`、`CLASSIC`/`SLIM` |

动作按钮：**保存并重启（推荐）**（停止→写→启动，故意顺序，Forge 退出会刷回旧值）、仅保存（不生效，Forge 启动读一次）、仅重启、停止/启动、**测试模型连接**。长任务走后台 job，一次一个。

### ② 服务器设置页（读/写 `server.properties`）
- **66 个属性**分 5 组渲染，每个都是带类型的控件（布尔/枚举/数字/文本）。
- **🔒 徽标 = compose 接管键**（7 个）：当前值来自 `docker-compose.yml` 环境变量，容器每次启动会覆盖 properties。`gamemode`←`MODE`、`online-mode`←`ONLINE_MODE`、`white-list`←`WHITELIST_PROP`、`difficulty`←`DIFFICULTY`、`enable-rcon`←`ENABLE_RCON`、`simulation-distance`←`SIMULATION_DISTANCE`、`view-distance`←`VIEW_DISTANCE`、`rcon.password`←`RCON_PASSWORD`。
  - 改这类键**必须勾「同步到 compose」**，面板会同时改 properties 和 compose（之后 `docker compose up -d mc-server` 重建生效）；不勾会被后端拒绝。
  - 或点某行🔒后「交给 properties 管」按钮，把 compose 那个环境变量注释掉，之后完全由 properties 管理。
- **密钥键不回显**（`rcon.password` 等显示 `••••••••` 且禁用），改密走「⑤ 密码与令牌」页。
- 底部：**保存属性并重启 / 仅保存属性**（+ 同步 compose 复选框）。

### ③ 运行时控制页（RCON 实时，无需重启）
- **天气**：晴 / 雨 / 雷（可带秒数）。
- **时间**：`day` / `noon` / `night` / `midnight` / 自定义 tick / **冻结与恢复**。
- **游戏模式**：选在线玩家一键切换（生存/创造/冒险/旁观）。
- **难度**：peaceful / easy / normal / hard。
- **广播** `say`：向全服玩家发消息。
- **44 条 gamerule 目录**（中文标签，按天气/生存/刷怪/掉落/命令/提示/性能分组）—— 打开即批量拉取当前值，改动点「应用」即时生效。
  - ⚠️ **MC 26.2 规则名全 snake_case**：旧驼峰名（`keepInventory`/`mobGriefing`…）全部失效，面板用的是新名（`keep_inventory`/`mob_griefing`/`random_tick_speed`/`advance_weather`）。
- 面板**不提供任意命令输入框**（挂 docker.sock，安全性考虑）—— 所有操作都走服务端白名单 `buildRconCommand()`（weather/time/timeFreeze/gamerule/gamemode/defaultgamemode/difficulty/say/op/deop/pardon/kick/ban/whitelist/whitelistToggle/banlist/query），参数逐项正则校验防注入。

### ④ 玩家管理页
- **在线玩家**：实时列出**用户名 + UUID**（来自 `/list uuids`），并自动区分 **AI bot**（`MCAI`，UUID 与离线算法不符 = mod 自建无头玩家）与**真人**（如 `DC`，离线 UUID 算法匹配）。点击可复制 UUID；每行可**切换模式 / 授予 OP / 踢出**。
- **OP 列表**：`op` / `deop`（即时生效，无需重启）。
- **白名单**：实时 `whitelist list`，可 add / remove / 一键开关（`white-list`）。
- **封禁**：`ban`（带理由）/ `pardon`，可看当前封禁名单。

### ⑤ 密码与令牌页
- **面板令牌**：改密 / **随机生成 48 位**。改动即时生效，并同步写 compose 的 `PANEL_TOKEN`。
- **RCON 密码**：改密 / **随机生成 24 位**。同步写 `server.properties` + compose 的 `mc-server.RCON_PASSWORD` 与 `mcai-panel.MC_RCON_PASSWORD` **三处**。
- 顶部显示 RCON 地址、各密码/令牌长度。**所有密钥一律不回显**（页面只显示 `••••••••`）。

### ⑥ 日志页
容器日志尾部 + 关键词过滤框（去 ANSI 颜色 / 进度覆盖残留）。

---

## 3. 后端接口一览

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/` | 返回 `index.html`（**无需鉴权**） |
| GET | `/api/ping` | `{ok, authRequired}`（**无需鉴权**） |
| GET | `/api/state` | 容器状态 + 在线玩家 + 配置 + 密钥元信息 + 日志 + 当前 job（**鉴权**） |
| GET | `/api/job` | 当前 job 进度 |
| GET | `/api/server` | `server.properties` 全量（分组 + 类型 + `managedBy` + 密钥掩码） |
| POST | `/api/props` | 校验并写 properties（被接管键未同步即拒绝；密钥键拒绝走此路） |
| POST | `/api/rcon` | 白名单动作 / `gameruleQuery` / `rconPasswordPeek` |
| POST | `/api/vault` | 改面板令牌 / 改 RCON 密码（同时写 properties 与 compose） |
| POST | `/api/compose/takeover` | 注释掉 compose 里某个接管环境变量 |
| POST | `/api/config` | 校验并写 toml（不重启） |
| POST | `/api/apikey` | 写 API Key 文件 |
| POST | `/api/apply` | 后台任务：停止 → 写 config/apikey → 启动 |
| POST | `/api/action` | `{action: restart\|stop\|start}` |
| POST | `/api/test-model` | 模型连通性三连探测 |

鉴权：`crypto.timingSafeEqual` 定长比较，避免时序侧信道。

---

## 4. 实现要点（为什么这么写）

- **零依赖**：只用 `node:http/https/fs/path/net/crypto`，镜像直接复用 `node:22-alpine`，不需要 npm install，构建秒级。
- **TOML / properties 就地改写**：`setTomlValues()` / `setProps()` 只替换目标键那一行，**保留全部注释和排版**；缺键插到对应头之后，section 不存在才追加。不引第三方库 → 不把用户的注释吃掉。
- **docker.sock 直连 Docker Engine API**：`/_ping`、`/containers/<name>/json`、`/logs`、`/stop?t=`、`/start`。带 tty 的容器日志是裸文本，不带 tty 的是 8 字节帧头的流 → `demuxLogs()` 两种都处理。
- **RCON 自己实现**（不引库）：包格式 `[len:int32LE][id:int32LE][type:int32LE][body][0x00 0x00]`，`len` 覆盖 `id+type+body+2` ⇒ **总长 = 14 + body.length**。
  - 认证：先发 `type=3`；真实服务端会**先回一个空的 RESPONSE_VALUE 再回 AUTH_RESPONSE**，必须等到 `type=2` 才算认证。
  - 响应：`type=0 && id==2` 累积 body，**150ms 静默即认为结束**（RCON 无结束标记）。
  - **`rconBulk`**：单连接顺序跑 N 条命令，适合批量查 gamerule（10 条约 1.6s、44 条约 6.7s）。
- **CRLF 解析陷阱（重要）**：JS 正则 `.` 不匹配 `\r`，`(.*)$` 在 CRLF 文件上整行失配且静默返回 null。所有文件切行都走 `splitLines()`（`\r\n`→`\n` 归一化），保证 NAS 上 CRLF 的 `docker-compose.yml` / `server.properties` / toml 都能正确解析。
- **密钥不回显**：`apiKeyMeta()` 只返回元信息；`SECRET_PROPS`（`rcon.password` 等）在 API 响应中显示 `••••••••`，前端 input 一律 `disabled`，改密只能走「密码与令牌」页。

---

## 5. 安全说明（重要）

| 风险 | 说明 | 缓解 |
|---|---|---|
| **`docker.sock` 已挂进面板** | 等于把宿主 Docker 控制权给了这个容器。面板被攻破 → 可控制宿主机上**所有**容器 | 面板只在**内网**；令牌 48 字符随机；token 走 header，不进 URL 日志（除非用 `?token=` 分享） |
| **能 stop/start mc-server** | 这是刻意设计（配置要重启才生效），但也意味着误点会踢掉所有玩家 | 长任务串行 + 进度可见；「停止」是独立按钮不藏在保存里 |
| **RCON 面板** | 若开放了任意命令 = 远程 Root | **没有任意命令入口**，只有白名单动作 + 参数正则校验 |
| **HTTP 明文** | 内网明文传输，令牌在链路上可见 | 若要出公网，必须套 Nginx/Caddy + TLS + 额外认证 |
| **写 `mcai-api-key`** | 权限强制 0600、属主 1000:1000 | 校验长度 ≥8、拒换行 |

**回滚方式**：`docker compose rm -sf mcai-panel` 即可摘掉面板，`mc-server` 完全不受影响（面板是旁路，不碰 MC 进程）。

---

## 6. 部署 / 重部署

`docker-compose.yml` 里 `mcai-panel` 服务块（关键挂载）：

```yaml
mcai-panel:
  image: node:22-alpine
  container_name: mcai-panel
  restart: unless-stopped
  ports:
    - "25800:25800"
  volumes:
    - ./minecraft-data:/data                       # 面板读写 toml / api-key / properties
    - ./mcai-panel:/app:ro                         # 面板代码（只读挂载）
    - ./docker-compose.yml:/compose/docker-compose.yml   # 后端读接管检测（COMPOSE_PATH）
    - /var/run/docker.sock:/var/run/docker.sock    # 查状态/日志/stop/start
  environment:
    PANEL_PORT: "25800"
    PANEL_TOKEN: "<48 字符>"
    COMPOSE_PATH: "/compose/docker-compose.yml"
    MC_CONTAINER: "mc-server"
    MC_DATA_DIR: "/data"
    MC_RCON_HOST: "mc-server"
    MC_RCON_PORT: "25575"
    MC_RCON_PASSWORD: "<RCON_PASSWORD>"
    MC_UID: "1000"
    MC_GID: "1000"
    TZ: "Asia/Shanghai"
  command: ["node", "/app/server.js"]
```

更新面板代码（改完 `server.js` / `index.html` 后）：

```bash
# 上传到 <compose目录>/mcai-panel/ 后
docker restart mcai-panel        # 只读挂载 + 直接读文件，Node 不热重载，必须重启
# 若 compose 服务块本身改过，则 docker compose up -d mcai-panel
```

---

## 7. 自测

`mcai-panel/selftest.js`，**181 项断言全绿**，覆盖：
1. TOML / properties 解析、就地改写、**注释保留**、缺键插入。
2. 属性校验（bool/enum/int/text/secret，11 项）。
3. compose env 识别 / 改值 / 插入 / 注释 / 未知服务拒绝。
4. 写 properties + 同步 compose（含 validateOnly 预检、幂等跳过、非法拒绝）。
5. `readServerProps` 组装（69 键分组、`managedBy`、**掩码不泄露**）。
6. 玩家名单文件、**离线 UUID 算法**（DC/DCC 真实值）。
7. 命令构造白名单（30+ 项含注入拒绝）。
8. `rconBulk` 多包拼接与按序对应、`queryGamerules` 批量。
9. **CRLF 回归**（compose/properties/toml 三种文件 CRLF 下读写正确、不残留 `\r`）。
10. 改密（面板令牌 / RCON 密码校验 + compose 同步 + API 不泄露明文）。

跑法：`node mcai-panel/selftest.js`（需要 Node 22）。

---

## 8. 无头浏览器验证结果（2026-10-11 05:07，全绿）

`check_panel.cjs`（playwright-core 起 Chromium 访问面板地址 `http://<SERVER_IP>:25800/`），A~G 七段全 PASS、`ERRORS: none`：

- **A 基础**：令牌闸门自动通过、mc-server running/healthy、6 页签。
- **B AI 配置**：模型地址 / 模型名已填充。
- **C 服务器设置**：66 属性行、5 分组、7 个 compose 接管徽标、接管提示、7 个「交给 properties 管」按钮、`rcon.password` 掩码 + 禁用、页面无 RCON 明文、1 处改动标记、无横向溢出。
- **D 运行时控制**：44 规则读取 **6.7s**（<15s）、select36+input8、无残留禁用、`keep_inventory=false` / `advance_weather=true`、无未知规则、AI bot 在在线玩家下拉。
- **E 玩家管理**：在线玩家行（含 MCAI UUID + AI 徽标）、OP 列表；真人在线与否是外部状态，不在线时记 SKIP 不作判据。
- **F 密码与令牌**：RCON 地址、令牌 48 位、RCON 24 位随机生成正常。
- **G 日志**：日志加载、ANSI 过滤、过滤正常、无横向溢出。

截图：`shots/server.png` / `runtime.png` / `players.png` / `security.png`。

---

## 9. 文件清单

| 文件 | 说明 |
|---|---|
| `mcai-panel/server.js` | 后端，64.7 KB，零依赖 |
| `mcai-panel/index.html` | 前端单页，66.3 KB，内联 CSS/JS，无外部资源 |
| `mcai-panel/selftest.js` | 自测 181 项 |
| `docker-compose.yml`（NAS） | 完整 compose（含 `mcai-panel` 服务块 + compose 挂载） |
| `panel_token.txt` | 面板令牌（48 字符） |
| `check_panel.cjs` | 无头浏览器验证脚本（本机） |
| 本文件 | 使用说明 |
| `配置修改与权限说明.md` | 手工改配置的位置 + 权限模型 |
| `加入服务器指南.md` | 真人客户端进服参数 + 排查 |
