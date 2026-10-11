# MinePilot「MCP 修好 + 目标下发却不执行」诊断报告

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
