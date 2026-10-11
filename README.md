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
