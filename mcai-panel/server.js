#!/usr/bin/env node
/**
 * Zspace AI Minecraft —— MinePilot 配置面板（后端）
 *
 * 只用 Node 内置模块，零依赖，镜像直接复用 node:22-alpine。
 *
 * 能力分三块：
 *   A. AI 配置（MinePilot）—— 读写 config/mcai-companion.toml、secrets/mcai-api-key
 *   B. 服务器本体 —— 读写 server.properties（正版/盗版、游戏模式、难度、命令方块、视距…）
 *   C. 运行时控制 —— 通过 RCON 即时下发天气/时间/游戏规则/游戏模式/OP/白名单/封禁
 *   另有：容器状态、在线玩家（含 UUID）、日志、模型连通性、改密码
 *
 * 所有 RCON 操作都走**结构化动作白名单**（见 buildRconCommand），
 * 不提供任意命令执行入口 —— 面板挂了 docker.sock，不能被当成通用 shell。
 */
'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');

const PORT = parseInt(process.env.PANEL_PORT || '25800', 10);
let TOKEN = (process.env.PANEL_TOKEN || '').trim();          // 可运行时热改
const MC = process.env.MC_CONTAINER || 'mc-server';
const SOCK = process.env.DOCKER_SOCK || '/var/run/docker.sock';
const DATA = process.env.MC_DATA_DIR || '/data';
const RCON_HOST = process.env.MC_RCON_HOST || 'mc-server';
const RCON_PORT = parseInt(process.env.MC_RCON_PORT || '25575', 10);
const RCON_PASS = process.env.MC_RCON_PASSWORD || '';
const CHOWN_UID = parseInt(process.env.MC_UID || '1000', 10);
const CHOWN_GID = parseInt(process.env.MC_GID || '1000', 10);
// compose 文件（只读挂载进来用于「哪些键被环境变量接管」的检测与同步）
const COMPOSE_PATH = (process.env.COMPOSE_PATH || '/compose/docker-compose.yml').trim();

const TOML_PATH = path.join(DATA, 'config', 'mcai-companion.toml');
const KEY_PATH = path.join(DATA, 'secrets', 'mcai-api-key');
const PROPS_PATH = path.join(DATA, 'server.properties');
const OPS_PATH = path.join(DATA, 'ops.json');
const WHITELIST_PATH = path.join(DATA, 'whitelist.json');
const BANNED_PATH = path.join(DATA, 'banned-players.json');
const INDEX = path.join(__dirname, 'index.html');

const MIN = { soft: 1, softMax: 89, hard: 2, hardMax: 300, mcpPort: 1024, mcpPortMax: 65535 };

/* ------------------------------------------------------------------ 工具 */

function log(...a) { console.log(new Date().toISOString(), ...a); }

function chownIfPossible(p, mode) {
  try { fs.chownSync(p, CHOWN_UID, CHOWN_GID); } catch (e) { /* 非 root 时忽略 */ }
  if (mode !== undefined) { try { fs.chmodSync(p, mode); } catch (e) {} }
}

function readText(p, fallback = '') {
  try { return fs.readFileSync(p, 'utf8'); } catch (e) { return fallback; }
}

function writeText(p, text, mode) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, { encoding: 'utf8', mode: mode === undefined ? 0o664 : mode });
  chownIfPossible(p, mode);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * 切行前统一归一化换行符。
 * ★ JS 正则里 `.` 不匹配 \r（它是行终止符），`$`（无 m 标志）也不匹配 \r 之前，
 *   所以像 /^...:\s*(.*)$/ 这种写法在 **CRLF 文件**上会整行失配 —— 而且不报错，静默返回 null。
 *   实测踩过：NAS 上的 docker-compose.yml 是 CRLF，导致所有环境变量都读不出来。
 */
function splitLines(text) {
  return String(text).replace(/\r\n?/g, '\n').split('\n');
}

/* ------------------------------------------------------------- TOML 子集 */

/** 解析 [section] key = value 结构，值保留原始字面量 */
function parseToml(text) {
  const out = {};
  let section = '';
  for (const raw of splitLines(text)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const sm = /^\[([^\]]+)\]$/.exec(line);
    if (sm) { section = sm[1].trim(); if (!out[section]) out[section] = {}; continue; }
    const km = /^([A-Za-z0-9_.\-]+)\s*=\s*(.*)$/.exec(line);
    if (km) {
      if (!out[section]) out[section] = {};
      out[section][km[1]] = km[2];
    }
  }
  return out;
}

