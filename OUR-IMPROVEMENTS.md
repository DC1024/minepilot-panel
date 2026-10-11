# Our Improvements to MinePilot — 对上游 MinePilot 的改进汇总

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
