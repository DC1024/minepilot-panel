/**
 * MinePilot 配置面板 —— 无头浏览器验证
 * 重点：抓运行时 JS 错误（语法过了不代表能跑）、验证五个页签都渲染出内容。
 */
const { chromium } = require('playwright-core');
const fs = require('fs'), path = require('path');
const R = fs, pw = process.env.LOCALAPPDATA + '\\ms-playwright';
const N = R.readdirSync(pw).filter(d => /^chromium-\d+$/.test(d))
  .sort((a, b) => +b.split('-')[1] - +a.split('-')[1])[0];
const EXE = pw + '\\' + N + '\\chrome-win64\\chrome.exe';
const BASE = '<WORKSPACE_DIR>';        // 本机工作区目录
const TOKEN = fs.readFileSync(path.join(BASE, 'panel_token.txt'), 'utf8').trim();
const URL = 'http://<SERVER_IP>:25800/';
const SHOT = path.join(BASE, 'shots');
if (!fs.existsSync(SHOT)) fs.mkdirSync(SHOT);

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fails++; };

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const u = (m.location && m.location().url) || '';
    if (/favicon/.test(u)) return;
    errs.push('CONSOLE: ' + m.text() + (u ? ' @ ' + u : ''));
  });
  await page.addInitScript(t => { try { localStorage.setItem('panelToken', t); } catch (e) {} }, TOKEN);
  await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(3000);

  console.log('--- A. 基础 ---');
  ok(await page.isHidden('#gate'), '令牌闸门已自动通过');
  const mcState = (await page.textContent('#mcState')).trim();
  ok(/running/.test(mcState), 'mc-server 状态 = ' + mcState);
  const players = (await page.textContent('#players')).trim();
  ok(/\d/.test(players), '在线人数 = ' + players);
  const tabCount = await page.$$eval('#tabs button', b => b.length);
  ok(tabCount === 6, '页签数 = ' + tabCount);

  console.log('--- B. AI 配置页 ---');
  const baseUrl = await page.inputValue('#baseUrl');
  ok(/^https:\/\//.test(baseUrl), '模型地址已填充: ' + baseUrl);
  const model = await page.inputValue('#name');
  ok(!!model, '模型名已填充: ' + model);

  console.log('--- C. 服务器设置页 ---');
  await page.click('#tabs button[data-tab="server"]');
  await page.waitForTimeout(700);
  const propRows = await page.$$eval('#propsHost [data-prop]', e => e.length);
  ok(propRows >= 60, '属性行数 = ' + propRows);
  const groups = await page.$$eval('#propsHost .card h2', e => e.map(x => x.textContent.trim()));
  ok(groups.length >= 5, '分组: ' + groups.join(' / '));
  const locks = await page.$$eval('#propsHost .lock', e => e.map(x => x.textContent.trim()));
  ok(locks.length === 7, 'compose 接管徽标 = ' + locks.length + ' 个: ' + locks.join(','));
  const noticeVisible = await page.isVisible('#composeNotice');
  ok(noticeVisible, '顶部接管提示可见');
  const takeoverBtns = await page.$$eval('#propsHost button', e => e.filter(x => x.textContent.includes('交给 properties 管')).length);
  ok(takeoverBtns === 7, '「交给 properties 管」按钮 = ' + takeoverBtns + ' 个');
  // 关键：rcon.password 必须遮蔽（它在 input 里，textContent 取不到，只能读 value）
  const bodyText = await page.textContent('body');
  ok(bodyText.indexOf('<RCON_PASSWORD>') === -1, '页面里没有出现 RCON 明文密码');
  // rcon.password 是 secret 类型：渲染成「无 data-prop、disabled」的 input（title=不回显），经 data-row 定位
  const pwInput = await page.$('[data-row="rcon.password"] input');
  ok(!!pwInput, 'rcon.password 输入框存在');
  const masked = await pwInput.evaluate(el => el.value);
  ok(/^•+$/.test(masked) && masked.length >= 8, 'rcon.password 显示为掩码: ' + masked);
  const pwDisabled = await pwInput.getAttribute('disabled');
  ok(pwDisabled !== null, 'rcon.password 输入框被禁用（只能走「密码与令牌」改）');
  // 改一个未被接管的属性，确认「已改」标记 + 不溢出
  await page.selectOption('[data-prop="gamemode"]', 'creative');
  await page.waitForTimeout(250);
  const changed = await page.$$eval('#propsHost .prop.changed', e => e.length);
  ok(changed === 1, '标记出 1 处改动');
  const ovf = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(ovf === 0, '页面无横向溢出 (diff=' + ovf + ')');
  await page.selectOption('[data-prop="gamemode"]', 'survival');   // 改回去
  await page.waitForTimeout(200);
  ok((await page.$$eval('#propsHost .prop.changed', e => e.length)) === 0, '改动标记已消失');
  await (await page.$('#pane-server')).screenshot({ path: path.join(SHOT, 'server.png') });

  console.log('--- D. 运行时控制页 ---');
  const t0 = Date.now();
  await page.click('#tabs button[data-tab="runtime"]');
  await page.waitForTimeout(400);
  // 骨架必须**立刻**出现（不能白屏干等）
  const skel = await page.$$eval('#rulesHost .rule', e => e.length);
  ok(skel >= 40, '骨架立即渲染，规则行数 = ' + skel + '（' + (Date.now() - t0) + 'ms）');
  // 等批量读取完成
  await page.waitForFunction(() => {
    const s = document.getElementById('rulesStatus');
    return s && (s.textContent.indexOf('已读取') === 0 || s.textContent.indexOf('读取失败') === 0);
  }, { timeout: 60000 });
  const loadMs = Date.now() - t0;
  const status = (await page.textContent('#rulesStatus')).trim();
  ok(true, '规则读取耗时 = ' + loadMs + 'ms，状态 = ' + status);
  ok(loadMs < 15000, '规则读取在 15s 内完成');
  const rules = await page.$$eval('#rulesHost .rule', e => e.length);
  ok(rules >= 40, '游戏规则条数 = ' + rules);
  const sel = await page.$$eval('#rulesHost select', e => e.length);
  const inp = await page.$$eval('#rulesHost input', e => e.length);
  ok(sel + inp >= 40, '规则控件 = select ' + sel + ' + input ' + inp);
  ok(await page.$$eval('#rulesHost [disabled]', e => e.length) === 0, '没有残留禁用的控件');
  const curKeep = await page.inputValue('[data-rule="keep_inventory"]').catch(() => null);
  ok(curKeep === 'false', 'keep_inventory 当前值 = ' + curKeep);
  const curAdv = await page.inputValue('[data-rule="advance_weather"]').catch(() => null);
  ok(curAdv === 'true', 'advance_weather 当前值 = ' + curAdv);
  const unknownBadges = await page.$$eval('#rulesHost .rule', e => e.filter(x => x.textContent.includes('未知')).length);
  ok(unknownBadges === 0, '没有读取失败的规则 (' + unknownBadges + ')');
  const gmOptions = await page.$$eval('#gmPlayer option', e => e.map(x => x.value));
  ok(gmOptions.length >= 1 && gmOptions.includes('MCAI'),
    '在线玩家下拉含 AI bot = ' + gmOptions.join(','));
  await (await page.$('#pane-runtime')).screenshot({ path: path.join(SHOT, 'runtime.png') });

  console.log('--- E. 玩家管理页 ---');
  await page.click('#tabs button[data-tab="players"]');
  await page.waitForTimeout(900);
  const prows = await page.$$eval('#onlineHost .prow', e => e.length);
  ok(prows >= 1, '在线玩家行 = ' + prows + ' (仅当前在线玩家)');
  const ptext = await page.textContent('#onlineHost');
  ok(ptext.includes('9cbb3a6d-f4be-41ed-a0e5-dfdff5a375a3'), '显示了 MCAI 的 UUID');
  ok(ptext.includes('AI'), 'MCAI 标为 AI');
  // DC 是否在线是外部状态（真人玩家），在则验证 UUID+真人徽标，不在则记 SKIP 而非 FAIL
  if (ptext.includes('DC')) {
    ok(ptext.includes('1b533e2e-635a-3629-a7d5-3edc53a2b7d1'), '显示了 DC 的 UUID');
    ok(ptext.includes('真人'), 'DC 标为真人');
  } else {
    console.log('  SKIP  DC 当前不在线，跳过真人/UUID 断言（外部状态，非面板问题）');
  }
  const opsRows = await page.$$eval('#opsHost .prow', e => e.length);
  ok(opsRows === 2, 'OP 行 = ' + opsRows + ' (DC/DCC)');
  await (await page.$('#pane-players')).screenshot({ path: path.join(SHOT, 'players.png') });

  console.log('--- F. 密码与令牌页 ---');
  await page.click('#tabs button[data-tab="security"]');
  await page.waitForTimeout(600);
  const rconHost = (await page.textContent('#rconHost')).trim();
  ok(/:\d+$/.test(rconHost), 'RCON 地址 = ' + rconHost);
  const rconLen = (await page.textContent('#rconLen')).trim();
  ok(/\d+ 位/.test(rconLen), 'RCON 密码长度 = ' + rconLen);
  const tokLen = (await page.textContent('#tokLen')).trim();
  ok(/\d+ 位/.test(tokLen), '面板令牌长度 = ' + tokLen);
  await page.click('#genToken');
  const gen = await page.inputValue('#newToken');
  ok(gen.length === 48, '随机生成令牌长度 = ' + gen.length);
  await page.click('#genRconPw');
  const genPw = await page.inputValue('#newRconPw');
  ok(genPw.length === 24, '随机生成 RCON 密码长度 = ' + genPw.length);
  await (await page.$('#pane-security')).screenshot({ path: path.join(SHOT, 'security.png') });

  console.log('--- G. 日志页 + 全页 ---');
  await page.click('#tabs button[data-tab="logs"]');
  await page.waitForTimeout(600);
  const logs = await page.textContent('#logs');
  ok(logs.length > 50, '日志有内容 (' + logs.trim().split('\n').length + ' 行)');
  ok(logs.indexOf('\x1b') === -1, '日志无 ANSI 残留');
  await page.fill('#logFilter', 'RCON');
  await page.waitForTimeout(300);
  const filtered = await page.textContent('#logs');
  ok(filtered.includes('已过滤'), '日志过滤生效');

  const ovfAll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(ovfAll === 0, '最终无横向溢出 (diff=' + ovfAll + ')');

  console.log('\nERRORS: ' + (errs.length ? JSON.stringify(errs.slice(0, 8), null, 1) : 'none'));
  fails += errs.length;
  await browser.close();
  console.log('\n结果: ' + (fails === 0 ? '全部通过' : fails + ' 项失败'));
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