function tomlString(v) { return '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }

function tomlScalar(raw) {
  if (raw === undefined) return undefined;
  const s = raw.trim();
  if (s.startsWith('"') && s.endsWith('"')) {
    try { return JSON.parse(s); } catch (e) { return s.slice(1, -1); }
  }
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  return s;
}

function tomlArray(raw) {
  if (raw === undefined) return [];
  const s = raw.trim();
  if (!s.startsWith('[')) return [];
  return s.slice(1, -1).split(',').map(x => x.trim()).filter(Boolean)
    .map(x => x.replace(/^["']|["']$/g, ''));
}

/** 就地改写指定 (section,key) 的行；缺失的键插入到其 section 头部之后 */
function setTomlValues(text, updates) {
  const lines = splitLines(text);
  const pending = new Map();
  for (const u of updates) pending.set(u.section + '\u0000' + u.key, u);

  let section = '';
  for (let i = 0; i < lines.length; i++) {
    const sm = /^\s*\[([^\]]+)\]\s*$/.exec(lines[i]);
    if (sm) { section = sm[1].trim(); continue; }
    if (/^\s*#/.test(lines[i])) continue;
    const km = /^(\s*)([A-Za-z0-9_.\-]+)(\s*=\s*)(.*)$/.exec(lines[i]);
    if (km) {
      const id = section + '\u0000' + km[2];
      if (pending.has(id)) {
        lines[i] = km[1] + km[2] + km[3] + pending.get(id).literal;
        pending.delete(id);
      }
    }
  }

  // 收尾：文件中不存在的键，插到对应 section 标题行之后；section 不存在则追加
  for (const [id, u] of pending) {
    const tpl = u.literal;
    const header = '[' + u.section + ']';
    let idx = lines.findIndex(l => l.trim() === header);
    if (idx === -1) {
      if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
      lines.push(header, '\t' + u.key + ' = ' + tpl);
    } else {
      lines.splice(idx + 1, 0, '\t' + u.key + ' = ' + tpl);
    }
  }
  return lines.join('\n');
}

/* ------------------------------------------------- server.properties 子集 */

/** 解析 key=value（# 和 ! 都是注释），值保留原始字面量 */
function parseProps(text) {
  const out = {};
  const order = [];
  for (const raw of splitLines(text)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    out[k] = line.slice(i + 1);
    order.push(k);
  }
  return { values: out, order };
}

/** 就地改写 key=value 行，保留注释与顺序；文件里没有的键追加到末尾 */
function setProps(text, updates) {
  const lines = splitLines(text);
  const pending = new Map(updates.map(u => [u.key, u]));
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*([A-Za-z0-9_.\-]+)\s*=(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (pending.has(m[1])) {
      lines[i] = m[1] + '=' + pending.get(m[1]).value;
      pending.delete(m[1]);
    }
  }
  if (pending.size) {
    if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
    for (const [k, u] of pending) lines.push(k + '=' + u.value);
  }
  return lines.join('\n');
}

/* ---------------------------------------------- 属性元数据（MC 26.2 实测） */

/** 属性 → itzg 环境变量（取自镜像内 /image/property-definitions.json） */
const PROP_ENV = {
  'accepts-transfers': 'ACCEPTS_TRANSFERS',
  'allow-flight': 'ALLOW_FLIGHT',
  'allow-nether': 'ALLOW_NETHER',
  'broadcast-console-to-ops': 'BROADCAST_CONSOLE_TO_OPS',
  'broadcast-rcon-to-ops': 'BROADCAST_RCON_TO_OPS',
  'bug-report-link': 'BUG_REPORT_LINK',
  'difficulty': 'DIFFICULTY',
  'enable-command-block': 'ENABLE_COMMAND_BLOCK',
  'enable-jmx-monitoring': 'ENABLE_JMX',
  'enable-query': 'ENABLE_QUERY',
  'enable-rcon': 'ENABLE_RCON',
  'enable-status': 'ENABLE_STATUS',
  'enforce-secure-profile': 'ENFORCE_SECURE_PROFILE',
  'enforce-whitelist': 'ENFORCE_WHITELIST',
  'entity-broadcast-range-percentage': 'ENTITY_BROADCAST_RANGE_PERCENTAGE',
  'force-gamemode': 'FORCE_GAMEMODE',
  'function-permission-level': 'FUNCTION_PERMISSION_LEVEL',
  'gamemode': 'MODE',
  'generate-structures': 'GENERATE_STRUCTURES',
  'generator-settings': 'GENERATOR_SETTINGS',
  'hardcore': 'HARDCORE',
  'hide-online-players': 'HIDE_ONLINE_PLAYERS',
  'initial-disabled-packs': 'INITIAL_DISABLED_PACKS',
  'initial-enabled-packs': 'INITIAL_ENABLED_PACKS',
  'level-name': 'LEVEL',
  'level-seed': 'SEED',
  'level-type': 'LEVEL_TYPE',
  'log-ips': 'LOG_IPS',
  'management-server-allowed-origins': 'MANAGEMENT_SERVER_ALLOWED_ORIGINS',
  'management-server-enabled': 'MANAGEMENT_SERVER_ENABLED',
  'management-server-host': 'MANAGEMENT_SERVER_HOST',
  'management-server-port': 'MANAGEMENT_SERVER_PORT',
  'management-server-secret': 'MANAGEMENT_SERVER_SECRET',
  'management-server-tls-enabled': 'MANAGEMENT_SERVER_TLS_ENABLED',
  'management-server-tls-keystore': 'MANAGEMENT_SERVER_TLS_KEYSTORE',
  'management-server-tls-keystore-password': 'MANAGEMENT_SERVER_TLS_KEYSTORE_PASSWORD',
  'max-chained-neighbor-updates': 'MAX_CHAINED_NEIGHBOR_UPDATES',
  'max-players': 'MAX_PLAYERS',
  'max-tick-time': 'MAX_TICK_TIME',
  'max-world-size': 'MAX_WORLD_SIZE',
  'motd': 'MOTD',
  'network-compression-threshold': 'NETWORK_COMPRESSION_THRESHOLD',
  'online-mode': 'ONLINE_MODE',
  'op-permission-level': 'OP_PERMISSION_LEVEL',
  'pause-when-empty-seconds': 'PAUSE_WHEN_EMPTY_SECONDS',
  'player-idle-timeout': 'PLAYER_IDLE_TIMEOUT',
  'prevent-proxy-connections': 'PREVENT_PROXY_CONNECTIONS',
  'pvp': 'PVP',
  'query.port': 'QUERY_PORT',
  'rate-limit': 'RATE_LIMIT',
  'rcon.password': 'RCON_PASSWORD',
  'rcon.port': 'RCON_PORT',
  'region-file-compression': 'REGION_FILE_COMPRESSION',
  'require-resource-pack': 'RESOURCE_PACK_ENFORCE',
  'resource-pack': 'RESOURCE_PACK',
  'resource-pack-id': 'RESOURCE_PACK_ID',
  'resource-pack-prompt': 'RESOURCE_PACK_PROMPT',
  'resource-pack-sha1': 'RESOURCE_PACK_SHA1',
  'server-ip': 'SERVER_IP',
  'server-port': 'SERVER_PORT',
  'simulation-distance': 'SIMULATION_DISTANCE',
  'spawn-protection': 'SPAWN_PROTECTION',
  'status-heartbeat-interval': 'STATUS_HEARTBEAT_INTERVAL',
  'sync-chunk-writes': 'SYNC_CHUNK_WRITES',
  'use-native-transport': 'USE_NATIVE_TRANSPORT',
  'view-distance': 'VIEW_DISTANCE',
  'white-list': 'WHITELIST_PROP',
};

const GM = [{ v: 'survival', label: '生存' }, { v: 'creative', label: '创造' },
            { v: 'adventure', label: '冒险' }, { v: 'spectator', label: '旁观' }];

/**
 * 属性元数据：type = bool | enum | int | text
 * 只有这里登记过的键才会被强类型校验；未登记的键按「原样字符串」处理。
 */
const PROP_SCHEMA = {
  'online-mode': { group: 'access', label: '正版验证', type: 'bool',
    help: 'true = 只允许正版账号登录；false = 允许离线（盗版）客户端。改完必须重启。' },
  'white-list': { group: 'access', label: '启用白名单', type: 'bool',
    help: '开启后只有白名单里的玩家能进。名单在「玩家管理」里维护。' },
  'enforce-whitelist': { group: 'access', label: '踢出不在白名单的在线玩家', type: 'bool' },
  'max-players': { group: 'access', label: '最大玩家数', type: 'int', min: 1, max: 1000 },
  'motd': { group: 'access', label: '服务器标语（MOTD）', type: 'text', maxLen: 300 },
  'player-idle-timeout': { group: 'access', label: '挂机踢出（分钟，0=不踢）', type: 'int', min: 0, max: 1440 },
  'hide-online-players': { group: 'access', label: '对外隐藏在线玩家列表', type: 'bool' },
  'log-ips': { group: 'access', label: '日志记录玩家 IP', type: 'bool' },
  'enforce-secure-profile': { group: 'access', label: '强制安全聊天签名', type: 'bool',
    help: '离线（盗版）服建议 false，否则部分客户端聊天会受限。' },
  'prevent-proxy-connections': { group: 'access', label: '阻止代理连接', type: 'bool' },

  'gamemode': { group: 'gameplay', label: '默认游戏模式', type: 'enum', options: GM,
    help: '新玩家首次进服的默认模式；对老玩家不追溯。已在线的玩家请用「运行时控制」里的切换。' },
  'force-gamemode': { group: 'gameplay', label: '强制游戏模式', type: 'bool',
    help: '每次登录都把玩家拉回默认模式。' },
  'difficulty': { group: 'gameplay', label: '难度', type: 'enum',
    options: [{ v: 'peaceful', label: '和平' }, { v: 'easy', label: '简单' },
              { v: 'normal', label: '普通' }, { v: 'hard', label: '困难' }] },
  'hardcore': { group: 'gameplay', label: '极限模式', type: 'bool', help: '死亡即封禁（不可逆，慎改）。' },
  'pvp': { group: 'gameplay', label: '允许玩家互相伤害', type: 'bool' },
  'allow-flight': { group: 'gameplay', label: '允许飞行', type: 'bool', help: '生存模式下关掉可能误踢用飞行外挂/鞘翅的玩家。' },
  'allow-nether': { group: 'gameplay', label: '允许进入下界', type: 'bool' },

  'level-name': { group: 'world', label: '存档目录名', type: 'text', maxLen: 64, pattern: '^[A-Za-z0-9_.\\- ]{1,64}$',
    help: '改它等于换存档，且原世界不会被删除。慎改。' },
  'level-seed': { group: 'world', label: '世界种子', type: 'text', maxLen: 64,
    help: '只在生成新世界时生效；已有存档不受影响。' },
  'generate-structures': { group: 'world', label: '生成结构（村庄/遗迹等）', type: 'bool' },
  'spawn-protection': { group: 'world', label: '出生点保护半径（格，0=关闭）', type: 'int', min: 0, max: 10000 },
  'max-world-size': { group: 'world', label: '世界边界半径上限', type: 'int', min: 1, max: 29999984 },

  'op-permission-level': { group: 'command', label: 'OP 权限等级', type: 'enum',
    options: [{ v: '1', label: '1 · 可控重生点/绕过出生点保护' },
              { v: '2', label: '2 · 可用大部分单机命令（含 /gamemode）' },
              { v: '3', label: '3 · 可用 /ban /kick /op 等管理命令' },
              { v: '4', label: '4 · 完整权限（含命令方块/材质包）' }],
    help: '当前 OP 名单在这里维护：见「玩家管理」。MinePilot 的 AI 管理命令要求等级 2 以上。' },
  'function-permission-level': { group: 'command', label: '函数文件权限等级', type: 'enum',
    options: [{ v: '1', label: '1' }, { v: '2', label: '2' }, { v: '3', label: '3' }, { v: '4', label: '4' }] },
  'broadcast-console-to-ops': { group: 'command', label: '把控制台输出广播给 OP', type: 'bool' },
  'broadcast-rcon-to-ops': { group: 'command', label: '把 RCON 输出广播给 OP', type: 'bool' },

  'server-port': { group: 'network', label: '服务端口（容器内）', type: 'int', min: 1, max: 65535,
    help: '⚠️ 只改这里不改 compose 的端口映射，外部就连不上。两边要一起改。' },
  'server-ip': { group: 'network', label: '绑定网卡地址', type: 'text', maxLen: 64, help: '留空 = 绑定所有网卡。' },
  'view-distance': { group: 'network', label: '视距（区块）', type: 'int', min: 2, max: 32,
    help: '越大越吃内存与带宽。AI 场景建议 6–10。' },
  'simulation-distance': { group: 'network', label: '模拟距离（区块）', type: 'int', min: 2, max: 32 },
  'enable-status': { group: 'network', label: '响应服务器列表查询', type: 'bool' },
  'enable-query': { group: 'network', label: '启用 Query 协议', type: 'bool' },
  'query.port': { group: 'network', label: 'Query 端口', type: 'int', min: 1, max: 65535 },
  'enable-rcon': { group: 'network', label: '启用 RCON', type: 'bool',
    help: '⚠️ 关掉它，本面板的「运行时控制」「玩家管理」「在线玩家」会全部失效。' },
  'rcon.port': { group: 'network', label: 'RCON 端口', type: 'int', min: 1, max: 65535 },
  'rate-limit': { group: 'network', label: '同 IP 连接速率上限（0=不限）', type: 'int', min: 0, max: 10000 },
  'network-compression-threshold': { group: 'network', label: '网络压缩阈值（字节，-1=关闭）', type: 'int', min: -1, max: 65536 },
  'entity-broadcast-range-percentage': { group: 'network', label: '实体广播范围（%）', type: 'int', min: 10, max: 1000 },
};

const PROP_GROUPS = [
  { id: 'access', title: '联机与准入' },
  { id: 'gameplay', title: '玩法模式' },
  { id: 'world', title: '世界' },
  { id: 'command', title: '命令与权限' },
  { id: 'network', title: '网络与性能' },
  { id: 'other', title: '其他（原样编辑）' },
];

/* ------------------------------------------------------------------ 校验 */

function isValidBaseUrl(v) {
  if (typeof v !== 'string' || !v.length || v.length > 2048) return '地址为空或过长';
  let u;
  try { u = new URL(v); } catch (e) { return '不是合法的 URL'; }
  if (!u.protocol || !u.host) return '缺少协议或主机名';
  if (u.username || u.password) return '不能带用户名密码';
  if (u.search) return '不能带 ? 查询串';
  if (u.hash) return '不能带 # 片段';
  const scheme = u.protocol.toLowerCase();
  if (scheme === 'https:') return null;
  if (scheme !== 'http:') return '只允许 http 或 https';
  const h = u.hostname.toLowerCase();
  const loopback = h === 'localhost' || h.endsWith('.localhost') || h === '::1'
    || h === '0:0:0:0:0:0:0:1' || h === '127.0.0.1' || h.startsWith('127.');
  return loopback ? null : 'http 只允许 localhost / 127.x / ::1，远程请用 https';
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function validateConfig(c) {
  const errs = {};
  const e1 = isValidBaseUrl(c.baseUrl);
  if (e1) errs.baseUrl = e1;
  if (typeof c.name !== 'string' || c.name.length > 256) errs.name = '模型名最长 256 字符';
  const soft = Number(c.softTimeoutSeconds);
  if (!Number.isInteger(soft) || soft < MIN.soft || soft > MIN.softMax) errs.softTimeoutSeconds = '范围 1–89';
  const hard = Number(c.hardTimeoutSeconds);
  if (!Number.isInteger(hard) || hard < MIN.hard || hard > MIN.hardMax) errs.hardTimeoutSeconds = '范围 2–300';
  if (!errs.softTimeoutSeconds && !errs.hardTimeoutSeconds && soft > hard - 1) {
    errs.softTimeoutSeconds = '软超时必须小于硬超时（实际会取 min(软, 硬-1)）';
  }
  const mp = Number(c.mcpPort);
  if (!Number.isInteger(mp) || mp < MIN.mcpPort || mp > MIN.mcpPortMax) errs.mcpPort = '范围 1024–65535';
  for (const [k, label] of [['chatAllowed', 'chat'], ['waypointAllowed', 'waypoints']]) {
    const list = c[k] || [];
    if (!Array.isArray(list)) { errs[k] = '必须是数组'; continue; }
    const bad = list.find(x => !UUID_RE.test(String(x).trim()));
    if (bad) errs[k] = '不是合法 UUID: ' + bad;
  }
  return errs;
}

/** 按元数据校验单个服务器属性；返回错误串或 null */
function validateProp(key, value, schema) {
  const raw = String(value === undefined || value === null ? '' : value);
  if (/[\r\n\u0000]/.test(raw)) return '不能包含换行或控制字符';
  const s = schema || {};
  switch (s.type) {
    case 'bool':
      return (raw === 'true' || raw === 'false') ? null : '只能是 true 或 false';
    case 'enum':
      return s.options.some(o => o.v === raw) ? null : '取值必须是：' + s.options.map(o => o.v).join(' / ');
    case 'int': {
      if (!/^-?\d+$/.test(raw)) return '必须是整数';
      const n = parseInt(raw, 10);
      if (s.min !== undefined && n < s.min) return '不能小于 ' + s.min;
      if (s.max !== undefined && n > s.max) return '不能大于 ' + s.max;
      return null;
    }
    case 'text': {
      if (s.maxLen && raw.length > s.maxLen) return '最长 ' + s.maxLen + ' 字符';
      if (s.pattern && !new RegExp(s.pattern).test(raw)) return '格式不合法';
      return null;
    }
    default:
      // 未登记：只做通用安全限制
      if (raw.length > 2048) return '值过长';
      return null;
  }
}

/* ------------------------------------------------------------- Docker API */

function dockerRaw(method, apiPath, { body, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath: SOCK, path: apiPath, method,
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {},
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }));
    });
    req.setTimeout(timeout, () => req.destroy(new Error('docker api timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function dockerJson(method, apiPath, opts) {
  const r = await dockerRaw(method, apiPath, opts);
  const text = r.buf.toString('utf8');
  if (r.status >= 400) throw new Error('docker ' + r.status + ': ' + text.slice(0, 300));
  try { return JSON.parse(text); } catch (e) { return {}; }
}

const inspect = () => dockerJson('GET', `/containers/${MC}/json`);

/** 容器日志：tty=true 时是裸文本，否则是 8 字节帧头复用的流 */
function demuxLogs(buf, tty) {
  if (tty) return buf.toString('utf8');
  const parts = [];
  let o = 0;
  while (o + 8 <= buf.length) {
    const len = buf.readUInt32BE(o + 4);
    if (len > buf.length - o - 8) { parts.push(buf.slice(o + 8).toString('utf8')); break; }
    parts.push(buf.slice(o + 8, o + 8 + len).toString('utf8'));
    o += 8 + len;
  }
  return parts.join('');
}

/** 容器带 tty 时日志里混有 ANSI 颜色、回车和分页残留，先清干净再给前端 */
function cleanLogs(text) {
  return text
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')   // 颜色/光标控制
    .replace(/\x1b\][^\x07]*\x07/g, '')       // OSC 序列
    .replace(/\r/g, '\n')                     // 回车当换行，避免整行被覆盖
    .replace(/^>\.{4}/gm, '')
    .replace(/>\.{4}/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map(l => l.replace(/\s+$/, '')).join('\n');
}

async function fetchLogs(tail, tty) {
  const r = await dockerRaw('GET',
    `/containers/${MC}/logs?stdout=true&stderr=true&timestamps=false&tail=${tail}`, { timeout: 20000 });
  return cleanLogs(demuxLogs(r.buf, tty));
}

async function containerState() {
  try {
    const j = await inspect();
    const st = j.State || {};
    return {
      ok: true,
      name: MC,
      status: st.Status || 'unknown',
      running: !!st.Running,
      health: (st.Health && st.Health.Status) || null,
      startedAt: st.StartedAt || null,
      uptimeSeconds: st.StartedAt && st.Running ? Math.floor((Date.now() - Date.parse(st.StartedAt)) / 1000) : 0,
      exitCode: st.ExitCode,
      image: (j.Config && j.Config.Image) || null,
      tty: !!(j.Config && j.Config.Tty),
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

async function waitRunning(want, capMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < capMs) {
    const s = await containerState();
    if (s.ok && s.running === want) return s;
    await sleep(2000);
  }
  return containerState();
}

/* ------------------------------------------------------------------ RCON */

function rconCommand(cmd, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    if (!RCON_PASS) return reject(new Error('no rcon password'));
    const s = net.connect({ host: RCON_HOST, port: RCON_PORT });
    let buf = Buffer.alloc(0);
    let authed = false;
    let acc = '';
    let idle = null;
    let settled = false;

    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      if (idle) clearTimeout(idle);
      try { s.destroy(); } catch (e) {}
      if (err) reject(err); else resolve(val);
    };

    s.setTimeout(timeoutMs, () => finish(new Error('rcon timeout')));

    // 包格式: [len:int32LE][id:int32LE][type:int32LE][body][0x00 0x00]
    // len 覆盖 id+type+body+2，所以总长 = 4 + len = 14 + body.length
    const send = (pktId, type, body) => {
      const b = Buffer.from(body, 'utf8');
      const p = Buffer.alloc(14 + b.length);
      p.writeInt32LE(10 + b.length, 0);
      p.writeInt32LE(pktId, 4);
      p.writeInt32LE(type, 8);
      b.copy(p, 12);
      s.write(p);
    };

    s.on('connect', () => send(1, 3, RCON_PASS));
    s.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 4) return;
        const len = buf.readInt32LE(0);
        if (len < 10 || buf.length < 4 + len) return;
        const pkt = buf.slice(4, 4 + len);
        buf = buf.slice(4 + len);
        const rid = pkt.readInt32LE(0);
        const type = pkt.readInt32LE(4);
        const body = pkt.slice(8, len - 2).toString('utf8');
        if (!authed) {
          // 有些实现会先发一个空的 RESPONSE_VALUE，必须等到 type=2 的 AUTH_RESPONSE
          if (type === 2) {
            if (rid === -1) return finish(new Error('rcon auth failed'));
            authed = true;
            send(2, 2, cmd);
          }
          continue;
        }
        if (type === 0 && rid === 2) {
          acc += body;
          if (idle) clearTimeout(idle);
          idle = setTimeout(() => finish(null, acc), 350);   // 静默即认为响应结束
        }
      }
    });
    s.on('error', e => finish(e));
  });
}

