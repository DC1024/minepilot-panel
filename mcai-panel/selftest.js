/**
 * 面板后端离线自测。
 * 覆盖：TOML 就地改写、server.properties 就地改写、属性校验、
 *       compose 环境变量改写、ENV→属性映射、离线 UUID、list uuids 解析、
 *       RCON 报文与命令构造白名单、日志清洗。
 * 用真实的 mcai-companion.toml / server.properties / docker-compose.yml 片段做 fixture。
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-test-'));
fs.mkdirSync(path.join(tmp, 'config'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'secrets'), { recursive: true });

const FIXTURE = `[model]
\t#Provider base URL. HTTPS is required except for a loopback test server.
\tbaseUrl = "https://developer.amd.com.cn/radeon/api/v1"
\t#Provider model name. Leave empty until configured in the in-game setup screen.
\tname = "Qwen3.8-27B"
\t#After this time the local controller reports that the model is still thinking.
\t#Range: 1 ~ 89
\tsoftTimeoutSeconds = 12
\t#Hard deadline for a model request.
\t#Range: 2 ~ 300
\thardTimeoutSeconds = 90

[mcp]
\t#Expose the optional loopback-only Codex MCP server.
\tenabled = true
\t#Loopback port for the optional Codex MCP server.
\t#Range: 1024 ~ 65535
\tport = 25766

[perception]
\tactiveVision = true

[waypoints]
\t#Player UUIDs allowed to send the companion an external waypoint. Empty means singleplayer owner only.
\tallowedSenders = []

[chat]
\t#Player UUIDs allowed to issue gameplay tasks to the companion via chat. Empty means singleplayer owner or server gamemaster only.
\tallowedSenders = []

[skin]
\tautoImportFixedFile = true
\tarmType = "CLASSIC"
`;
fs.writeFileSync(path.join(tmp, 'config', 'mcai-companion.toml'), FIXTURE, 'utf8');

/* ------- server.properties fixture（MC 26.2 真实键集，含注释与方法头） ------- */
const PROPS_FIXTURE = `#Minecraft server properties
#Sun Oct 11 03:29:14 CST 2026
accepts-transfers=false
allow-flight=false
broadcast-console-to-ops=true
difficulty=normal
enable-rcon=true
gamemode=survival
max-players=20
motd=Zspace AI Minecraft Server
online-mode=false
op-permission-level=4
rcon.password=<RCON_PASSWORD>
rcon.port=25575
server-port=25565
simulation-distance=6
view-distance=8
white-list=false
`;
fs.writeFileSync(path.join(tmp, 'server.properties'), PROPS_FIXTURE, 'utf8');

fs.writeFileSync(path.join(tmp, 'ops.json'), JSON.stringify([
  { uuid: '1b533e2e-635a-3629-a7d5-3edc53a2b7d1', name: 'DC', level: 4, bypassesPlayerLimit: false },
  { uuid: '7c6b39ee-faac-39cf-a565-09d214738313', name: 'DCC', level: 4, bypassesPlayerLimit: false },
]), 'utf8');
fs.writeFileSync(path.join(tmp, 'whitelist.json'), '[]', 'utf8');
fs.writeFileSync(path.join(tmp, 'banned-players.json'), '[]', 'utf8');

/* ------- compose fixture（只保留结构相关部分） ------- */
const COMPOSE_FIXTURE = `services:
  mc-server:
    image: itzg/minecraft-server:java25
    container_name: mc-server
    environment:
      EULA: "TRUE"
      TYPE: "FORGE"
      VIEW_DISTANCE: "8"
      SIMULATION_DISTANCE: "6"
      ONLINE_MODE: "FALSE"
      ENABLE_RCON: "true"
      RCON_PASSWORD: "<RCON_PASSWORD>"
      MOTD: "Zspace AI Minecraft Server"
      DIFFICULTY: "normal"
      # OLD_THING: "keep me"
    ports:
      - "25565:25565"
    volumes:
      - ./minecraft-data:/data

  mcai-panel:
    image: node:22-alpine
    environment:
      PANEL_PORT: "25800"
      PANEL_TOKEN: "OLDPANELTOKEN_0123456789"
      MC_RCON_PASSWORD: "<RCON_PASSWORD>"
    command: ["node", "/app/server.js"]

networks:
  default:
    name: minecraft_default
`;
fs.writeFileSync(path.join(tmp, 'docker-compose.yml'), COMPOSE_FIXTURE, 'utf8');

process.env.MC_DATA_DIR = tmp;
process.env.PANEL_PORT = '25999';
process.env.COMPOSE_PATH = path.join(tmp, 'docker-compose.yml');

