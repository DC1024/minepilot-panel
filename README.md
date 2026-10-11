# Deployment / 部署与运维交付物

本目录集中存放基于上游 MinePilot 的自研交付物：**Web 配置面板的代码**、**对上游的改进汇总**、**交付文档、示例配置与验证脚本**，供备份、部署与二次开发参考。

> 所有真实凭据（NAS 密码 / RCON 密码 / MCP Token / 面板 Token / API Key）已统一脱敏为 `<占位符>`；内网 IP 泛化为 `<SERVER_IP>`（RFC1918 内网地址，非凭据，供连接参考）。

## 目录内容

| 路径 | 说明 |
|---|---|
| **`OUR-IMPROVEMENTS.md`** | **对上游 MinePilot 的 8 个补丁改进汇总**（输出契约降级 / 无 schema 契约内联 schema / 技能失败诊断 / use_block 前置 / 真人误踢修复）——先看这份 |
| **`docs/`** | **宣传页 + GitHub Pages 发布目录**（`index.html`，零依赖静态页）：项目总览、端到端拓扑、8 个补丁详情、6 页签面板、安全边界、快速上手、脱敏截图 |
| `mcai-panel/` | 自研 Web 面板：`server.js`（后端，零依赖）+ `index.html`（单页前端）+ `selftest.js`（181 项自测） |
| `docker-compose.example.yml` | 部署用 compose 示例（含 `mcai-panel` + `mc-server` 服务，凭据已脱敏） |
| `shots/` | 面板 6 页签的无头浏览器验证截图 |
| `MinePilot-配置面板-使用说明.md` | 面板使用说明（访问方式、6 页签、后端接口、安全说明） |
| `配置修改与权限说明.md` | 配置文件位置速查 + 权限模型（op/白名单/离线服限制） |
| `加入服务器指南.md` | 真人客户端进服参数（MC 26.2 + Forge 65.0.0 + Java 25）与排查 |
| `MinePilot-MCP修复与决策链路诊断报告.md` | MCP 修复 + 决策链路根因分析（对应 OUR-IMPROVEMENTS 的 A/B/C 组） |
| `进服失败-无效玩家数据-根因与修复.md` | 玩家名过短导致 Invalid player data 的根因与补丁（对应 OUR-IMPROVEMENTS 的 D 组） |
| `check_panel.cjs` | 无头浏览器（playwright-core）验证面板的脚本（含测试桩 UUID，非敏感） |
| `dump_server_cfg.py` / `gen_token.py` | 部署辅助脚本 |

## 面板简介

- 容器：`mcai-panel`（`node:22-alpine`，零依赖，无 npm install）
- 端口：`25800`（需 48 位令牌鉴权，`X-Panel-Token` 头或 `?token=`）
- 6 个页签：AI 配置 / 服务器设置（properties）/ 运行时控制（RCON）/ 玩家管理 / 密码与令牌 / 日志
- 挂载 `docker.sock`，可查容器状态/日志/重启，也能读改 `server.properties` 与 compose 接管键
- 安全：不提供任意 RCON 命令入口（白名单动作 + 参数校验）；面板仅限内网，勿暴露公网

## 部署方式

```bash
# 在 Docker Compose 项目中加入 mcai-panel 服务（见 docker-compose.example.yml）
cd <compose目录>
docker compose up -d mcai-panel      # 首次
docker restart mcai-panel            # 改完 server.js/index.html 后（只读挂载，Node 不热重载）
```

详见 `MinePilot-配置面板-使用说明.md`。

## 宣传页（`docs/`）

零依赖单文件静态页，直接双击 `docs/index.html` 即可预览：

```bash
# 本地预览（可选）
python -m http.server 8080 --directory docs    # 然后打开 http://127.0.0.1:8080
```

发布为 GitHub Pages：**Settings → Pages → Source: `Deploy from a branch` → `main` + `/docs`**。
> Pages 的文件夹下拉框只提供 `/ (root)` 和 `/docs` 两项，所以发布目录固定叫 `docs/`，不要改名。

注意仓库是公开的：`docs/assets/` 里的截图已经过脱敏（`docs/_tools/sanitize_shots.py`）——
**真实面板令牌与内网 IP 已遮盖**，改动截图后请重跑该脚本再提交。

## GHCR 镜像

本部署的容器镜像已发布到 GitHub Container Registry，国内拉取无需依赖 Docker Hub：

| 镜像 | 用途 |
|------|------|
| `ghcr.io/dc1024/minepilot-panel:latest` | MinePilot 配置面板（mcai-panel 网页面板） |
| `ghcr.io/dc1024/minepilot-panel-mc-server:java25` | MC 服务端基础镜像（镜像自 `itzg/minecraft-server:java25`） |

- 面板镜像在每次 push `main` 时由 `.github/workflows/publish-ghcr.yml` 自动构建推送。
- 服务端基础镜像由同一工作流在**手动触发**或**每月计划**时从 Docker Hub 镜像到 GHCR。
- `docker-compose.example.yml` 已改为使用上述 ghcr.io 镜像。
- 首次拉取需登录 GHCR：`echo $GITHUB_TOKEN | docker login ghcr.io -u <用户名> --password-stdin`（私有仓库）；公开包可直接 `docker pull`。

## 模组 jar 与 minepilot-build 的联动

`mc-server` 所需的 `mcai_companion` 模组 jar 由 **minepilot-build** 仓库构建并发布：

- `minepilot-build` 的 `build-jar.yml` 在每次 push `main`（含每月上游同步后的重建）时，
  把最新 jar 发布到 GitHub Release `mcai-companion-latest`，稳定下载地址：
  `https://github.com/DC1024/minepilot-build/releases/download/mcai-companion-latest/mcai_companion.jar`
- 本仓库 `docker-compose.example.yml` 中有一个 `mod-sync` 服务，在 `mc-server` 启动前
  自动把上述 jar 拉到 `./minecraft-data/mods/`。
  即：**重新 `docker compose up` 就会用上 minepilot-build 同步上游后产出的最新 jar**。
- `mod-sync` 拉取失败则 `mc-server` 不会启动（避免缺模组空跑）；公开仓库免 token 直拉。