/** 一次连接、顺序执行多条命令。规则批量查询用它，避免每条命令都新开 TCP。 */
function rconBulk(cmds, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!RCON_PASS) return reject(new Error('no rcon password'));
    if (!cmds.length) return resolve([]);
    const s = net.connect({ host: RCON_HOST, port: RCON_PORT });
    let buf = Buffer.alloc(0);
    let authed = false;
    let idx = 0;
    let acc = '';
    let idle = null;
    let settled = false;
    const results = new Array(cmds.length).fill('');

    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (idle) clearTimeout(idle);
      try { s.destroy(); } catch (e) {}
      if (err) reject(err); else resolve(results);
    };

    s.setTimeout(timeoutMs, () => finish(new Error('rcon timeout')));

    const send = (pktId, type, body) => {
      const b = Buffer.from(body, 'utf8');
      const p = Buffer.alloc(14 + b.length);
      p.writeInt32LE(10 + b.length, 0);
      p.writeInt32LE(pktId, 4);
      p.writeInt32LE(type, 8);
      b.copy(p, 12);
      s.write(p);
    };

    const next = () => {
      if (idx >= cmds.length) return finish(null);
      acc = '';
      send(2 + idx, 2, cmds[idx]);
    };

    s.on('connect', () => send(1, 3, RCON_PASS));
    s.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 4) return;
        const len = buf.readInt32LE(0);
        if (len < 10 || buf.length < 4 + len) return;
        const pkt = buf.slice(4, 4 + len);
        buf = buf.slice(4 + len);
        const rid = pkt.readInt32LE(0);
        const type = pkt.readInt32LE(4);
        const body = pkt.slice(8, len - 2).toString('utf8');
        if (!authed) {
          if (type === 2) {
            if (rid === -1) return finish(new Error('rcon auth failed'));
            authed = true;
            next();
          }
          continue;
        }
        if (type !== 0) continue;
        const i = rid - 2;
        if (i === idx) acc += body;
        else if (i === idx - 1) { results[i] += body; }   // 迟到的分包
        else continue;
        if (idle) clearTimeout(idle);
        // RCON 没有「响应结束」标记，只能靠「静默即结束」。单连接批量跑几十条时这个间隔
        // 直接决定总耗时（44 条 × 320ms = 14s，用户干等），docker bridge 上实测往返 <20ms，
        // 150ms 仍有 7 倍余量。宁可多留余量也别截断：截断只会让规则显示错值。
        idle = setTimeout(() => {
          results[idx] = acc;
          idx++;
          next();
        }, 150);
      }
    });
    s.on('error', e => finish(e));
  });
}