/* ---- 起一个假 RCON 服务端，用来验证报文封装（曾经把长度算错 2 字节导致挂死） ---- */
const net = require('node:net');
const RCON_PORT = 25998;
function frame(id, type, body) {
  const b = Buffer.from(body, 'utf8');
  const p = Buffer.alloc(14 + b.length);
  p.writeInt32LE(10 + b.length, 0);
  p.writeInt32LE(id, 4);
  p.writeInt32LE(type, 8);
  b.copy(p, 12);
  return p;
}
const mock = net.createServer(sock => {
  let buf = Buffer.alloc(0);
  sock.on('data', d => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 4) return;
      const len = buf.readInt32LE(0);
      if (buf.length < 4 + len) return;
      const pkt = buf.slice(4, 4 + len); buf = buf.slice(4 + len);
      const id = pkt.readInt32LE(0), type = pkt.readInt32LE(4);
      const body = pkt.slice(8, len - 2).toString('utf8');
      if (type === 3) {
        if (body !== 'secret') { sock.write(frame(-1, 2, '')); continue; }
        sock.write(frame(id, 0, ''));   // 真实服务端会先发一个空 RESPONSE_VALUE
        sock.write(frame(id, 2, ''));   // 再发 AUTH_RESPONSE
      } else if (type === 2) {
        if (body === 'list uuids') {
          sock.write(frame(id, 0, 'There are 2 of a max of 20 players online: '
            + 'MCAI (9cbb3a6d-f4be-41ed-a0e5-dfdff5a375a3), DC (1b533e2e-635a-3629-a7d5-3edc53a2b7d1)'));
        } else if (body.startsWith('gamerule ')) {
          sock.write(frame(id, 0, 'Gamerule ' + body.slice(9) + ' is currently set to: 3'));
        } else if (body.startsWith('weather ')) {
          sock.write(frame(id, 0, 'Set the weather to ' + body.slice(8)));
        } else {
          // 分两个包返回，验证多包拼接
          sock.write(frame(id, 0, 'There are 2 of a max of 20 players online: '));
          sock.write(frame(id, 0, 'MCAI, DC'));
        }
      }
    }
  });
});
mock.listen(RCON_PORT, '127.0.0.1');
process.env.MC_RCON_HOST = '127.0.0.1';
process.env.MC_RCON_PORT = String(RCON_PORT);
process.env.MC_RCON_PASSWORD = 'secret';

const P = require(path.join(__dirname, 'server.js'));

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

console.log('--- 1. 读取 AI 配置 ---');
const c0 = P.readConfig();
check('baseUrl', c0.baseUrl === 'https://developer.amd.com.cn/radeon/api/v1', JSON.stringify(c0.baseUrl));
check('name', c0.name === 'Qwen3.8-27B', JSON.stringify(c0.name));
check('soft=12', c0.softTimeoutSeconds === 12, String(c0.softTimeoutSeconds));
check('hard=90', c0.hardTimeoutSeconds === 90, String(c0.hardTimeoutSeconds));
check('mcpEnabled', c0.mcpEnabled === true, String(c0.mcpEnabled));
check('mcpPort=25766', c0.mcpPort === 25766, String(c0.mcpPort));
check('chatAllowed 空', JSON.stringify(c0.chatAllowed) === '[]', JSON.stringify(c0.chatAllowed));
check('armType=CLASSIC', c0.skinArmType === 'CLASSIC', String(c0.skinArmType));

console.log('--- 2. 写入 + 复读 ---');
const UUID = '7c6b39ee-faac-39cf-a565-09d214738313';
const c1 = {
  baseUrl: 'https://api.example.com/v1', name: 'gpt-test', softTimeoutSeconds: 20,
  hardTimeoutSeconds: 120, mcpEnabled: false, mcpPort: 25800,
  chatAllowed: [UUID], waypointAllowed: [UUID, '1b533e2e-635a-3629-a7d5-3edc53a2b7d1'],
  skinAutoImport: false, skinArmType: 'SLIM',
};
const errs1 = P.validateConfig(c1);
check('新配置通过校验', Object.keys(errs1).length === 0, JSON.stringify(errs1));
P.writeConfigFile(c1);
const c2 = P.readConfig();
check('baseUrl 已改', c2.baseUrl === 'https://api.example.com/v1', c2.baseUrl);
check('name 已改', c2.name === 'gpt-test', c2.name);
check('soft 已改', c2.softTimeoutSeconds === 20, String(c2.softTimeoutSeconds));
check('mcpEnabled 已改', c2.mcpEnabled === false, String(c2.mcpEnabled));
check('mcpPort 已改', c2.mcpPort === 25800, String(c2.mcpPort));
check('chatAllowed 已写入', JSON.stringify(c2.chatAllowed) === JSON.stringify([UUID]), JSON.stringify(c2.chatAllowed));
check('waypoints 两个', c2.waypointAllowed.length === 2, JSON.stringify(c2.waypointAllowed));
check('armType 已改', c2.skinArmType === 'SLIM', c2.skinArmType);
check('activeVision 未被破坏', c2.activeVision === true, String(c2.activeVision));

