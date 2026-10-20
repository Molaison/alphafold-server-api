#!/usr/bin/env node
'use strict';

/**
 * af3 login — 浏览器辅助登录，自动导出 af3_cookies.txt
 *
 * 为什么不是纯 HTTP：alphafoldserver.com 的登录不是标准 OAuth2
 * （授权 URL 里没有 client_id / scope / redirect_uri），而是 Google 的
 * GlifWebSignIn SSO。整条链路：
 *
 *   /welcome  --[Continue with Google]-->  /signin
 *   /signin   --302-->  accounts.google.com/ServiceLogin
 *                       ?passive=1209600&osid=1
 *                       &continue=https://alphafoldserver.com/signin
 *                       &followup=https://alphafoldserver.com/signin
 *              --302-->  accounts.google.com/v3/signin/identifier
 *                       ?flowName=GlifWebSignIn&flowEntry=ServiceLogin
 *              --[邮箱/密码/2FA]-->  回调 /signin
 *   登录成功后站点种下 __Secure-OSID + OSID（+ NID）
 *
 * Google 登录页带 JS 计算、reCAPTCHA、设备指纹，没有可 POST 的用户名密码
 * 换 token 的端点。所以这里用真实浏览器让你自己完成人机验证，脚本只负责
 * 等待成功、然后导出 cookie。
 *
 * 用法：
 *   node login.js                      # 弹出窗口，登录后写 af3_cookies.txt
 *   node login.js -o my.json           # 指定输出
 *   node login.js --profile ./profile  # 复用持久化 profile（登录一次即可长期免登）
 *   node login.js --timeout 300        # 等待上限（秒），默认 180
 *
 * 登录成功判定（实测）：
 *   - 出现 OSID 与 __Secure-OSID 两个 cookie
 *   - 且页面不再停留在 /welcome
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe') : null,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (p && fs.existsSync(p)) return p;
  throw new Error('找不到 Chrome/Edge，可用 --chrome <path> 指定');
}

const argv = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    const k = argv[i].slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    flags[k] = v;
  } else if (argv[i] === '-o') {
    flags.out = argv[++i];
  } else pos.push(argv[i]);
}

const OUT = flags.out || path.join(__dirname, 'af3_cookies.txt');
const PROFILE = flags.profile || null;
const TIMEOUT = Number(flags.timeout || 180) * 1000;

(async () => {
  const exe = flags.chrome || findChrome();
  console.log('browser :', exe);
  console.log('output  :', OUT);
  if (PROFILE) console.log('profile :', PROFILE, '(持久化，登录一次可长期复用)');

  let ctx;
  let browser;
  if (PROFILE) {
    ctx = await chromium.launchPersistentContext(PROFILE, {
      executablePath: exe,
      headless: false,
      viewport: { width: 1100, height: 850 },
      args: ['--disable-blink-features=AutomationControlled'],
    });
  } else {
    browser = await chromium.launch({
      executablePath: exe,
      headless: false,
      args: ['--disable-blink-features=AutomationControlled'],
    });
    ctx = await browser.newContext({ viewport: { width: 1100, height: 850 } });
  }
  _browser = browser;
  _ctx = ctx;

  // --seed：先注入已有 cookie。若仍未过期，脚本会立即判定已登录并直接
  // 重新导出（也用于把别的格式转换成 client 能读的格式）。
  if (flags.seed) {
    const seedRaw = JSON.parse(fs.readFileSync(flags.seed, 'utf8'));
    const seed = (Array.isArray(seedRaw) ? seedRaw : seedRaw.cookies || []).map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain ? (c.domain.startsWith('.') ? c.domain : '.' + c.domain) : '.alphafoldserver.com',
      path: c.path || '/',
      secure: c.secure !== false,
      httpOnly: c.httpOnly !== false,
      sameSite: 'None',
    }));
    if (seed.length) {
      await ctx.addCookies(seed);
      console.log('seeded  :', seed.length, 'cookie(s) from', flags.seed);
    }
  }

  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto('https://alphafoldserver.com/', { waitUntil: 'domcontentloaded', timeout: 90000 });

  console.log('\n========================================================');
  console.log(' 请在弹出的浏览器窗口里完成 Google 登录');
  console.log(' （输入邮箱 → 密码 → 可能的 2FA/验证码）');
  console.log(' 脚本会自动检测，无需手动确认');
  console.log('========================================================\n');

  const isLoggedIn = async () => {
    const names = (await ctx.cookies()).map((c) => c.name);
    const hasOsid = names.includes('OSID') && names.includes('__Secure-OSID');
    const url = page.url();
    const notWelcome = !/\/welcome/.test(url);
    return { ok: hasOsid && notWelcome, hasOsid, url, names };
  };

  const started = Date.now();
  let state = await isLoggedIn();
  let lastLog = 0;

  while (!state.ok) {
    if (Date.now() - started > TIMEOUT) {
      console.log('\n超时未完成登录。已获得的 cookie:', state.names.join(', ') || '(none)');
      console.log('当前 URL:', state.url);
      await close(2);
    }
    await page.waitForTimeout(1500);
    try {
      state = await isLoggedIn();
    } catch {
      /* navigation in flight */
    }
    const sec = Math.round((Date.now() - started) / 1000);
    if (sec - lastLog >= 10) {
      lastLog = sec;
      console.log(`  [${sec}s] 等待中… url=${state.url.replace('https://', '').slice(0, 60)} osid=${state.hasOsid}`);
    }
  }

  // 二次确认：真的能读到用户数据吗
  await page.goto('https://alphafoldserver.com/', { waitUntil: 'networkidle', timeout: 90000 });
  await page.waitForTimeout(1500);

  const cookies = await ctx.cookies('https://alphafoldserver.com/');
  const keep = cookies.filter((c) => ['NID', '__Secure-OSID', 'OSID'].includes(c.name));

  // 输出成与浏览器扩展导出一致的格式（client 直接可读）
  const json = keep.map((c, i) => ({
    domain: c.domain.startsWith('.') ? c.domain : '.' + c.domain,
    expirationDate: c.expires && c.expires > 0 ? c.expires : undefined,
    hostOnly: !c.domain.startsWith('.'),
    httpOnly: c.httpOnly,
    name: c.name,
    path: c.path,
    sameSite: c.sameSite === 'None' ? 'no_restriction' : 'unspecified',
    secure: c.secure,
    session: !(c.expires && c.expires > 0),
    storeId: '0',
    value: c.value,
    id: i + 1,
  }));

  fs.writeFileSync(OUT, JSON.stringify(json, null, 4), 'utf8');

  console.log('\n登录成功，已导出：');
  keep.forEach((c) => console.log(`  ${c.name.padEnd(15)} ${String(c.value.length).padStart(4)} chars`));
  console.log(`\n写入: ${OUT}`);
  console.log('验证: node af3.js user --cookies ' + OUT);

  await close(0);
})();

let _browser = null;
let _ctx = null;

async function close(code) {
  try {
    if (_browser) await _browser.close();
    else if (_ctx) await _ctx.close();
  } catch { /* ignore */ }
  if (code !== undefined) process.exit(code);
}