/** 离线模式 UUID（md5("OfflinePlayer:"+name)，version 3 / variant 10） */
function offlineUuid(name) {
  const b = Buffer.from(crypto.createHash('md5').update('OfflinePlayer:' + name, 'utf8').digest());
  b[6] = (b[6] & 0x0f) | 0x30;
  b[8] = (b[8] & 0x3f) | 0x80;
  const x = b.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** 在线玩家：用 `list uuids` 拿「名字 (UUID)」，并判定真人 / mod 自建无头玩家 */
async function onlinePlayers() {
  try {
    const out = (await rconCommand('list uuids')).trim();
    const m = /are (\d+) of a max of (\d+) players online:\s*(.*)$/i.exec(out);
    const count = m ? parseInt(m[1], 10) : 0;
    const max = m ? parseInt(m[2], 10) : null;
    const tail = m ? m[3].trim() : '';
    const players = [];
    if (tail) {
      const re = /([A-Za-z0-9_]{1,16})\s*\(([0-9a-fA-F-]{36})\)/g;
      let mm;
      while ((mm = re.exec(tail))) players.push({ name: mm[1], uuid: mm[2].toLowerCase() });
      if (!players.length) {
        tail.split(',').map(s => s.trim()).filter(Boolean).forEach(n => players.push({ name: n, uuid: null }));
      }
    }
    for (const p of players) {
      p.kind = !p.uuid ? 'unknown' : (offlineUuid(p.name) === p.uuid ? 'human' : 'bot');
    }
    return { ok: true, count, max, names: players.map(p => p.name), players };
  } catch (e) {
    return { ok: false, error: String(e.message || e), names: [], players: [] };
  }
}

/* -------------------------------------------- 结构化 RCON 动作（白名单） */

const RE_PLAYER = /^[A-Za-z0-9_]{1,16}$/;          // MC 用户名
const RE_RULE = /^[a-z][a-z0-9_]{0,63}$/;          // MC 26.2 规则名（snake_case）
const RE_TEXT = /[\r\n\u0000-\u001f]/g;

/**
 * 把结构化动作翻译成 MC 命令。**不存在任意命令直通**，
 * 参数一律先校验再拼接，确保面板被拿下也拿不到通用命令执行。
 */
function buildRconCommand(op, a) {
  a = a || {};
  const intOrThrow = (v, lo, hi, label) => {
    if (!/^-?\d+$/.test(String(v))) throw new Error(label + ' 必须是整数');
    const n = parseInt(v, 10);
    if (n < lo || n > hi) throw new Error(label + ' 范围 ' + lo + '–' + hi);
    return n;
  };
  switch (op) {
    case 'weather': {
      if (!['clear', 'rain', 'thunder'].includes(a.kind)) throw new Error('天气类型不合法');
      const hasDur = a.seconds !== undefined && a.seconds !== null && a.seconds !== '';
      const d = hasDur ? intOrThrow(a.seconds, 1, 1000000, '持续时间（秒）') : null;
      return `weather ${a.kind}` + (d ? ' ' + d : '');
    }
    case 'time': {
      if (['day', 'noon', 'night', 'midnight'].includes(a.marker)) return `time set ${a.marker}`;
      const t = intOrThrow(a.ticks, 0, 24000, '时间（tick）');
      return `time set ${t}`;
    }
    case 'timeFreeze': {
      if (!['pause', 'resume'].includes(a.state)) throw new Error('state 必须是 pause / resume');
      return `time ${a.state}`;
    }
    case 'gamerule': {
      const name = String(a.name || '').trim();
      if (!RE_RULE.test(name)) throw new Error('规则名不合法（小写字母开头，可含数字和下划线）');
      if (a.value === undefined || a.value === null || a.value === '') return `gamerule ${name}`;
      let v = a.value;
      if (typeof v === 'boolean') v = v ? 'true' : 'false';
      else {
        v = String(v).trim();
        if (!/^(true|false|-?\d{1,9})$/.test(v)) throw new Error('规则值只能是 true / false / 整数');
      }
      return `gamerule ${name} ${v}`;
    }
    case 'gamemode': {
      if (!GM.some(g => g.v === a.mode)) throw new Error('游戏模式不合法');
      if (a.player !== undefined && a.player !== null && a.player !== '') {
        if (!RE_PLAYER.test(String(a.player))) throw new Error('玩家名不合法');
        return `gamemode ${a.mode} ${a.player}`;
      }
      return `gamemode ${a.mode}`;
    }
    case 'defaultgamemode': {
      if (!GM.some(g => g.v === a.mode)) throw new Error('游戏模式不合法');
      return `defaultgamemode ${a.mode}`;
    }
    case 'difficulty': {
      if (!['peaceful', 'easy', 'normal', 'hard'].includes(a.level)) throw new Error('难度不合法');
      return `difficulty ${a.level}`;
    }
    case 'say': {
      const t = String(a.text || '').replace(RE_TEXT, ' ').trim().slice(0, 200);
      if (!t) throw new Error('消息不能为空');
      return `say ${t}`;
    }
    case 'op': case 'deop': case 'pardon': case 'kick': case 'ban': {
      if (!RE_PLAYER.test(String(a.player || ''))) throw new Error('玩家名不合法');
      if (op === 'kick' || op === 'ban') {
        const r = String(a.reason || '').replace(RE_TEXT, ' ').trim().slice(0, 100);
        return `${op} ${a.player}` + (r ? ' ' + r : '');
      }
      return `${op} ${a.player}`;
    }
    case 'whitelist': {
      if (a.action === 'list' || a.action === 'reload') return `whitelist ${a.action}`;
      if (a.action === 'add' || a.action === 'remove') {
        if (!RE_PLAYER.test(String(a.player || ''))) throw new Error('玩家名不合法');
        return `whitelist ${a.action} ${a.player}`;
      }
      throw new Error('whitelist 动作不合法');
    }
    case 'whitelistToggle': {
      if (!['on', 'off'].includes(a.state)) throw new Error('state 必须是 on / off');
      return `whitelist ${a.state}`;
    }
    case 'banlist': {
      if (a.kind && !['players', 'ips'].includes(a.kind)) throw new Error('banlist 类型不合法');
      return `banlist` + (a.kind ? ' ' + a.kind : '');
    }
    case 'query': {
      // 只读查询：**精确匹配**白名单，不接受任意命令
      const ALLOWED = new Set(['difficulty', 'time query gametime', 'time query time', 'list', 'list uuids']);
      const c = String(a.cmd || '').trim();
      if (!ALLOWED.has(c)) throw new Error('不允许的查询命令（只开放：' + [...ALLOWED].join(' / ') + '）');
      return c;
    }
    default:
      throw new Error('未知操作: ' + op);
  }
}

async function runRconAction(op, args) {
  const cmd = buildRconCommand(op, args);          // 先校验，非法直接抛
  const output = (await rconCommand(cmd)).trim();
  return { command: cmd, output };
}

/** 批量查询游戏规则当前值：一次连接跑完，避免 N 次握手 */
async function queryGamerules(names) {
  const out = {};
  const todo = [];
  for (const name of (names || []).slice(0, 80)) {
    if (!RE_RULE.test(name)) { out[name] = { ok: false, error: '规则名不合法' }; continue; }
    todo.push(name);
  }
  if (!todo.length) return out;
  let raws;
  try {
    raws = await rconBulk(todo.map(n => 'gamerule ' + n));
  } catch (e) {
    for (const n of todo) out[n] = { ok: false, error: String(e.message || e) };
    return out;
  }
  todo.forEach((name, i) => {
    const raw = String(raws[i] || '').trim();
    const m = /currently set to:\s*(.+)$/i.exec(raw);
    out[name] = m ? { ok: true, value: m[1].trim(), raw } : { ok: false, raw: raw.slice(0, 160) };
  });
  return out;
}

/* ------------------------------------------------------ 玩家/名单类文件 */

function readJsonArray(p) {
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(j) ? j : [];
  } catch (e) { return []; }
}