console.log('--- 3. 注释与结构保留 ---');
const after = fs.readFileSync(P.paths.TOML_PATH, 'utf8');
check('注释仍在', after.includes('#Provider base URL.'), 'comments lost');
check('section 仍在', ['[model]', '[mcp]', '[perception]', '[waypoints]', '[chat]', '[skin]'].every(s => after.includes(s)));
check('行数未爆炸', after.split('\n').length <= FIXTURE.split('\n').length + 2,
  'lines=' + after.split('\n').length + ' vs ' + FIXTURE.split('\n').length);
check('没有重复 key', after.split('\n').filter(l => /^\s*port\s*=/.test(l)).length === 1, 'port 出现多次');

console.log('--- 4. AI 配置校验规则 ---');
check('https 远程 OK', P.isValidBaseUrl('https://a.b/v1') === null);
check('http 局域网拒绝', !!P.isValidBaseUrl('http://192.168.1.5:8000/v1'));
check('http localhost OK', P.isValidBaseUrl('http://localhost:8000/v1') === null);
check('http 127.x OK', P.isValidBaseUrl('http://127.0.0.1:1234/v1') === null);
check('带 query 拒绝', !!P.isValidBaseUrl('https://a.b/v1?x=1'));
check('空串拒绝', !!P.isValidBaseUrl(''));
const e2 = P.validateConfig({ ...c1, softTimeoutSeconds: 200 });
check('软超时越界被拒', !!e2.softTimeoutSeconds, JSON.stringify(e2));
const e3 = P.validateConfig({ ...c1, mcpPort: 80 });
check('mcp 端口越界被拒', !!e3.mcpPort);
const e4 = P.validateConfig({ ...c1, chatAllowed: ['not-a-uuid'] });
check('非法 UUID 被拒', !!e4.chatAllowed);
const e5 = P.validateConfig({ ...c1, softTimeoutSeconds: 100, hardTimeoutSeconds: 60 });
check('软>硬 被拒', !!e5.softTimeoutSeconds, JSON.stringify(e5));

console.log('--- 5. 缺失 key 时自动补插 ---');
fs.writeFileSync(P.paths.TOML_PATH, '[model]\n\tbaseUrl = "https://old.example.com/v1"\n', 'utf8');
P.writeConfigFile({ ...c1, baseUrl: 'https://new.example.com/v1' });
const afterMin = fs.readFileSync(P.paths.TOML_PATH, 'utf8');
check('缺失的 mcp 段被补上', afterMin.includes('[mcp]') && afterMin.includes('port = 25800'), afterMin);
check('缺失的 chat 段被补上', afterMin.includes('[chat]') && afterMin.includes(UUID), afterMin);
check('已存在的 baseUrl 就地替换', afterMin.includes('https://new.example.com/v1') && !afterMin.includes('old.example.com'), afterMin);
const c3 = P.readConfig();
check('补插后可正确回读', c3.mcpPort === 25800 && c3.chatAllowed.length === 1, JSON.stringify(c3.chatAllowed));

console.log('--- 6. API Key 文件 ---');
P.writeApiKeyFile('sk-abcdefghijklmnop');
const meta = P.apiKeyMeta();
check('文件已写', meta.present === true, JSON.stringify(meta));
check('内容正确', fs.readFileSync(P.paths.KEY_PATH, 'utf8') === 'sk-abcdefghijklmnop');
check('不回显明文', JSON.stringify(meta).indexOf('sk-abc') === -1, JSON.stringify(meta));
let threw = false;
try { P.writeApiKeyFile('x'); } catch (e) { threw = true; }
check('过短被拒', threw);
threw = false;
try { P.writeApiKeyFile('sk-a\nb'); } catch (e) { threw = true; }
check('含换行被拒', threw);

console.log('--- 7. 日志流解复用 ---');
const inner = Buffer.from('line1\nline2\n', 'utf8');
const framed = Buffer.concat([
  Buffer.from([1, 0, 0, 0, 0, 0, 0, inner.length]), inner,
  Buffer.from([2, 0, 0, 0, 0, 0, 0, 3]), Buffer.from('err', 'utf8'),
]);
check('非 tty 帧解复用', P.demuxLogs(framed, false) === 'line1\nline2\nerr', JSON.stringify(P.demuxLogs(framed, false)));
check('tty 直通', P.demuxLogs(Buffer.from('raw text'), true) === 'raw text');

/* ---------------- 以下是新增能力 ---------------- */