---

## 文档索引

- [配置面板使用说明](#配置面板使用说明)
- [配置修改与权限说明](#配置修改与权限说明)
- [加入服务器指南](#加入服务器指南)
- [进服失败：无效玩家数据根因与修复](#进服失败：无效玩家数据根因与修复)
- [MinePilot MCP 修复与决策链路诊断报告](#minepilot-mcp-修复与决策链路诊断报告)
- [我们的改进（OUR-IMPROVEMENTS）](#我们的改进(our-improvements))

## 配置面板使用说明

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

## 配置修改与权限说明

## 0. 速查表

| 想改什么 | 改哪个文件 | 位置 | 改完要做什么 |
|---|---|---|---|
| AI 的**模型网址**（baseUrl） | `config/mcai-companion.toml` | `[model] baseUrl` | 重启 mc-server |
| AI 的**模型名** | 同上 | `[model] name` | 重启 mc-server |
| AI 请求超时 | 同上 | `[model] softTimeoutSeconds` / `hardTimeoutSeconds` | 重启 mc-server |
| **API Key** | `secrets/mcai-api-key` | 文件内容（或环境变量 `MCAI_API_KEY`） | 重启 mc-server |
| **MCP 控制口开关/端口** | `config/mcai-companion.toml` | `[mcp] enabled` / `port` | 重启 mc-server |
| **MCP Token** | `docker-compose.yml` | `MCAI_MCP_TOKEN` | 重建容器 |
| **MC 对外端口** | `docker-compose.yml` | `ports: "25565:25565"` 的**左边** | 重建容器 |
| **MC 服务端监听端口** | `server.properties` | `server-port` | 重启 mc-server |
| AI 皮肤 / 手臂模型 | `config/mcai-companion.toml` + `config/mcai-companion/skin.png` | `[skin]` | 重启 mc-server |
| 谁能在聊天里指挥 AI | `config/mcai-companion.toml` | `[chat] allowedSenders` | 重启 mc-server |

**根目录**（宿主机）：`<COMPOSE_DIR>/`（Docker Compose 项目目录，即部署 minecraft 的项目根）
= compose 目录。容器内这些文件都在 `/data/` 下。

**重启命令**（在 compose 目录里）：

```bash
sudo docker compose restart mc-server     # 只重启，配置改动生效
sudo docker compose up -d mc-server       # 改了 compose（端口/token/环境变量）用这个
```

---

## 1. 模型网址 + 模型名（最常改）

**文件**：`minecraft-data/config/mcai-companion.toml`（容器内 `/data/config/mcai-companion.toml`）

**当前实际内容**（节选）：

```toml
[model]
	#Provider base URL. HTTPS is required except for a loopback test server.
	baseUrl = "https://developer.amd.com.cn/radeon/api/v1"
	#Provider model name. Leave empty until configured in the in-game setup screen.
	name = "Qwen3.8-27B"
	#After this time the local controller reports that the model is still thinking.
	#Range: 1 ~ 89
	softTimeoutSeconds = 12
	#Hard deadline for a model request.
	#Range: 2 ~ 300
	hardTimeoutSeconds = 90
```

**字段约束**（源码 `CompanionConfig.java` 里写了校验器，写错会导致配置加载失败）：

- `baseUrl`：必须是绝对 URI，**不能带**用户名密码 / `?query` / `#fragment`，必须有 host。
  **https 一律放行；http 只允许 `localhost` / `*.localhost` / `127.*` / `::1`** —— 也就是说指向局域网或公网的地址**必须用 https**。
- `name`：最长 256 字符。
- `softTimeoutSeconds`：1–89；`hardTimeoutSeconds`：2–300。
  两者会做一次钳制：实际 soft = `min(soft, hard - 1)`，所以别把 hard 设得比 soft 还小。

> ⚠️ **密钥不准写进这个文件**。源码注释明确写着 *API keys must never be placed in this spec*。密钥走第 2 节。

## 2. API Key

**首选（当前方式）**：文件 `minecraft-data/secrets/mcai-api-key`（当前 52 字节），compose 里用
`MCAI_API_KEY_FILE: "/data/secrets/mcai-api-key"` 指过去。修改步骤：

```bash
cd <COMPOSE_DIR>
printf '%s' '新的key' | sudo tee minecraft-data/secrets/mcai-api-key >/dev/null
sudo chmod 600 minecraft-data/secrets/mcai-api-key
sudo docker compose restart mc-server
```

**备选**：把 `MCAI_API_KEY` 直接写成 compose 的环境变量（缺点是密钥进了 compose 明文文件）。

**为什么不用游戏内界面填**：见第 5 节——那界面在这台服务器上打不开。

## 3. MCP 控制口

```toml
[mcp]
	enabled = true
	port = 25766
```

- `enabled = true` 才监听；**`MCAI_MCP_TOKEN` 必须存在**（32–128 位 `[A-Za-z0-9_-]`），否则根本不启动监听（而且日志里会被一条无害的 netty kqueue 堆栈掩盖，很容易误判）。
- Token 在 **`docker-compose.yml`** 的 `MCAI_MCP_TOKEN`，**不在 toml 里**。
- 地址是 **`http://[::1]:25766/mcp`** —— 只绑 IPv6 loopback，用 `127.0.0.1` 连不上。
- 请求头需要 `Authorization: Bearer <token>` + `Accept: application/json, text/event-stream`。

## 4. MC 服务器端口

| 想改的 | 文件 | 键 |
|---|---|---|
| **对外端口**（客户端填的这个） | `docker-compose.yml` | `ports: - "25565:25565"` ← 改**冒号左边** |
| 容器内服务端监听端口 | `minecraft-data/server.properties` | `server-port=25565` |
| RCON 端口 | `docker-compose.yml` `ports` + `server.properties` `rcon.port` + `RCON_PASSWORD` | — |

改端口要**两边一起改**（映射左边 = 对外，`server-port` = 容器内），否则连不上。改完 `docker compose up -d mc-server`。

## 5. 游戏内「设置 AI」提示无权限 —— 为什么，以及怎么办

### 两道锁（源码 `ModelSetupModule.handleOpen()`）

```java
if (runtime == null)            → "server_runtime_unavailable"
if (!mayEdit(player))           → "permission_denied"        // ← 你撞的是这道
if (!hasSecureTransport(player))→ "encrypted_transport_required"
```

**锁 1 — `permission_denied`：需要 OP。**
`mayEdit` → `mayAdmin`：专用服务器上要求 `Commands.LEVEL_GAMEMASTERS`（权限等级 **2**）。
你的 `ops.json` 原本是 **`[]`**，所以被这条挡住。

**锁 2 — `encrypted_transport_required`：需要「加密连接」，而这台服务器永远不满足。**
`hasSecureTransport()` 在 MC 26.2 里的实现是**直接看网络 pipeline 里有没有 `decrypt` + `encrypt` 两个 handler**
（因为 26.2 移除了 `Connection#isEncrypted`）。而本服是 `online-mode=false`（离线模式）——
**离线模式下服务端根本不会发起加密握手**，这两个 handler 不存在 → 永远返回 `false`。

> ### 结论
> **这台服务器的游戏内设置界面用不了，给你 OP 也救不了**（会被锁 2 挡住）。
> 改模型网址/模型名请走**第 1 节的文件**，这条路才是官方给专用服务器准备的正路。
>
> 唯一能让游戏内界面可用的办法是 `ONLINE_MODE=TRUE`（开正版验证）并用微软正版账号进服。
> **不推荐**——它会改变整个进服规则（必须有正版账号），还要重启。

### 想让真人玩家进服后能用管理/指挥命令：授予 OP（即时生效，无需重启）

```bash
docker exec mc-server rcon-cli op <玩家名>   # 授予（server.properties 里 op-permission-level=4，给满级）
docker exec mc-server rcon-cli deop <玩家名> # 撤销
```

**OP 解锁的东西**：

| 能力 | 说明 |
|---|---|
| **聊天直接指挥 AI** | `mayControlCompanion` = `mayAdmin` **或** `[chat] allowedSenders` 命中，所以 OP 后你在聊天里就能给 MCAI 派活 |
| `/mcai goal status` | 看 AI 当前目标、revision、是否被外部锁 |
| `/mcai embodiment spawn` / `remove` | 手动让 AI 上线 / 下线 |
| `/mcai evaluation start [completion\|foundation]` | 启动评测 |
| `/mcai embodiment status` | 这个本来就所有人可用 |

**撤销**：`docker exec mc-server rcon-cli deop <玩家名>`（或直接编辑 `minecraft-data/ops.json` 后重启）。

### 想让**别人**（不给 OP）也能指挥 AI

在 `config/mcai-companion.toml` 里：

```toml
[chat]
	allowedSenders = ["对方的UUID", "另一个UUID"]
```

UUID 从 `usercache.json` 里按名字查（离线模式的 UUID = `md5("OfflinePlayer:" + 名字)` 置版本位）。

> ⚠️ 这条**只管「聊天里派任务」**。源码注释写得很清楚：
> *Administrative commands, model setup and evaluation remain gated by `mayAdmin`* ——
> 设置界面和管理命令仍然要求 OP。

---

## 6. 附：关于「进服被踢」

若真人玩家进服时被踢（客户端显示笼统的「无效的玩家数据 / Invalid player data」），根因是**玩家名长度 < 3** 触发了 MinePilot 的名字规则（这是我们对上游修掉的一个 bug）。补丁详情、完整堆栈与实测印证见同目录 **`进服失败-无效玩家数据-根因与修复.md`**。修好后 2 字符的真人名字也能正常进服，客户端无需改动。

## 加入服务器指南

## 一、服务器地址

| 项 | 值 |
|---|---|
| 地址 | `<SERVER_IP>:25565` |
| 端口 | `25565`（主机已映射 `0.0.0.0:25565` 与 `[::]:25565`） |
| MOTD | 部署时自定（示例 `Zspace AI Minecraft Server`） |
| 正版验证 | **关闭**（`online-mode=false`）——不校验账号，用户名随意 |
| 白名单 | **关闭**（`white-list=false` / `enforce-whitelist=false`）——不需要加白名单 |
| 最大人数 | 20 |
| 模式 / 难度 | 生存 / normal |
| 允许飞行 | 否 |

> 在**同一局域网**里直接填 `<SERVER_IP>:25565` 即可。
> 要从外网连，需要在路由器上把 25565/TCP 转发到该服务器。

## 二、版本必须完全对上（这是最常见的连不上的原因）

服务器是 **Forge 服务端**，不是原版。要求：

| 项 | 要求 |
|---|---|
| Minecraft Java | **26.2** |
| Forge | **65.0.0**（范围 `[65.0.0, 66.0.0)`，**65.0.0 最稳**，与服务器完全一致） |
| Java 运行环境 | **Java 25**（推荐 Temurin） |
| 客户端 mod | **必须装同一个 jar** ↓ |

**为什么客户端也要装 mod**：`mcai_companion` 的 `mods.toml` 里 `clientSideOnly` 未设置（即 false），且未覆盖 `displayTest`，因此默认是 `MATCH_VERSION` —— Forge 会在握手时校验客户端是否装了**同名同版本**的 mod。原版客户端会被直接拒之门外。

## 三、客户端安装步骤

1. **装 Forge 65.0.0 for MC 26.2**
   跑 Forge 的 installer（选择 `Install client`），启动器里会出现一个新配置。
   > Forge 是加载器，不是丢进 `mods` 的 jar。

2. **新建一个启动配置**，选刚装好的 `forge-26.2-65.0.0` 版本，并给它一个独立的游戏目录（例如 `%APPDATA%\.minecraft\versions\zspace-26.2-forge`），避免污染你现有的原版存档和 mod。

3. **把 mod jar 丢进该实例的 `mods/` 目录**：

   ```
   mcai_companion-0.1.16-dev-mc26.2.jar
   ```

   ⚠️ **必须是完全相同的这一份**（版本串 `0.1.16-dev-mc26.2` 要一字不差），因为 `MATCH_VERSION` 是精确匹配。文件就在本次交付里（见附件卡片）。

4. **正确分配 Java 25**：启动器 → 该配置 → 「更多选项 / Java 可执行文件」，指到你装的 JDK 25。
   > 启动器自带的旧 Java 会让 Forge 26.2 起不来。

5. 启动游戏 → 多人游戏 → 添加服务器 → 填 `<SERVER_IP>:25565` → 进入。

**首次进服会看到 MinePilot 的配置引导界面**（agent 名字、颜色、temperature、64×64 皮肤本地导入、臂型、API Key / baseUrl / 模型名）。如果你只是想看 AI 陪玩，**这些不用填**——服务端已经配好模型了，客户端那份只影响你本地自己的实例。

## 四、进服后能看到什么

- 会看到一个叫 **MCAI** 的玩家：它是服务端里的**无账户 headless ServerPlayer**，不需要客户端、也不需要真人，一直在线自己活动。
- 它会自己在世界里跑、砍树、合成、战斗（会自己退避和反击）。
- 你可以直接和它互动，就像普通玩家一样。

## 五、如果连不上，按这个顺序排查

| 现象 | 原因 | 处理 |
|---|---|---|
| **`无效的玩家数据` / `Invalid player data`**（能握手、进服瞬间被踢） | **玩家名长度 < 3**。MinePilot 的 `AgentNameRules` 要求名字是 3–16 位的 `[A-Za-z0-9_]`，而它在 `PlayerLoggedInEvent` 里对**每个进服玩家的名字**做了这个校验，抛错后 `PlayerList#placeNewPlayer` 失败 → 客户端只看到笼统的「无效的玩家数据」 | 用 **≥3 位**且只含 `A-Za-z0-9_` 的名字（如 `DC1024`）。服务端已打补丁，见第七节 |
| `Incompatible mods found` / 提示缺少 `mcai_companion` | 客户端没装 mod，或版本串不一致 | 确认 `mods/` 里是 `mcai_companion-0.1.16-dev-mc26.2.jar`，且和服务器**同一份** |
| `This server has mods that require Forge` | 用原版客户端连了 Forge 服务端 | 走 Forge 启动配置进游戏 |
| 一进就崩 / Forge 启动失败 | Java 版本不对 | 换成 JDK 25 |
| 版本不兼容提示 | MC 版本不是 26.2 或 Forge 不是 65.x | MC 锁 26.2，Forge 锁 65.0.0 |
| 连接超时 | 不在同一网段 / 未做端口转发 | 先 `ping <SERVER_IP>` |
| 卡在「正在生成世界」很久 | 服务端在跑 AI 推理，CPU 有占用 | 等一会儿；正常进去后是流畅的 |

## 六、备选：能不能用原版客户端直接连？

理论上有两条路，都需要改服务端并重新编译发版，**默认不建议**：

1. 在 `mods.toml` 里设 `displayTest="IGNORE_ALL_VERSION"` —— 松开版本精确匹配，**但仍要求客户端装 Forge**。
2. 设 `displayTest="NONE"` —— 这一档才可能让**纯原版客户端**进服，但等于放弃 Forge 的 mod 一致性校验，属于非默认路径，可能带来其它副作用。

需要的话我可以打一版这样的 jar 上服务器试；但**推荐还是走上面第三节的标准装法**，最省事也最稳。

## 七、已修复：「无效的玩家数据」踢人（玩家名太短）

**症状**：Forge/mod 版本都对，握手也过了，但一进服同秒被踢，客户端弹「无效的玩家数据」。

**服务端真实报错**（被 Vanilla 吞掉、只写进日志，所以客户端看不到）：

```
[Server thread/ERROR] [minecraft/ServerConfigurationPacketListenerImpl]: Couldn't place player in world
java.lang.IllegalArgumentException: name_too_short
    at dev.mcai.companion.agent.AgentNameRules.requireValid(AgentNameRules.java:103)
    at dev.mcai.companion.world.CompanionWorldData.rememberPlayerName(CompanionWorldData.java:269)
    at dev.mcai.companion.modelsetup.ModelSetupModule.lambda$register$1(ModelSetupModule.java:115)
    at net.minecraftforge.event.ForgeEventFactory.firePlayerLoggedIn
    at net.minecraft.server.players.PlayerList.placeNewPlayer
```

即 **MinePilot 自己写的名字规则把进来的真人玩家也校验了**：`AgentNameRules.MIN_LENGTH = 3`，而 2 字符的玩家名（如 `DC`）只有 2 个字符 → 抛 `name_too_short` → 由于这个监听器跑在 `PlayerList#placeNewPlayer` 里面，异常被原版的生成任务捕获，玩家被判为「无法放置」并断开。

**修复**（服务端 jar 已更新，commit `04770b4`，GitHub Actions run `38079771821`）：

- `CompanionWorldData.rememberPlayerName()` 遇到不合规的真人名字改为**跳过而不抛异常**（跳过是安全的：AI 自己的名字本来就必须是 3–16 位，两边不可能撞名）。
- `PlayerLoggedInEvent` 监听器整体加 `try/catch`，以后任何记账失败都不会再拒绝合法登录。
- **版本串没变**（仍是 `0.1.16-dev-mc26.2`），所以 **客户端不需要换 jar**。

**实测印证**：修复前，同一台客户端用 2 字符名字（如 `DC`）进服即被踢；换成 3 字符名字（如 `DCC`）一次进服成功。补丁上线后，2 字符名字的真人玩家进服也正常。完整诊断见同目录 **`进服失败-无效玩家数据-根因与修复.md`**。

## 八、进服之后的权限

- 进服后你**不能**用游戏内的「AI 陪玩 → 设置」界面：它除了要求 OP，还要求**加密连接**，而本服是离线模式（`online-mode=false`）永远不满足 → 固定报无权限/需要加密传输。改模型请改服务端的 `config/mcai-companion.toml`。
- 真人玩家被授予 OP 后，在聊天里可以直接指挥 AI，也能用 `/mcai goal status`、`/mcai embodiment spawn|remove` 等命令。
- 配置改哪里、权限怎么给/怎么撤，见同目录 **`配置修改与权限说明.md`**。

## 进服失败：无效玩家数据根因与修复

> 结论先说：**不是你的客户端装错了。** 是服务端模组 MinePilot 的一条名字校验规则把**真人玩家名**也校验了，你的用户名 `DC` 只有 2 个字符，触发它的下限（3 字符），在 `PlayerLoggedInEvent` 里抛异常，导致 Vanilla 判定「无法放置玩家」并把你踢掉。**已修复并部署上线**，客户端不需要任何改动。

---

## 一、你看到的现象

- 客户端版本：Forge **65.1.3**（在要求范围 `[65.0.0, 66)` 内）✅
- 客户端 mod：`mcai_companion` 已装 ✅
- 服务器地址填对、能握手、**进服瞬间被踢**，弹窗：**「无效的玩家数据」**

## 二、服务端日志里的真因

客户端那句「无效的玩家数据」是 Vanilla 的**笼统兜底文案**，真实原因只写在服务端日志里：

```
[03:20:28] [Server thread/INFO]  [PlayerList]: DC[/<CLIENT_IP>:12327] logged in with entity id 1149
[03:20:28] [Server thread/INFO]  [MinecraftServer]: DC joined the game

[03:20:28] [Server thread/ERROR] [ServerConfigurationPacketListenerImpl]: Couldn't place player in world
java.lang.IllegalArgumentException: name_too_short
    at dev.mcai.companion.agent.AgentNameRules.requireValid(AgentNameRules.java:103)
    at dev.mcai.companion.world.CompanionWorldData.rememberPlayerName(CompanionWorldData.java:269)
    at dev.mcai.companion.modelsetup.ModelSetupModule.lambda$register$1(ModelSetupModule.java:115)
    at net.minecraftforge.event.ForgeEventFactory.firePlayerLoggedIn(ForgeEventFactory.java:738)
    at net.minecraft.server.players.PlayerList.placeNewPlayer(PlayerList.java:228)
    ...
    at ServerConfigurationPacketListenerImpl.handleConfigurationFinished

[03:20:28] [Server thread/INFO]  [ServerGamePacketListenerImpl]: DC lost connection: Invalid player data
[03:20:28] [Server thread/INFO]  [MinecraftServer]: DC left the game
```

**因果链**：

1. Forge 在 `PlayerList#placeNewPlayer` 里派发 `PlayerLoggedInEvent`；
2. MinePilot 的监听器调用 `CompanionWorldData.rememberPlayerName(玩家名)`，**对每个进服玩家**的名字跑 `AgentNameRules.requireValid()`；
3. 该规则要求名字是 `[A-Za-z0-9_]{3,16}`（`MIN_LENGTH = 3`），`DC` 长度 2 → 抛 `IllegalArgumentException("name_too_short")`；
4. 异常冒泡出事件派发 → 被 Vanilla 的生成任务捕获 → 判定玩家无法放置 → 用通用文案 `Invalid player data` 断开。

**为什么客户端版本/mod 都没问题时还被踢**：这条校验是模组自己加的、比 Vanilla 更严（Vanilla 离线模式允许 1–16 字符）。模组原本的意图是约束 **AI 同伴自己的名字**，但 `rememberPlayerName` 把它用在了**真人**身上——这是个 bug。

## 三、实测印证（关键证据）

同一台客户端、同样的版本和 mod，只换了用户名：

| 时间 | 用户名 | 结果 |
|---|---|---|
| 03:20:28 | `DC`（2 字符） | 进服同秒被踢 `Invalid player data` ❌ |
| 03:24:54 | `DCC`（3 字符） | **一次进服成功，正常游玩 4 分钟** ✅ |

`usercache.json` 与离线 UUID 也对得上（离线 UUID = `md5("OfflinePlayer:" + 名字)` 置 version/variant 位，可用此算法校验任意玩家名是否为真人离线号）：

**长度是唯一的变量。** 根因确认无疑。

## 四、修复内容（已上线）

源码仓库 `DC1024/minepilot-build`，commit **`04770b4`**，CI run **`38079771821`**（success）。两处改动：

**1. `CompanionWorldData.rememberPlayerName()` —— 不合规的真人名字改为跳过，不再抛异常**

```java
public void rememberPlayerName(final String playerName) {
    final AgentNameRules.Validation validation =
        AgentNameRules.validateSyntax(playerName);
    if (!validation.accepted()) {
        return;                       // 原本这里是 requireValid() → 抛异常
    }
    final String normalized = validation.normalized();
    ...
}
```

跳过是**语义安全**的：AI 同伴自己的名字本来就必须满足 3–16 位规则，所以两边不可能撞名，`knownPlayerNames` 的「防抢名」作用不受影响。

**2. `ModelSetupModule` 的登录监听器整体加防御性捕获**

```java
try {
    ...
    data.rememberPlayerName(player.getGameProfile().name());
    ...
} catch (final RuntimeException failure) {
    MinecraftAiCompanion.LOGGER.warn(
        "Player-login bookkeeping failed for {}, login continues",
        player.getGameProfile().name(), failure);
}
```

以后任何记账失败都不会再拒绝一个合法登录（并把原因写进日志，方便下次排查）。

> **版本串故意没有改**，仍是 `0.1.16-dev-mc26.2`。Forge 的 `MATCH_VERSION` 只比对版本串，所以 **你的客户端不用换 jar**。

## 五、部署后的验证结果

| 检查项 | 结果 |
|---|---|
| 服务器启动 | `Done (0.350s)! For help, type "help"` ✅ |
| 模组加载 | `Minecraft AI Companion 0.1.16-dev-mc26.2 initialized` ✅ |
| MCP 控制口 | `Codex MCP is listening on loopback port 25766` ✅ |
| AI 同伴在线 | `rcon list` → `There are 1 of a max of 20 players online: MCAI` ✅ |
| 重启后 8 分钟内 | spawn 失败 **0** 次、`Invalid player data` **0** 次 ✅ |
| 模型决策链路 | `Live-model accepted decision: decision=START_SKILL, skill=gather_nearby_wood`（03:40:47），机器人在正常砍树 ✅ |

## 六、你现在该做什么

1. **直接用 `DC` 进服就行** —— 规则已修，不需要改名。
2. 客户端**什么都不用改**（版本、Forge、mod 都是对的，保持现状）。
3. 地址 `<SERVER_IP>:25565`，进服后应该能看到一个叫 **MCAI** 的玩家在自主活动。

> 如果你已经用 `DCC` 玩过，那也没问题：离线模式下**用户名决定存档归属**（不同名字 = 不同 UUID = 不同玩家档案），两者可以并存互不影响。

## 七、附带查清的两件事（供以后参考）

- **玩家存档其实在 `/data/world/players/data/<uuid>.dat`**（1.20.2+ 的新布局），**不是**老资料里写的 `world/playerdata/`。所以你之前就算想「删 playerdata 重置」也找不到文件。
- 日志里那条 `netty kqueue ... Only supported on OSX/BSD` 是 log4j 渲染时的**已知无害**副作用；`SSLHandshakeException: PKIX path building failed` 也不影响模型调用（决策日志正常证明 LLM 链路通）。

## MinePilot MCP 修复与决策链路诊断报告

**时间**：2026-10-11 01:00 ~ 03:15
**环境**：Docker Compose 项目 `minecraft` / `mc-server` = Forge 26.2 + Forge 65.0.0 + Java 25
**结论**：MCP 已完全可用；「目标被接受却立刻转 SAFE_IDLE」的真根因是 **MinePilot 在 `JSON_OBJECT` 输出契约下从不把决策 schema 发给模型**。已修，并端到端跑通首个自主闭环。

---

## 一、用户诉求与实际卡点

用户指令是「修 MCP」。但把 MCP 修好后发现：`set_goal` 返回 `accepted=true`，几秒后目标却转成 `SAFE_IDLE / model_failures_exhausted`，界面只说"模型暂时没有响应"。也就是说 **MCP 只是"门"，真正堵住的是门后那条决策链路**。所以本次实际修了两层。

---

## 二、第一层：MCP 本身（缺 token）

| 项 | 内容 |
|---|---|
| 表象 | 日志只有 `Only supported on OSX/BSD`（netty kqueue 堆栈），看起来像平台不兼容 |
| 误判 | 上一轮据此把 `[mcp] enabled=false` 关掉了 |
| 真因 | **缺 `MCAI_MCP_TOKEN`**（要求 32~128 位 `[A-Za-z0-9_-]`）。kqueue 异常只是 log4j 渲染堆栈时的副作用，把真实异常盖住了 |
| 修复 | 生成 48 字符 token → compose 环境变量 `MCAI_MCP_TOKEN` + toml `[mcp] enabled=true` |
| 验证 | `Codex MCP is listening on loopback port 25766`；`tools/list` 返回 8 个工具 |

**可用工具**：`observe` / `set_goal` / `goal_status` / `say` / `cancel_goal` / `add_waypoint` / `get_screenshot` / `get_audit_summary`

**连接要点**：`http://[::1]:25766/mcp`（**只绑 IPv6 loopback，`127.0.0.1` 连不上**），必须带 `Authorization: Bearer <token>` 与 `Accept: application/json, text/event-stream`。

---

## 三、第二层（关键）：决策请求缺 schema

### 定位过程
`ModelFailure` 默认故意不落原始报文，日志只有一句中文。MinePilot 里有个隐藏开关：

```
-Dmcai.liveModelTest=true     # 加进 compose 的 JVM_OPTS
```

打开后立刻拿到真相：

```
Live-model decision rejected: kind=MALFORMED_RESPONSE,
  message=The model decision failed local validation: missing_fields
```

### 根因
`ModelRequestFactory` 的 `CONTRACT_INSTRUCTION` 一直写着 *"Return exactly one high-level decision matching the supplied JSON schema"* —— 但**只有在 `JSON_SCHEMA` / `FORCED_FUNCTION` 契约下 schema 才会被放进请求**。我们的端点（AMD Radeon 网关）不支持严格 json_schema，只能降级到 `JSON_OBJECT`，而这个分支**什么都不发**。

于是模型连字段名都不知道（决策信封要求 9 个必填字段：`requestId` / `observedWorldRevision` / `goalRevision` / `decision` / `skillName` / `typedArguments` / `requestedObservation` / `optionalSpeech` / `confidence`），只能瞎猜 → 每次都 `missing_fields`。

### 修复（commit `d5eefe6`）
在 `ModelRequestFactory` 新增 `contractInstruction(outputContract, decisionSchema)`：当契约是 `JSON_OBJECT` / `PLAIN_JSON` 时，把 `codec.schema(context)`（**含当次可用 skill 枚举**）序列化后内联进 instructions；Responses 与 Chat Completions 两条线都改。

### 效果
```
Live-model accepted decision: decision=START_SKILL, skill=gather_nearby_wood
[AI] 动作完成：砍树并收集木材
Live-model accepted decision: decision=COMPLETE_GOAL
goal_status → status=COMPLETED, detailCode=server_verified_complete
mainHand → minecraft:spruce_log × 1     ← 真的砍到木头了
```

**这是首个「无人在线、无图形客户端」的完整自主闭环，且完成状态由服务端验证而非模型自述。**

---

## 四、顺带解决的三件事

### 1. 模型选型（换成 Qwen3.8-27B）
用真实决策请求形态在 z4pro 上横向对比 7 个模型：

| 模型 | 信封字段 | 首个决策 |
|---|---|---|
| DeepSeek-V4-Flash / V4.1-Flash | 完整 | `use_block`（缺前置步骤） |
| **Qwen3.8-27B** | 完整 | **`equip_item`**（正确） |
| Qwen3.8-Flash-Next | 完整 | `equip_item`（正确） |
| Gemma-4-31B-IT / MiMo-V2.6-Flash | 完整 | `use_block` |
| GLM-5.3-Flash | — | 超时 |

补丁对所有模型生效（字段都完整），差异只在规划质量 → 已切到 `Qwen3.8-27B`。

### 2. 技能失败码可观测（commit `0435140`）
技能失败原本只广播一句"动作未完成"，失败码不落日志。补丁让 `BrainOrchestrator` 在 FAILED 分支打印：

```
Live-model skill failed: skill=use_block, code=use_block.action_target_occluded
```

### 3. 放置方块失败的根因（commit `d8a81b8`）
`FairPlayerActuator.useOnBlock` 的契约是 **"on the block surface currently under the companion's own crosshair"**：`isBlockUnderCrosshair()` 用 `getViewVector(1.0F)` 做 raycast，命中点必须落在目标 `hitPoint()` 的 0.5 格内、且 face 方向完全一致，否则一律 `TARGET_OCCLUDED`。

⇒ **`use_block` 必须先 `look_at` 同一方块面**（空手时还要先 `equip_item`）。模型默认跳过 look_at，连续 3 次失败 → `repeated_skill_failure_without_progress` → SAFE_IDLE。

已在技能指南写明该前置条件。**实测把目标写成两步后成功**：

```
03:08:54 look_at  (-7,69,21)              → 动作完成
03:09:00 use_block(-7,69,21) face=up      → 动作完成
03:09:05 COMPLETE_GOAL / server_verified_complete
```

---

## 五、踩坑记录（都值得记住）

1. **技能指南有 14000 字符硬上限**。`MAX_SKILL_GUIDE_CHARACTERS = 14_000`，`boundedGuide()` 超限直接抛异常 → **服务器启动崩溃循环**。原始已 13986，**只剩 14 字符余量**。我第一版加提示写了 +263 → 崩了三次。改这类文本前**必须先算总长度**。
2. **artifact 下载顺序不可靠**：按"第一个名字匹配"拿到旧包，且 **artifact id 大 ≠ 新**。必须按 `head_sha` 找 run 再取该 run 的 artifact。
3. **`runs?per_page=1` 轮询会误判完成**（新 run 未注册时读到上一次的 run）→ 必须 sha 匹配。
4. **部署后先校验 jar 内容再重启**（在 class 常量池里 grep 补丁字符串），否则"构建成功"和"线上换了"是两件事。
5. **MCP 就绪探测要用 curl 看 http_code ≠ 000**，grep 日志里的 "listening on loopback port" 会被旧行立刻匹配。

---

## 六、当前线上状态与下一步候选

**状态**：mc-server 健康；MCP 监听 25766；MCAI 在线；`model=Qwen3.8-27B`，`profile=RESPONSES/JSON_OBJECT, ready=true`；`JVM_OPTS: "-Dmcai.liveModelTest=true"` 仍开着（诊断用）。

**候选下一步**
1. **让 `use_block` 自己先瞄准**（像真人"先看再点"）。未直接改是因为 `InteractionSkillActuator` 接口没有 look 方法，需扩接口 + 实现 + 测试，属跨文件改动，不宜盲改。这是让 bot 稳定放置/建造的正解。
2. **做「目标泵」**：定时经 MCP `set_goal` 下发目标，配合完成检测自动续接 —— 真正实现"我不在它也一直在玩"。MinePilot 没有自主目标来源时会 IDLE。
3. 关掉 `mcai.liveModelTest`（若不需要诊断日志）。
4. 用户提到的 `mcskin/skin_classic.png`：MinePilot 支持 `config/mcai-companion/skin.png` + `[skin] autoImportFixedFile=true` 自动导入，尚未执行。

## 我们的改进（OUR-IMPROVEMENTS）

> 本文档汇总我们基于上游 **MinePilot**（`weidakuang/MinePilot`，mod id `mcai_companion`，LGPL-3.0）做的全部改动，以及配套的自研交付物。
> 仓库：`DC1024/minepilot-build`（main）。所有改动都在仓库内（连同 MinePilot 源码 + GitHub Actions jar 构建 workflow）。
> 真实凭据均已脱敏为 `<占位符>`；如需了解框架背景，见同目录 `进服失败-无效玩家数据-根因与修复.md`、`MinePilot-MCP修复与决策链路诊断报告.md`。

---

## 一、我们在跑什么

一个「**无人值守、自主活动**」的 Minecraft AI 玩家：MinePilot Forge 模组在服务端内建一个**无账户 headless ServerPlayer**（叫 `MCAI`），不需要图形客户端、不需要真人常驻，它自己在世界里跑、砍树、合成、战斗、退避。

- 服务端：`itzg/minecraft-server`，**TYPE=FORGE / VERSION=26.2 / FORGE_VERSION=65.0.0 / Java 25**。
- 模型：AMD Radeon 网关（`developer.amd.com.cn/radeon/api/v1`）上的 `Qwen3.8-27B`，经 **`RESPONSES/JSON_OBJECT`** 输出契约驱动。
- 无人值守闭环：`MCAI` 在线 → 收到目标 → LLM 决策 → 执行技能（移动/砍树/合成/放置）→ 服务端校验完成。

对 GitHub 用户最有价值的是下面的**改进清单**——尤其是「输出契约降级」和「无 schema 契约内联决策 schema」两条，**对任何不严格支持 `json_schema` 的 OSS / 本地 / 第三方网关（AMD、vLLM、Ollama、LM Studio 等）都通用**。

---

## 二、对上游 MinePilot 的 8 个补丁改进（重点）

按「解决的因果链」分四组。每条都对应一个线上真实故障。`23163dd` 是自研面板+文档，不属于引擎改进，未计入。

### A. 输出契约降级 —— 让「弱 provider」也能用

**问题**：MinePilot 决策依赖 structured output。但很多网关（尤其 AMD Radeon、vLLM、Ollama 这类）不支持 `response_format: json_schema`，默认会直接失败 → `startup_model_unavailable_invalid_request`，bot 变「身体在、无大脑」。

- **`4fcbd35`** `ProviderErrorClassifier.java`：修复「provider 拒绝能力时若没带 `param` 字段就判定失败」的 bug。原 `mentionsField` 是**大小写敏感** + 要求非标识符边界，`json_schema` 对不上消息里的 "JSON schema"，导致拒绝永远无法被识别。
- **`bfe8833`** `JdkProviderCapabilityProbe.java`：探测到输出契约被拒时**不再整体终止**，而是 `break` 继续试下一个更弱的契约（`JSON_SCHEMA → JSON_OBJECT → PLAIN_JSON → PLAIN`），全部失败才算 failed。
- **净效果**：能协商降级到 `RESPONSES/JSON_OBJECT` 契约 → `ready=true`。

### B. 无 schema 契约也把决策 schema 喂给模型 —— 决策能真正执行

**问题**：`JSON_OBJECT` / `PLAIN_JSON` 契约**原本根本不会把 schema 发给模型**（只有 `JSON_SCHEMA` / `FORCED_FUNCTION` 会）。模型连字段名都不知道，只能瞎猜 → 每次 `MALFORMED_RESPONSE` / `missing_fields` → `SAFE_IDLE`。这是「目标被接受却立刻不执行」的真根因。

- **`d5eefe6`** `ModelRequestFactory.java`：新增 `contractInstruction()`，当契约是 `JSON_OBJECT` / `PLAIN_JSON` 时，把 `codec.schema(context)`（**含当次可用 skill 枚举**）序列化**内联进 instructions**；Responses 与 Chat Completions 两条线都改。
- **净效果**：`Live-model accepted decision` → bot 真的完成 `gather_nearby_wood` 拿到木头 → **端到端首个自主闭环跑通，完成状态由服务端验证而非模型自述**。

### C. 决策质量 + 技能失败诊断

- **`0435140`** `BrainOrchestrator.java`：技能失败码 `SkillFailure.code` 落日志（挂在 `-Dmcai.liveModelTest=true` 诊断开关下）。→ 这才拿到真实失败码 `use_block.action_target_occluded`，是下面两条的修复依据。
- **`f482154`** + **`d8a81b8`** `FairInteractionSkills.java`：use_block 的指南要求**先 `equip_item`**，且明确「只作用于准星下那个面，必须先 `look_at` 同一方块面再 use_block」。根因：`isBlockUnderCrosshair()` 用 `getViewVector` 做 raycast，命中点必须落在 `target.hitPoint()` 0.5 格内且 face 完全一致，否则报 `action_target_occluded`。
- **`233fc67`** `FairInteractionSkills.java`：把技能指南压回 **14000 字符硬上限**内（13986→13970），修掉「服务器启动崩溃循环」（`skillGuide exceeds its bound: 14249 > 14000`）。

### D. 真人陪玩不被误踢（明确社区 bug）

**问题**：MinePilot 的名字规则 `[A-Za-z0-9_]{3,16}` 把**每个真人玩家名**也拿去校验，且登录监听器跑在 `PlayerList#placeNewPlayer` 内部 → 2 字符的名字（如 `DC`）一进服抛 `name_too_short` → 被 `PrepareSpawnTask` 捕获 → 客户端只看到笼统的 **`Invalid player data`**。

- **`04770b4`**（`ModelSetupModule.java` + `CompanionWorldData.java`）：`rememberPlayerName()` 校验不过就**静默 return**（不再抛），登录监听器整体包 `try/catch (RuntimeException)`。版本串故意不改 → **客户端无需换 jar**。
- **净效果**：2 字符名真人玩家进服成功，不再被误踢。

---

## 三、配套的自研交付物

| 交付物 | 说明 |
|---|---|
| `mcai-panel/` | **自研 Web 配置面板**（MinePilot 模组本身没有 Web 面板）。`server.js`（后端，零依赖，只用 node 内置模块）+ `index.html`（单页前端）+ `selftest.js`（181 项自测）。6 页签：AI 配置 / 服务器设置 / 运行时控制 / 玩家管理 / 密码与令牌 / 日志 |
| `docker-compose.example.yml` | 部署 compose 示例（含 `mcai-panel` + `mc-server` 服务，凭据已脱敏） |
| `check_panel.cjs` | 无头浏览器（playwright-core）验证面板脚本 |
| `gen_token.py` / `dump_server_cfg.py` | 部署辅助脚本 |
| `MinePilot-配置面板-使用说明.md` | 面板使用说明（访问、6 页签、后端接口、安全说明） |
| `配置修改与权限说明.md` | 配置文件位置速查 + 权限模型（op / 白名单 / 离线服限制） |
| `加入服务器指南.md` | 真人客户端进服参数（MC 26.2 + Forge 65.0.0 + Java 25）与排查 |
| `MinePilot-MCP修复与决策链路诊断报告.md` | MCP 修复 + 决策链路根因分析（对应 B/C 组补丁的完整诊断） |
| `进服失败-无效玩家数据-根因与修复.md` | 「玩家名过短导致 Invalid player data」的根因与补丁（对应 D 组） |
| `shots/` | 面板 6 页签无头浏览器验证截图 |

---

## 四、关键运维事实（给想复刻的部署者）

- **MCP 控制口**：`[mcp] enabled=true` + 环境变量 `MCAI_MCP_TOKEN`（**必填**，32~128 位 `[A-Za-z0-9_-]`，缺了不监听）。地址 `http://[::1]:25766/mcp`（**只绑 IPv6 loopback**），请求头要 `Authorization: Bearer <token>` + `Accept: application/json, text/event-stream`。8 个工具：observe / set_goal / goal_status / say / cancel_goal / add_waypoint / get_screenshot / get_audit_summary。
- **API Key 放哪**：`secrets/mcai-api-key`（或环境变量 `MCAI_API_KEY`），**绝不写进** `config/mcai-companion.toml`（源码注释明确禁止）。
- **改配置生效**：`docker compose restart mc-server`（toml 是 ForgeConfigSpec，启动读一次，不支持热改）。
- **诊断开关**：`JVM_OPTS: "-Dmcai.liveModelTest=true"` 会打印 `Live-model decision rejected: kind=..., message=...` 与 `Live-model skill failed: skill=..., code=...` —— **这是唯一能看到 ModelFailure / SkillFailure 细节的途径**。
- **技能指南有 14000 字符硬上限**：改任何 `plannerGuide()` / `CORE_SKILL_GUIDE` 前**必须先算总长度**，超了服务器启动崩溃循环。
- **离线服权限**：`online-mode=false` 时游戏内「设置 AI」界面**永久不可用**（`hasSecureTransport` 要求 pipeline 有 `decrypt`+`encrypt`，离线服不满足）→ 改模型走 toml。想让其他玩家在聊天里指挥 AI，给 OP 或把其 UUID 加进 `[chat] allowedSenders`。

---

*文档整理时间：2026-10-11 · 基于线上验证与 git 提交历史*