function readOps() {
  return readJsonArray(OPS_PATH)
    .map(o => ({ uuid: o.uuid, name: o.name, level: o.level, bypassesPlayerLimit: !!o.bypassesPlayerLimit }))
    .filter(o => o.name);
}
const readWhitelist = () => readJsonArray(WHITELIST_PATH).map(o => ({ uuid: o.uuid, name: o.name })).filter(o => o.name);
const readBanned = () => readJsonArray(BANNED_PATH)
  .map(o => ({ uuid: o.uuid, name: o.name, reason: o.reason || '', source: o.source || '', created: o.created || '' }))
  .filter(o => o.name);

/* --------------------------------------------------------- compose 子集 */

function readCompose() { return readText(COMPOSE_PATH, ''); }

/** 列出某个 service 里显式设置的 environment 变量名 */
function listComposeEnv(text, service = 'mc-server') {
  const names = new Set();
  if (!text) return names;
  const lines = splitLines(text);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s{2})([A-Za-z0-9_.\-]+):\s*$/.exec(lines[i]);
    if (m && m[2] === service) { start = i; break; }
  }
  if (start < 0) return names;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    const m2 = /^(\s{2})([A-Za-z0-9_.\-]+):\s*$/.exec(lines[i]);
    if (m2 || /^\S/.test(lines[i])) { end = i; break; }
  }
  for (let i = start + 1; i < end; i++) {
    const m = /^\s+([A-Z][A-Z0-9_]*)\s*:\s*(.*)$/.exec(lines[i]);
    if (m) names.add(m[1]);
  }
  return names;
}

/** 列出 compose 里被 # 注释掉的 environment 行（用于「接管」提示） */
function listComposeEnvAll(text, service = 'mc-server') {
  const all = new Map();
  if (!text) return all;
  const lines = splitLines(text);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s{2})([A-Za-z0-9_.\-]+):\s*$/.exec(lines[i]);
    if (m && m[2] === service) { start = i; break; }
  }
  if (start < 0) return all;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    const m2 = /^(\s{2})([A-Za-z0-9_.\-]+):\s*$/.exec(lines[i]);
    if (m2 || /^\S/.test(lines[i])) { end = i; break; }
  }
  for (let i = start + 1; i < end; i++) {
    let m = /^\s+([A-Z][A-Z0-9_]*)\s*:\s*(.*)$/.exec(lines[i]);
    if (m) { all.set(m[1], { value: m[2].trim(), commented: false }); continue; }
    m = /^\s*#\s*([A-Z][A-Z0-9_]*)\s*:\s*(.*)$/.exec(lines[i]);
    if (m) all.set(m[1], { value: m[2].trim(), commented: true });
  }
  return all;
}

/** 改写某个 service 的某个环境变量值；不存在则插到 environment: 之后 */
function setComposeEnv(text, service, key, value) {
  const lines = splitLines(text);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s{2})([A-Za-z0-9_.\-]+):\s*$/.exec(lines[i]);
    if (m && m[2] === service) { start = i; break; }
  }
  if (start < 0) return { text, changed: false, reason: 'compose 里找不到服务 ' + service };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    const m2 = /^(\s{2})([A-Za-z0-9_.\-]+):\s*$/.exec(lines[i]);
    if (m2 || /^\S/.test(lines[i])) { end = i; break; }
  }
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^(\\s+)(#\\s*)?' + esc + ':\\s*(.*)$');
  for (let i = start + 1; i < end; i++) {
    const m = re.exec(lines[i]);
    if (m) {
      const quoted = /^\s*["'].*["']\s*$/.test(m[3]);
      lines[i] = m[1] + key + ': ' + (quoted ? '"' + value + '"' : value);
      return { text: lines.join('\n'), changed: true, replaced: true };
    }
  }
  for (let i = start + 1; i < end; i++) {
    if (/^\s+environment:\s*$/.test(lines[i])) {
      const indent = /^(\s+)/.exec(lines[i])[1] + '  ';
      lines.splice(i + 1, 0, indent + key + ': "' + value + '"');
      return { text: lines.join('\n'), changed: true, inserted: true };
    }
  }
  return { text, changed: false, reason: 'compose 里 ' + service + ' 没有 environment 段' };
}

/** 把某个 service 的环境变量行注释掉（「交给 server.properties 管」） */
function disableComposeEnv(text, service, key) {
  const lines = splitLines(text);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s{2})([A-Za-z0-9_.\-]+):\s*$/.exec(lines[i]);
    if (m && m[2] === service) { start = i; break; }
  }
  if (start < 0) return { text, changed: false, reason: 'compose 里找不到服务 ' + service };
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^(\\s+)' + esc + ':\\s*(.*)$');
  for (let i = start + 1; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (m) {
      lines[i] = m[1] + '# ' + key + ': ' + m[2] +
        '   # 已由 server.properties 接管';
      return { text: lines.join('\n'), changed: true };
    }
  }
  return { text, changed: false, reason: 'compose 里没有 ' + key };
}