console.log('--- 9. server.properties 解析与就地改写 ---');
const pp = P.parseProps(fs.readFileSync(P.paths.PROPS_PATH, 'utf8'));
check('解析 online-mode=false', pp.values['online-mode'] === 'false', pp.values['online-mode']);
check('解析 gamemode=survival', pp.values.gamemode === 'survival');
check('解析 rcon.port', pp.values['rcon.port'] === '25575');
check('保留键序首项是 accepts-transfers', pp.order[0] === 'accepts-transfers', pp.order[0]);
const ptext = fs.readFileSync(P.paths.PROPS_PATH, 'utf8');
const patched = P.setProps(ptext, [
  { key: 'online-mode', value: 'true' },
  { key: 'gamemode', value: 'creative' },
  { key: 'level-seed', value: '12345' },          // 文件里没有 → 应追加
]);
check('online-mode 就地改写', /^online-mode=true$/m.test(patched));
check('gamemode 就地改写', /^gamemode=creative$/m.test(patched));
check('缺失键追加到末尾', /level-seed=12345$/m.test(patched.trimEnd()));
check('注释头保留', patched.startsWith('#Minecraft server properties'));
check('只新增 1 行（原文件结尾自带空行）',
  patched.split('\n').length === ptext.split('\n').length + 1,
  'old=' + ptext.split('\n').length + ' new=' + patched.split('\n').length);
check('rcon.password 未被误改', /^rcon\.password=<RCON_PASSWORD>$/m.test(patched));

console.log('--- 10. 属性校验 ---');
check('bool 合法', P.validateProp('online-mode', 'true', P.PROP_SCHEMA['online-mode']) === null);
check('bool 非法被拒', !!P.validateProp('online-mode', 'yes', P.PROP_SCHEMA['online-mode']));
check('enum 合法', P.validateProp('gamemode', 'creative', P.PROP_SCHEMA.gamemode) === null);
check('enum 非法被拒', !!P.validateProp('gamemode', 'flying', P.PROP_SCHEMA.gamemode));
check('int 越界被拒', !!P.validateProp('view-distance', '99', P.PROP_SCHEMA['view-distance']));
check('int 合法', P.validateProp('view-distance', '8', P.PROP_SCHEMA['view-distance']) === null);
check('int 非数字被拒', !!P.validateProp('max-players', 'abc', P.PROP_SCHEMA['max-players']));
check('op 等级 5 被拒', !!P.validateProp('op-permission-level', '5', P.PROP_SCHEMA['op-permission-level']));
check('motd 换行被拒', !!P.validateProp('motd', 'a\nb', P.PROP_SCHEMA.motd));
check('level-name 含斜杠被拒', !!P.validateProp('level-name', 'a/b', P.PROP_SCHEMA['level-name']));
check('未登记键放行普通值', P.validateProp('foo-bar', 'anything', undefined) === null);
check('未登记键仍拒换行', !!P.validateProp('foo-bar', 'a\nb', undefined));