/* ------------------------------------------------ 服务器属性读取/写入 */

const PROP_BY_ENV = (() => {
  const m = {};
  for (const [p, e] of Object.entries(PROP_ENV)) m[e] = p;
  return m;
})();

/** 这些键是密钥，绝不随 API 回显明文；前端留空表示「不修改」 */
const SECRET_PROPS = new Set([
  'rcon.password',
  'management-server-secret',
  'management-server-tls-keystore-password',
]);
const SECRET_MASK = '••••••••';

/** 结合 compose 判断哪些属性被环境变量接管 */
function managedProps(composeText) {
  const envs = listComposeEnv(composeText, 'mc-server');
  const managed = {};
  for (const e of envs) {
    const p = PROP_BY_ENV[e];
    if (p) managed[p] = e;
  }
  return { managed, envs: [...envs] };
}

function readServerProps() {
  const text = readText(PROPS_PATH, '');
  const { values, order } = parseProps(text);
  const composeText = readCompose();
  const { managed, envs } = managedProps(composeText);
  const rendered = [];
  const seen = new Set();
  const push = k => {
    if (seen.has(k)) return;
    seen.add(k);
    const s = PROP_SCHEMA[k];
    const secret = SECRET_PROPS.has(k);
    rendered.push({
      key: k,
      value: secret ? (values[k] === undefined ? undefined : SECRET_MASK) : values[k],
      secret,
      readOnly: secret,
      hint: secret ? '请用上方「密码与令牌」卡片修改' : '',
      group: (s && s.group) || 'other',
      label: (s && s.label) || k,
      type: (s && s.type) || (secret ? 'secret' : 'text'),
      options: (s && s.options) || null,
      help: (s && s.help) || '',
      min: s && s.min, max: s && s.max, maxLen: s && s.maxLen, pattern: s && s.pattern,
      managedBy: managed[k] || null,
    });
  };
  order.forEach(push);
  Object.keys(PROP_SCHEMA).forEach(push);

  const groups = PROP_GROUPS.map(g => ({
    id: g.id, title: g.title,
    props: rendered.filter(p => p.group === g.id && p.value !== undefined),
  })).filter(g => g.props.length);

  return {
    ok: true,
    path: PROPS_PATH,
    exists: !!text,
    props: rendered.filter(p => p.value !== undefined).map(({ group, ...rest }) => rest),
    groups,
    managed,                       // { propKey: ENV_NAME }
    composePresent: !!composeText,
    composePath: COMPOSE_PATH,
    composeEnvs: envs,
    // 只读展示的敏感项（不回显明文以外的用途）
    rconPort: values['rcon.port'] || null,
    rconHasPassword: !!values['rcon.password'],
  };
}

/** 写入 server.properties；可选把被 env 接管的键同步进 compose。
 *  opts.validateOnly = true 时只做校验，不落盘（供「保存并重启」在停机前预检）。 */
function writePropsFile(changes, syncCompose, opts) {
  const text = readText(PROPS_PATH, '');
  if (!text) throw new Error('找不到 ' + PROPS_PATH);
  const { values } = parseProps(text);
  const composeText = readCompose();
  const { managed } = managedProps(composeText);

  const errs = {};
  const updates = [];
  const composeUpdates = [];
  for (const [k, vRaw] of Object.entries(changes || {})) {
    const v = String(vRaw === undefined || vRaw === null ? '' : vRaw);
    if (SECRET_PROPS.has(k)) {
      // 密钥类属性不走这条通路：Properties 写入无法同步 compose，会写出一致性缺陷。
      // 统一从「密码与令牌」卡片走 /api/vault，那里会同时改 properties 与 compose。
      if (v && v !== SECRET_MASK) {
        errs[k] = '密钥类属性请用「密码与令牌」卡片修改（需要同步 compose，这里改会不一致）';
      }
      continue;
    }
    if (values[k] !== undefined && String(values[k]) === v) continue;    // 没变，跳过
    const e = validateProp(k, v, PROP_SCHEMA[k]);
    if (e) { errs[k] = e; continue; }
    updates.push({ key: k, value: v });
    if (managed[k]) composeUpdates.push({ env: managed[k], value: v });
  }
  if (Object.keys(errs).length) return { ok: false, errors: errs };
  if (!updates.length) return { ok: true, wrote: false, note: '没有变化', composeWrites: [] };

  if (composeUpdates.length && !syncCompose) {
    return {
      ok: false,
      errors: Object.fromEntries(composeUpdates.map(u => {
        const prop = PROP_BY_ENV[u.env];
        return [prop, '该键由 compose 环境变量 ' + u.env + ' 管理，改 properties 会被重启覆盖；请勾选「同步到 compose」'];
      })),
    };
  }
  if (opts && opts.validateOnly) return { ok: true, validateOnly: true, changed: updates.map(u => u.key) };

  let composeWrites = [];
  if (composeUpdates.length && syncCompose) {
    let ct = composeText;
    for (const u of composeUpdates) {
      const r = setComposeEnv(ct, 'mc-server', u.env, u.value);
      if (!r.changed) return { ok: false, errors: { [PROP_BY_ENV[u.env]]: r.reason || 'compose 写入失败' } };
      ct = r.text;
      composeWrites.push(u.env);
    }
    writeText(COMPOSE_PATH, ct, 0o664);
  }

  writeText(PROPS_PATH, setProps(text, updates), 0o664);
  return {
    ok: true, wrote: true, changed: updates.map(u => u.key), composeWrites,
    note: composeWrites.length
      ? '已写入 server.properties 并同步 compose。新增/修改 compose 环境变量需要重新创建容器：docker compose up -d mc-server（仅 restart 不够）'
      : '已写入 server.properties，重启 mc-server 后生效',
  };
}

/* ------------------------------------------------------------ 后台任务 */

let JOB = { id: null, running: false, step: '', log: [], done: false, error: null, startedAt: 0 };

function jobStart(id) { JOB = { id, running: true, step: '准备', log: [], done: false, error: null, startedAt: Date.now() }; }
function jobStep(s) { JOB.step = s; JOB.log.push(s); log('[job]', s); }

/** 停止 → 写盘 → 启动。先停再写，避免 MC / Forge 退出时用内存值覆盖文件 */
async function applyAndRestart(payload) {
  jobStep('停止 ' + MC + '（等待存档落盘）');
  await dockerJson('POST', `/containers/${MC}/stop?t=120`);
  const st = await waitRunning(false, 150000);
  if (st.running) throw new Error('停止超时，容器仍在运行');
  jobStep('容器已停止');

  const writes = [];
  if (payload.config) { writeConfigFile(payload.config); writes.push('config/mcai-companion.toml'); }
  if (payload.apiKey) { writeApiKeyFile(payload.apiKey); writes.push('secrets/mcai-api-key'); }
  if (payload.props && Object.keys(payload.props).length) {
    const r = writePropsFile(payload.props, payload.syncCompose !== false);
    if (!r.ok) throw new Error('服务器属性写入失败: ' + JSON.stringify(r.errors));
    if (r.wrote) writes.push('server.properties' + (r.composeWrites.length ? ' + compose(' + r.composeWrites.join(',') + ')' : ''));
  }
  if (writes.length) jobStep('已写入 ' + writes.join(' + '));

  jobStep('启动 ' + MC);
  await dockerJson('POST', `/containers/${MC}/start`);
  const up = await waitRunning(true, 60000);
  if (!up.running) throw new Error('启动失败: ' + JSON.stringify(up));

  jobStep('等待服务就绪…');
  for (let i = 0; i < 40; i++) {
    await sleep(5000);
    const t = await fetchLogs(200, up.tty).catch(() => '');
    if (t.includes('For help, type')) { jobStep('服务已就绪'); return; }
  }
  jobStep('已启动，但 200 秒内未看到就绪标记（可查看日志）');
}

/* --------------------------------------------------------------- 写盘 */

function writeConfigFile(c) {
  let text = readText(TOML_PATH, '');
  if (!text) throw new Error('找不到 ' + TOML_PATH);
  const updates = [
    { section: 'model', key: 'baseUrl', literal: tomlString(c.baseUrl) },
    { section: 'model', key: 'name', literal: tomlString(c.name) },
    { section: 'model', key: 'softTimeoutSeconds', literal: String(c.softTimeoutSeconds) },
    { section: 'model', key: 'hardTimeoutSeconds', literal: String(c.hardTimeoutSeconds) },
    { section: 'mcp', key: 'enabled', literal: c.mcpEnabled ? 'true' : 'false' },
    { section: 'mcp', key: 'port', literal: String(c.mcpPort) },
    { section: 'chat', key: 'allowedSenders', literal: '[' + (c.chatAllowed || []).map(tomlString).join(', ') + ']' },
    { section: 'waypoints', key: 'allowedSenders', literal: '[' + (c.waypointAllowed || []).map(tomlString).join(', ') + ']' },
    { section: 'skin', key: 'autoImportFixedFile', literal: c.skinAutoImport ? 'true' : 'false' },
    { section: 'skin', key: 'armType', literal: tomlString(c.skinArmType) },
  ];
  writeText(TOML_PATH, setTomlValues(text, updates), 0o664);
}

function writeApiKeyFile(key) {
  const k = String(key).trim();
  if (k.length < 8) throw new Error('API Key 太短');
  if (/[\r\n]/.test(k)) throw new Error('API Key 不能包含换行');
  writeText(KEY_PATH, k, 0o600);
}

function apiKeyMeta() {
  try {
    const st = fs.statSync(KEY_PATH);
    const v = fs.readFileSync(KEY_PATH, 'utf8').trim();
    return { present: true, bytes: st.size, chars: v.length, mode: (st.mode & 0o777).toString(8) };
  } catch (e) { return { present: false }; }
}

function readConfig() {
  const t = parseToml(readText(TOML_PATH, ''));
  const g = (s, k, d) => (t[s] && t[s][k] !== undefined ? tomlScalar(t[s][k]) : d);
  return {
    baseUrl: g('model', 'baseUrl', ''),
    name: g('model', 'name', ''),
    softTimeoutSeconds: g('model', 'softTimeoutSeconds', 12),
    hardTimeoutSeconds: g('model', 'hardTimeoutSeconds', 90),
    mcpEnabled: g('mcp', 'enabled', false),
    mcpPort: g('mcp', 'port', 25766),
    chatAllowed: tomlArray(t.chat && t.chat.allowedSenders),
    waypointAllowed: tomlArray(t.waypoints && t.waypoints.allowedSenders),
    skinAutoImport: g('skin', 'autoImportFixedFile', true),
    skinArmType: g('skin', 'armType', 'CLASSIC'),
    activeVision: g('perception', 'activeVision', true),
  };
}

/* --------------------------------------------------------- 模型连通性 */

function httpJson(url, { method = 'GET', headers = {}, body, timeout = 25000 } = {}) {
  return new Promise(resolve => {
    let u; try { u = new URL(url); } catch (e) { return resolve({ ok: false, url, error: 'bad url' }); }
    const mod = u.protocol === 'https:' ? https : http;
    const t0 = Date.now();
    const req = mod.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method, headers,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        url, status: res.statusCode, ms: Date.now() - t0,
        snippet: Buffer.concat(chunks).toString('utf8').slice(0, 600),
      }));
    });
    req.setTimeout(timeout, () => { req.destroy(); resolve({ ok: false, url, error: 'timeout ' + timeout + 'ms' }); });
    req.on('error', e => resolve({ ok: false, url, error: String(e.message || e) }));
    if (body) req.write(body);
    req.end();
  });
}

async function testModel() {
  const c = readConfig();
  const key = readText(KEY_PATH, '').trim();
  const base = c.baseUrl.replace(/\/+$/, '');
  const auth = key ? { Authorization: 'Bearer ' + key } : {};
  const results = [];
  results.push(await httpJson(base + '/models', { headers: auth, timeout: 15000 }));
  results.push(await httpJson(base + '/chat/completions', {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: c.name, messages: [{ role: 'user', content: 'ping' }], max_tokens: 8 }),
    timeout: 40000,
  }));
  results.push(await httpJson(base + '/responses', {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: c.name, input: 'ping', max_output_tokens: 16 }),
    timeout: 40000,
  }));
  return { config: { baseUrl: c.baseUrl, name: c.name }, keyPresent: !!key, results };
}

/* --------------------------------------------------------------- HTTP */

function json(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
  res.end(b);
}

function readBody(req, cap = 1 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > cap) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function authed(req) {
  if (!TOKEN) return true;
  const h = req.headers['x-panel-token'] || '';
  const q = new URL(req.url, 'http://x').searchParams.get('token') || '';
  const given = String(h || q);
  if (given.length !== TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(TOKEN));
}

/* --------------------------------------------------------- 密码 / 令牌 */

const RE_SECRET = /^[A-Za-z0-9_\-.]{16,128}$/;   // 令牌：URL 安全字符
const RE_RCON_PW = /^[A-Za-z0-9_\-.]{8,64}$/;    // RCON 密码：避开 = # 空格

function changePanelToken(value) {
  const v = String(value || '').trim();
  if (!RE_SECRET.test(v)) return { ok: false, error: '令牌需 16–128 位，只能用字母、数字和 _ - .' };
  if (v === TOKEN) return { ok: false, error: '新令牌与当前相同' };
  const r = setComposeEnv(readCompose(), 'mcai-panel', 'PANEL_TOKEN', v);
  const res = { ok: true, appliedNow: true, composeWritten: false, note: '' };
  if (r.changed) { writeText(COMPOSE_PATH, r.text, 0o664); res.composeWritten = true; }
  TOKEN = v;                                       // 立即生效（当前浏览器需用新令牌重新登录）
  res.note = res.composeWritten
    ? '已立即生效。compose 已同步，执行 docker compose up -d mcai-panel 后永久保存（否则容器重建会回到旧令牌）。'
    : '已立即生效，但未能写入 compose（' + (r.reason || '未知原因') + '），容器重建后会回到旧令牌。';
  return res;
}

function changeRconPassword(value) {
  const v = String(value || '').trim();
  if (!RE_RCON_PW.test(v)) return { ok: false, error: 'RCON 密码需 8–64 位，只能用字母、数字和 _ - .（不能含 = # 空格）' };
  const text = readText(PROPS_PATH, '');
  if (!text) return { ok: false, error: '找不到 ' + PROPS_PATH };
  const cur = parseProps(text).values['rcon.password'];
  if (cur === v) return { ok: false, error: '新密码与当前相同' };
  if (!cur) return { ok: false, error: 'server.properties 里没有 rcon.password，请先在属性里启用 RCON' };

  writeText(PROPS_PATH, setProps(text, [{ key: 'rcon.password', value: v }]), 0o664);

  const written = [];
  let ct = readCompose();
  const r1 = setComposeEnv(ct, 'mc-server', 'RCON_PASSWORD', v);
  if (r1.changed) { ct = r1.text; written.push('mc-server.RCON_PASSWORD'); }
  const r2 = setComposeEnv(ct, 'mcai-panel', 'MC_RCON_PASSWORD', v);
  if (r2.changed) { ct = r2.text; written.push('mcai-panel.MC_RCON_PASSWORD'); }
  if (written.length) writeText(COMPOSE_PATH, ct, 0o664);

  return {
    ok: true,
    wroteProperties: true,
    composeWritten: written,
    note: written.length
      ? '已写 server.properties 与 compose。⚠️ 环境变量变更必须重建容器才生效：在宿主机执行 docker compose up -d mc-server mcai-panel。'
        + '在此之前，面板的 RCON 仍用旧密码连接（能正常查询），服务器重启后即一致。'
      : '已写 server.properties，但没能在 compose 里定位到 RCON_PASSWORD —— compose 下次创建容器可能把它改回旧值，请手工核对。',
  };
}