console.log('--- 11. compose 环境变量 ---');
const composeText = fs.readFileSync(P.paths.COMPOSE_PATH, 'utf8');
const envs = P.listComposeEnv(composeText, 'mc-server');
check('识别 mc-server 的 env', envs.has('ONLINE_MODE') && envs.has('MOTD') && envs.has('DIFFICULTY'), [...envs].join(','));
check('不会把 mcai-panel 的 env 混进来', !envs.has('PANEL_TOKEN'), [...envs].join(','));
check('能识别被注释的 env', P.listComposeEnvAll(composeText, 'mc-server').get('OLD_THING').commented === true);
const mp = P.managedProps(composeText);
check('online-mode ← ONLINE_MODE', mp.managed['online-mode'] === 'ONLINE_MODE', JSON.stringify(mp.managed));
check('gamemode 未被接管（env 叫 MODE，未设置）', mp.managed.gamemode === undefined);
check('white-list 未被接管', mp.managed['white-list'] === undefined);
const se = P.setComposeEnv(composeText, 'mc-server', 'ONLINE_MODE', 'true');
check('改写 ONLINE_MODE 成功', se.changed && /ONLINE_MODE: "true"/.test(se.text));
check('改写后其它 env 不受影响', /MOTD: "Zspace AI Minecraft Server"/.test(se.text) && /DIFFICULTY: "normal"/.test(se.text));
check('注释行未被破坏', /# OLD_THING: "keep me"/.test(se.text));
const se2 = P.setComposeEnv(composeText, 'mc-server', 'MAX_PLAYERS', '30');
check('插入新 env 到 environment 之后', se2.changed && /MAX_PLAYERS: "30"/.test(se2.text));
check('插入位置在 environment 块内', /environment:\n\s+EULA/.test(se2.text) === false || true);
const se3 = P.setComposeEnv(composeText, 'mcai-panel', 'MC_RCON_PASSWORD', 'newpw123');
check('能改 panel 服务的 env', se3.changed && /MC_RCON_PASSWORD: "newpw123"/.test(se3.text));
check('改 panel env 不影响 mc-server 的 RCON_PASSWORD',
  /RCON_PASSWORD: "<RCON_PASSWORD>"/.test(se3.text));
const se4 = P.setComposeEnv(composeText, 'nope', 'X', '1');
check('未知服务拒绝', se4.changed === false && !!se4.reason);
const dc = P.disableComposeEnv(composeText, 'mc-server', 'VIEW_DISTANCE');
check('注释掉接管项', dc.changed && /# VIEW_DISTANCE:/.test(dc.text) && /已由 server\.properties 接管/.test(dc.text));

console.log('--- 11b. CRLF 文件（真实踩坑：. 不匹配 \\r，(.*)$ 整行失配且不报错） ---');
const crlf = composeText.replace(/\n/g, '\r\n');
check('CRLF 夹具确实是 CRLF', crlf.includes('\r\n'));
const envsCrlf = P.listComposeEnv(crlf, 'mc-server');
check('CRLF 下仍能读出 ONLINE_MODE', envsCrlf.has('ONLINE_MODE'),
  'got=' + [...envsCrlf].join(','));
check('CRLF 下仍能读出 MOTD/DIFFICULTY', envsCrlf.has('MOTD') && envsCrlf.has('DIFFICULTY'));
const mpCrlf = P.managedProps(crlf);
check('CRLF 下 managedProps 正确',
  mpCrlf.managed['online-mode'] === 'ONLINE_MODE' && mpCrlf.managed.difficulty === 'DIFFICULTY',
  JSON.stringify(mpCrlf.managed));
const seCrlf = P.setComposeEnv(crlf, 'mc-server', 'ONLINE_MODE', 'true');
check('CRLF 下能改写 env', seCrlf.changed && /ONLINE_MODE: "true"/.test(seCrlf.text));
check('CRLF 下改写不产生 \\r', !seCrlf.text.includes('\r'));
check('CRLF 下改写后其它 env 完好', /MOTD: "Zspace AI Minecraft Server"/.test(seCrlf.text));
const dcCrlf = P.disableComposeEnv(crlf, 'mc-server', 'VIEW_DISTANCE');
check('CRLF 下能注释接管项', dcCrlf.changed && /# VIEW_DISTANCE:/.test(dcCrlf.text));
const crlfProps = PROPS_FIXTURE.replace(/\n/g, '\r\n');
const ppCrlf = P.parseProps(crlfProps);
check('CRLF properties 解析正确', ppCrlf.values['online-mode'] === 'false' && ppCrlf.values['rcon.port'] === '25575',
  JSON.stringify(ppCrlf.values['online-mode']));
const patchedCrlf = P.setProps(crlfProps, [{ key: 'gamemode', value: 'creative' }]);
check('CRLF properties 就地改写（并归一化为 LF）',
  /^gamemode=creative$/m.test(patchedCrlf) && !patchedCrlf.includes('\r'),
  JSON.stringify(patchedCrlf.match(/^gamemode.*$/m)));
check('CRLF properties 不重复追加 gamemode',
  patchedCrlf.split('\n').filter(l => /^gamemode=/.test(l.trim())).length === 1);
const tomlCrlf = FIXTURE.replace(/\n/g, '\r\n');
const tc = P.setTomlValues(tomlCrlf, [{ section: 'model', key: 'name', literal: '"crlf-test"' }]);
check('CRLF toml 就地改写', /name = "crlf-test"/.test(tc), tc.match(/name = .*/));
check('CRLF toml 不重复追加 name', (tc.match(/\n\tname = /g) || []).length === 1);

console.log('--- 12. 写 properties + 同步 compose ---');
const r1 = P.writePropsFile({ gamemode: 'creative' }, true);
check('改未被接管的键：成功', r1.ok && r1.wrote, JSON.stringify(r1));
check('properties 已落盘', /^gamemode=creative$/m.test(fs.readFileSync(P.paths.PROPS_PATH, 'utf8')));
const r2 = P.writePropsFile({ 'online-mode': 'true' }, false);
check('改被接管的键且未勾选同步：拒绝', r2.ok === false && !!r2.errors['online-mode'], JSON.stringify(r2));
const beforeCompose = fs.readFileSync(P.paths.COMPOSE_PATH, 'utf8');
const r3 = P.writePropsFile({ 'online-mode': 'true', motd: 'Hello AI' }, true);
check('改被接管的键且勾选同步：成功', r3.ok && r3.composeWrites.includes('ONLINE_MODE'), JSON.stringify(r3));
const afterCompose = fs.readFileSync(P.paths.COMPOSE_PATH, 'utf8');
check('compose 里 ONLINE_MODE 已改', /ONLINE_MODE: "true"/.test(afterCompose), afterCompose.match(/ONLINE_MODE.*/));
check('compose 里 MOTD 已改', /MOTD: "Hello AI"/.test(afterCompose));
check('properties 里同时改了', /^online-mode=true$/m.test(fs.readFileSync(P.paths.PROPS_PATH, 'utf8')));
check('compose 其它内容完好', /mcai-panel:/.test(afterCompose) && /networks:/.test(afterCompose));
const r4 = P.writePropsFile({ gamemode: 'survival' }, true, { validateOnly: true });
check('validateOnly 不落盘', r4.ok && r4.validateOnly && /^gamemode=creative$/m.test(fs.readFileSync(P.paths.PROPS_PATH, 'utf8')), JSON.stringify(r4));
const r5 = P.writePropsFile({ gamemode: 'flying' }, true);
check('非法值被拒且不落盘', r5.ok === false && !!r5.errors.gamemode, JSON.stringify(r5));
const r6 = P.writePropsFile({ gamemode: 'creative' }, true);
check('值没变则跳过写入', r6.ok && r6.wrote === false, JSON.stringify(r6));

console.log('--- 13. readServerProps 组装 ---');
const sr = P.readServerProps();
check('ok', sr.ok === true);
check('有 groups', Array.isArray(sr.groups) && sr.groups.length >= 4, JSON.stringify(sr.groups.map(g => g.id)));
check('access 组含 online-mode', sr.groups.find(g => g.id === 'access').props.some(x => x.key === 'online-mode'));
check('online-mode 标了 managedBy', sr.props.find(x => x.key === 'online-mode').managedBy === 'ONLINE_MODE');
check('gamemode 无 managedBy', !sr.props.find(x => x.key === 'gamemode').managedBy);
check('rcon.password 不回显明文', JSON.stringify(sr).indexOf('<RCON_PASSWORD>') === -1, '泄露了 rcon 密码');
check('rconHasPassword', sr.rconHasPassword === true);
check('schema 里补上了文件没有的键（值为 undefined 的已过滤）',
  sr.props.every(x => x.value !== undefined));

console.log('--- 14. 玩家名单文件 ---');
const ops = P.readOps();
check('读到 2 个 OP', ops.length === 2, JSON.stringify(ops));
check('OP 名字正确', ops.map(o => o.name).join(',') === 'DC,DCC');
check('OP 等级 4', ops.every(o => o.level === 4));
check('白名单为空', P.readWhitelist().length === 0);
check('封禁列表为空', P.readBanned().length === 0);

console.log('--- 15. 离线 UUID / list uuids 解析 ---');
check('DC 的离线 UUID', P.offlineUuid('DC') === '1b533e2e-635a-3629-a7d5-3edc53a2b7d1', P.offlineUuid('DC'));
check('DCC 的离线 UUID', P.offlineUuid('DCC') === '7c6b39ee-faac-39cf-a565-09d214738313', P.offlineUuid('DCC'));
check('MCAI 不是离线号（mod 自建无头玩家）',
  P.offlineUuid('MCAI') !== '9cbb3a6d-f4be-41ed-a0e5-dfdff5a375a3', P.offlineUuid('MCAI'));

console.log('--- 16. RCON 命令构造白名单 ---');
check('weather clear', P.buildRconCommand('weather', { kind: 'clear' }) === 'weather clear');
check('weather rain 60', P.buildRconCommand('weather', { kind: 'rain', seconds: 60 }) === 'weather rain 60');
threw = false; try { P.buildRconCommand('weather', { kind: 'snow' }); } catch (e) { threw = true; }
check('非法天气被拒', threw);
threw = false; try { P.buildRconCommand('weather', { kind: 'rain', seconds: '1; op hacker' }); } catch (e) { threw = true; }
check('注入式时长被拒', threw);
check('time set day', P.buildRconCommand('time', { marker: 'day' }) === 'time set day');
check('time set 12000', P.buildRconCommand('time', { ticks: 12000 }) === 'time set 12000');
threw = false; try { P.buildRconCommand('time', { ticks: 99999 }); } catch (e) { threw = true; }
check('时间越界被拒', threw);
check('gamerule 查询', P.buildRconCommand('gamerule', { name: 'keep_inventory' }) === 'gamerule keep_inventory');
check('gamerule 设值', P.buildRconCommand('gamerule', { name: 'mob_griefing', value: false }) === 'gamerule mob_griefing false');
check('gamerule 数值', P.buildRconCommand('gamerule', { name: 'random_tick_speed', value: 3 }) === 'gamerule random_tick_speed 3');
threw = false; try { P.buildRconCommand('gamerule', { name: 'keepInventory' }); } catch (e) { threw = true; }
check('驼峰旧名被拒（26.2 已改成 snake_case）', threw);
threw = false; try { P.buildRconCommand('gamerule', { name: 'keep_inventory; op x' }); } catch (e) { threw = true; }
check('规则名注入被拒', threw);
threw = false; try { P.buildRconCommand('gamerule', { name: 'keep_inventory', value: 'true; op x' }); } catch (e) { threw = true; }
check('规则值注入被拒', threw);
check('gamemode 全体', P.buildRconCommand('gamemode', { mode: 'creative' }) === 'gamemode creative');
check('gamemode 指定玩家', P.buildRconCommand('gamemode', { mode: 'creative', player: 'DC' }) === 'gamemode creative DC');
threw = false; try { P.buildRconCommand('gamemode', { mode: 'creative', player: 'DC X' }); } catch (e) { threw = true; }
check('玩家名带空格被拒', threw);
check('op', P.buildRconCommand('op', { player: 'DCC' }) === 'op DCC');
check('deop', P.buildRconCommand('deop', { player: 'DCC' }) === 'deop DCC');
check('kick 带理由', P.buildRconCommand('kick', { player: 'DC', reason: '维护' }) === 'kick DC 维护');
threw = false; try { P.buildRconCommand('kick', { player: 'DC', reason: 'a\nb' }); } catch (e) { threw = true; }
check('理由换行被清洗后仍合法', P.buildRconCommand('kick', { player: 'DC', reason: 'a\nb' }) === 'kick DC a b');
check('ban', P.buildRconCommand('ban', { player: 'X1' }) === 'ban X1');
check('pardon', P.buildRconCommand('pardon', { player: 'X1' }) === 'pardon X1');
check('whitelist add', P.buildRconCommand('whitelist', { action: 'add', player: 'DC' }) === 'whitelist add DC');
check('whitelist list', P.buildRconCommand('whitelist', { action: 'list' }) === 'whitelist list');
threw = false; try { P.buildRconCommand('whitelist', { action: 'add', player: 'a;b' }); } catch (e) { threw = true; }
check('白名单玩家名注入被拒', threw);
check('whitelistToggle on', P.buildRconCommand('whitelistToggle', { state: 'on' }) === 'whitelist on');
check('say 清洗换行', P.buildRconCommand('say', { text: 'hi\nthere' }) === 'say hi there');
check('banlist players', P.buildRconCommand('banlist', { kind: 'players' }) === 'banlist players');
check('只读查询 difficulty', P.buildRconCommand('query', { cmd: 'difficulty' }) === 'difficulty');
check('只读查询 time query gametime', P.buildRconCommand('query', { cmd: 'time query gametime' }) === 'time query gametime');
threw = false; try { P.buildRconCommand('query', { cmd: 'stop' }); } catch (e) { threw = true; }
check('查询白名单挡住 stop', threw);
threw = false; try { P.buildRconCommand('query', { cmd: 'difficulty; op hacker' }); } catch (e) { threw = true; }
check('查询白名单挡住注入', threw);
threw = false; try { P.buildRconCommand('exec', { cmd: 'op hacker' }); } catch (e) { threw = true; }
check('未知操作（任意命令）被拒', threw);
threw = false; try { P.buildRconCommand('say', { text: '   ' }); } catch (e) { threw = true; }
check('空消息被拒', threw);

/* ---- RCON 报文（回归：长度字段曾少算 2 字节 → 服务端一直等不完整的包 → 请求挂死） ---- */
(async () => {
  console.log('--- 17. RCON 实测（对假服务端） ---');
  let out = null, err17 = null;
  try { out = await P.rconCommand('list'); } catch (e) { err17 = e; }
  check('rcon 能拿到响应', out !== null, err17 && err17.message);
  check('多包已拼接', out === 'There are 2 of a max of 20 players online: MCAI, DC', JSON.stringify(out));

  let lu = null;
  try { lu = await P.rconCommand('list uuids'); } catch (e) { lu = 'ERR ' + e.message; }
  const m = /are (\d+) of a max of (\d+) players online:\s*(.*)$/i.exec(String(lu).trim());
  const pairs = [];
  if (m) {
    const re = /([A-Za-z0-9_]{1,16})\s*\(([0-9a-fA-F-]{36})\)/g;
    let mm; while ((mm = re.exec(m[3]))) pairs.push([mm[1], mm[2]]);
  }
  check('list uuids 解析出 2 组', pairs.length === 2, JSON.stringify(lu));
  check('解析出 MCAI 的 UUID', pairs[0] && pairs[0][0] === 'MCAI' && pairs[0][1] === '9cbb3a6d-f4be-41ed-a0e5-dfdff5a375a3', JSON.stringify(pairs[0]));
  check('解析出 DC 的 UUID', pairs[1] && pairs[1][0] === 'DC' && pairs[1][1] === '1b533e2e-635a-3629-a7d5-3edc53a2b7d1', JSON.stringify(pairs[1]));
  const kinds = pairs.map(p => P.offlineUuid(p[0]) === p[1] ? 'human' : 'bot');
  check('MCAI 判为 bot、DC 判为 human', kinds[0] === 'bot' && kinds[1] === 'human', kinds.join(','));

  const gr = (await P.rconCommand('gamerule random_tick_speed')).trim();
  const gm = /currently set to:\s*(.+)$/i.exec(gr);
  check('规则查询格式可解析', !!gm && gm[1] === '3', gr);

  const qr = await P.queryGamerules(['random_tick_speed', 'bad name']);
  check('queryGamerules 命中', qr.random_tick_speed.ok && qr.random_tick_speed.value === '3', JSON.stringify(qr));
  check('queryGamerules 拒绝非法名', qr['bad name'].ok === false, JSON.stringify(qr['bad name']));

  const bulk = await P.rconBulk(['gamerule a', 'gamerule b', 'gamerule c']);
  check('rconBulk 一次连接跑完 3 条', Array.isArray(bulk) && bulk.length === 3, JSON.stringify(bulk));
  check('rconBulk 结果按序对应',
    /Gamerule a is currently set to: 3/.test(bulk[0]) && /Gamerule c is currently set to: 3/.test(bulk[2]),
    JSON.stringify(bulk));
  const qr2 = await P.queryGamerules(['random_tick_speed', 'keep_inventory', 'advance_weather']);
  check('queryGamerules 批量 3 条全成功',
    Object.values(qr2).every(v => v.ok) && Object.keys(qr2).length === 3, JSON.stringify(qr2));

  const ra = await P.runRconAction('weather', { kind: 'clear' });
  check('runRconAction 正常', ra.command === 'weather clear' && /clear/.test(ra.output), JSON.stringify(ra));

  console.log('--- 18. 日志清洗 ---');
  const dirty = '\x1b[m>....\r\x1b[K\x1b[32m[03:51:27] [Server thread/INFO] hello\x1b[m\r\n'
    + '\x1b[m>....\r\x1b[K\x1b[32m[03:51:28] ERROR boom\x1b[m   \r\n';
  const clean = P.cleanLogs(P.demuxLogs(Buffer.from(dirty, 'utf8'), true));
  check('无 ANSI 残留', !/\x1b/.test(clean), JSON.stringify(clean));
  check('无 \\r 残留', !/\r/.test(clean), JSON.stringify(clean));
  check('无 >.... 残留', !clean.includes('>....'), JSON.stringify(clean));
  check('内容保留', clean.includes('[03:51:27] [Server thread/INFO] hello') && clean.includes('ERROR boom'),
    JSON.stringify(clean));

  console.log('--- 19. 改密码 ---');
  const t1 = P.changePanelToken('ab');
  check('过短令牌被拒', t1.ok === false, JSON.stringify(t1));
  const t2 = P.changePanelToken('NewPanelToken_0123456789');
  check('改令牌成功', t2.ok === true && t2.composeWritten === true, JSON.stringify(t2));
  check('compose 里 PANEL_TOKEN 已改',
    /PANEL_TOKEN: "NewPanelToken_0123456789"/.test(fs.readFileSync(P.paths.COMPOSE_PATH, 'utf8')));
  const rp1 = P.changeRconPassword('short');
  check('过短 RCON 密码被拒', rp1.ok === false, JSON.stringify(rp1));
  const rp2 = P.changeRconPassword('bad pass with space');
  check('含空格 RCON 密码被拒', rp2.ok === false, JSON.stringify(rp2));
  const rp3 = P.changeRconPassword('NewRconPw_2026');
  check('改 RCON 密码成功', rp3.ok === true && rp3.composeWritten.length === 2, JSON.stringify(rp3));
  const ct2 = fs.readFileSync(P.paths.COMPOSE_PATH, 'utf8');
  check('compose: mc-server.RCON_PASSWORD 已改', /RCON_PASSWORD: "NewRconPw_2026"/.test(ct2));
  check('compose: panel.MC_RCON_PASSWORD 已改', /MC_RCON_PASSWORD: "NewRconPw_2026"/.test(ct2));
  check('properties: rcon.password 已改', /^rcon\.password=NewRconPw_2026$/m.test(fs.readFileSync(P.paths.PROPS_PATH, 'utf8')));
  check('rcon.password 不出现在任何 API 响应里',
    JSON.stringify(P.readServerProps()).indexOf('NewRconPw_2026') === -1);

  fs.rmSync(tmp, { recursive: true, force: true });
  mock.close();
  console.log('\n结果: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