/* --------------------------------------------------------------- 路由 */

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  try {
    if (p === '/' || p === '/index.html') {
      const b = fs.readFileSync(INDEX);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(b);
    }
    if (p === '/api/ping') return json(res, 200, { ok: true, authRequired: !!TOKEN });

    if (!p.startsWith('/api/')) { res.writeHead(404); return res.end('not found'); }
    if (!authed(req)) return json(res, 401, { ok: false, error: 'unauthorized' });

    if (p === '/api/state' && req.method === 'GET') {
      const container = await containerState();
      const players = container.running ? await onlinePlayers() : { ok: false, names: [], players: [] };
      const logs = container.running ? (await fetchLogs(120, container.tty).catch(e => 'log error: ' + e.message)) : '';
      return json(res, 200, {
        ok: true,
        container, players, config: readConfig(), apiKey: apiKeyMeta(),
        job: JOB, logs,
        server: readServerProps(),
        players_mgmt: { ops: readOps(), whitelist: readWhitelist(), banned: readBanned() },
        envHints: { composeFile: COMPOSE_PATH, mcpTokenFromEnv: true },
      });
    }

    if (p === '/api/job' && req.method === 'GET') return json(res, 200, { ok: true, job: JOB });

    if (p === '/api/server' && req.method === 'GET') return json(res, 200, readServerProps());

    if (p === '/api/config' && req.method === 'POST') {
      const c = JSON.parse(await readBody(req) || '{}');
      const errs = validateConfig(c);
      if (Object.keys(errs).length) return json(res, 400, { ok: false, errors: errs });
      writeConfigFile(c);
      return json(res, 200, { ok: true, saved: true, note: '已写入，需重启 mc-server 生效' });
    }

    if (p === '/api/props' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const r = writePropsFile(body.props || {}, body.syncCompose !== false);
      return json(res, r.ok ? 200 : 400, r);
    }

    if (p === '/api/apikey' && req.method === 'POST') {
      const { key } = JSON.parse(await readBody(req) || '{}');
      try { writeApiKeyFile(key); } catch (e) { return json(res, 400, { ok: false, error: String(e.message) }); }
      return json(res, 200, { ok: true, saved: true, apiKey: apiKeyMeta() });
    }

    if (p === '/api/apply' && req.method === 'POST') {
      if (JOB.running) return json(res, 409, { ok: false, error: '已有任务在执行' });
      const payload = JSON.parse(await readBody(req) || '{}');
      if (payload.config) {
        const errs = validateConfig(payload.config);
        if (Object.keys(errs).length) return json(res, 400, { ok: false, errors: errs });
      }
      // 属性先做一次「试算」校验，避免停机后才发现写不进去
      if (payload.props && Object.keys(payload.props).length) {
        const dry = writePropsFile(payload.props, payload.syncCompose !== false, { validateOnly: true });
        if (!dry.ok) return json(res, 400, dry);
      }
      const id = crypto.randomBytes(6).toString('hex');
      jobStart(id);
      applyAndRestart(payload).then(() => { JOB.running = false; JOB.done = true; jobStep('完成'); })
        .catch(e => { JOB.running = false; JOB.done = true; JOB.error = String(e.message || e); JOB.log.push('失败: ' + JOB.error); log('[job] fail', JOB.error); });
      return json(res, 202, { ok: true, job: id });
    }

    if (p === '/api/action' && req.method === 'POST') {
      if (JOB.running) return json(res, 409, { ok: false, error: '已有任务在执行' });
      const { action } = JSON.parse(await readBody(req) || '{}');
      const id = crypto.randomBytes(6).toString('hex');
      jobStart(id);
      (async () => {
        if (action === 'restart') {
          jobStep('停止 ' + MC);
          await dockerJson('POST', `/containers/${MC}/stop?t=120`);
          await waitRunning(false, 150000);
          jobStep('启动 ' + MC);
          await dockerJson('POST', `/containers/${MC}/start`);
          await waitRunning(true, 60000);
          jobStep('已启动');
        } else if (action === 'stop') {
          jobStep('停止 ' + MC);
          await dockerJson('POST', `/containers/${MC}/stop?t=120`);
          await waitRunning(false, 150000);
          jobStep('已停止');
        } else if (action === 'start') {
          jobStep('启动 ' + MC);
          await dockerJson('POST', `/containers/${MC}/start`);
          await waitRunning(true, 60000);
          jobStep('已启动');
        } else {
          throw new Error('未知动作 ' + action);
        }
      })().then(() => { JOB.running = false; JOB.done = true; jobStep('完成'); })
        .catch(e => { JOB.running = false; JOB.done = true; JOB.error = String(e.message || e); JOB.log.push('失败: ' + JOB.error); });
      return json(res, 202, { ok: true, job: id });
    }

    if (p === '/api/rcon' && req.method === 'POST') {
      const { op, args, names } = JSON.parse(await readBody(req) || '{}');
      try {
        if (op === 'gameruleQuery') {
          const list = Array.isArray(names) ? names : [];
          return json(res, 200, { ok: true, op, rules: await queryGamerules(list) });
        }
        if (op === 'rconPasswordPeek') {
          return json(res, 200, { ok: true, configured: !!RCON_PASS, chars: RCON_PASS.length, host: RCON_HOST, port: RCON_PORT });
        }
        const r = await runRconAction(op, args);
        return json(res, 200, { ok: true, op, ...r });
      } catch (e) {
        return json(res, 400, { ok: false, error: String(e.message || e) });
      }
    }

    if (p === '/api/vault' && req.method === 'POST') {
      const { kind, value } = JSON.parse(await readBody(req) || '{}');
      let r;
      if (kind === 'panel') r = changePanelToken(value);
      else if (kind === 'rcon') r = changeRconPassword(value);
      else r = { ok: false, error: '未知目标: ' + kind };
      return json(res, r.ok ? 200 : 400, r);
    }

    if (p === '/api/compose/takeover' && req.method === 'POST') {
      // 把 compose 里接管某属性的环境变量注释掉，交给 server.properties 管
      const { prop } = JSON.parse(await readBody(req) || '{}');
      const env = PROP_ENV[prop];
      if (!env) return json(res, 400, { ok: false, error: '该属性没有对应的环境变量' });
      const r = disableComposeEnv(readCompose(), 'mc-server', env);
      if (!r.changed) return json(res, 400, { ok: false, error: r.reason || '未找到' });
      writeText(COMPOSE_PATH, r.text, 0o664);
      return json(res, 200, {
        ok: true, env, note: '已注释 compose 里的 ' + env + '。在宿主机执行 docker compose up -d mc-server 后，'
          + prop + ' 就完全由 server.properties 管理（在此之前 properties 的改动仍会被覆盖）。',
      });
    }

    if (p === '/api/test-model' && req.method === 'POST') {
      return json(res, 200, { ok: true, result: await testModel() });
    }

    res.writeHead(404); return res.end('not found');
  } catch (e) {
    log('error', e);
    return json(res, 500, { ok: false, error: String(e.message || e) });
  }
});

module.exports = {
  parseToml, setTomlValues, tomlScalar, tomlArray, validateConfig, isValidBaseUrl,
  readConfig, writeConfigFile, writeApiKeyFile, apiKeyMeta, demuxLogs, cleanLogs, rconCommand,
  // 新增
  parseProps, setProps, validateProp, PROP_SCHEMA, PROP_ENV, PROP_BY_ENV,
  listComposeEnv, listComposeEnvAll, setComposeEnv, disableComposeEnv, managedProps,
  readServerProps, writePropsFile, offlineUuid, buildRconCommand, runRconAction, queryGamerules,
  rconBulk,
  readOps, readWhitelist, readBanned, changePanelToken, changeRconPassword,
  paths: { TOML_PATH, KEY_PATH, PROPS_PATH, OPS_PATH, WHITELIST_PATH, BANNED_PATH, COMPOSE_PATH },
};
if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    log(`MinePilot config panel listening on 0.0.0.0:${PORT}`);
    log(`container=${MC} data=${DATA} auth=${TOKEN ? 'on' : 'OFF'} compose=${COMPOSE_PATH}`);
    if (!TOKEN) log('WARNING: PANEL_TOKEN 未设置，面板无鉴权！');
  });
}
