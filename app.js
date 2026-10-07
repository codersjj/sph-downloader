/**
 * sph-downloader — 视频号视频本地下载器
 *
 * 工作原理:
 * 1. 用户粘贴视频号分享链接 / export 消息 / objectId
 * 2. 解析出 content_id，调 miuistore 的 /sph/public/quick 接口（带 AlgoSign 签名）
 * 3. 接口返回: 真实视频 url + _data (base64 XOR 密钥) + media 信息
 * 4. 下载视频流，把文件头部 len(_data) 字节与密钥 XOR 还原成可播放的 mp4
 *
 * 签名库 vendor/sph_enc.js 是站点的前端资源（jsvmp 加密），在 Node vm 沙箱里
 * 补齐 window/document/navigator/canvas 环境后原样运行，本地生成 _sign。
 * 该文件由 setup.js 首次运行时从源站下载，仓库不直接分发。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = __dirname;
const DOWNLOAD_DIR = path.join(ROOT, 'downloads');

const API_BASE = 'https://sph.miuistore.com';
const ENC_JS = path.join(ROOT, 'vendor', 'sph_enc.js');
const ENC_JS_URL = `${API_BASE}/plugins/sph/enc.js`;
const QUICK_PATH = '/sph/public/quick';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// 1. 签名器：在 Node 沙箱里跑站点原版 enc.js
// ---------------------------------------------------------------------------

function buildSandbox() {
  const elStub = () => ({
    style: {}, appendChild() {}, removeChild() {}, getAttribute() { return null; }, setAttribute() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {}, parentNode: null, childNodes: []
  });
  // canvas stub：指纹计算用，toDataURL 返回固定值保证指纹稳定
  const canvasStub = () => {
    const ctx = {
      fillStyle: '', font: '', textBaseline: '',
      fillRect() {}, strokeRect() {}, fillText() {}, strokeText() {},
      arc() {}, beginPath() {}, closePath() {}, fill() {}, stroke() {},
      getImageData(x, y, w, h) { return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }; },
      quadraticCurveTo() {}, bezierCurveTo() {}, lineTo() {}, moveTo() {},
      ellipse() {}, rect() {}, clip() {}, rotate() {}, translate() {}, scale() {}, transform() {}, setTransform() {},
      measureText() { return { width: 100 }; },
      createLinearGradient() { return { addColorStop() {} }; },
      createRadialGradient() { return { addColorStop() {} }; },
      drawImage() {}, putImageData() {}, clearRect() {}, save() {}, restore() {}
    };
    return {
      width: 200, height: 40,
      getContext() { return ctx; },
      toDataURL() { return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='; }
    };
  };
  const storage = () => {
    const s = {};
    return {
      getItem(k) { return k in s ? s[k] : null; },
      setItem(k, v) { s[k] = String(v); },
      removeItem(k) { delete s[k]; },
      clear() { for (const k in s) delete s[k]; },
      key(i) { return Object.keys(s)[i] || null; },
      get length() { return Object.keys(s).length; }
    };
  };
  return {
    console,
    setTimeout, setInterval, clearTimeout, clearInterval,
    Date,
    crypto: {
      getRandomValues(arr) { const b = crypto.randomBytes(arr.length); arr.set(b); return arr; },
      subtle: crypto.webcrypto.subtle,
      randomUUID() { return crypto.randomUUID(); }
    },
    performance: require('perf_hooks').performance,
    TextEncoder: require('util').TextEncoder,
    TextDecoder: require('util').TextDecoder,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    document: {
      querySelector() { return null; }, querySelectorAll() { return []; },
      createElement(tag) { return tag === 'canvas' ? canvasStub() : elStub(); },
      createEvent() { return { initEvent() {} }; },
      documentElement: elStub(), body: elStub(), head: elStub(),
      addEventListener() {}, removeEventListener() {}, cookie: ''
    },
    location: {
      href: `${API_BASE}/`, protocol: 'https:', hostname: 'sph.miuistore.com',
      host: 'sph.miuistore.com', port: '', origin: API_BASE,
      pathname: '/', search: '', hash: '', replace() {}
    },
    navigator: {
      userAgent: UA, platform: 'MacIntel', language: 'zh-CN', languages: ['zh-CN'],
      cookieEnabled: true, hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 0
    },
    localStorage: storage(),
    sessionStorage: storage()
  };
}

let _signer = null;
function getSigner() {
  if (_signer) return _signer;
  if (!fs.existsSync(ENC_JS)) {
    // 首次运行：从源站拉取签名库到本地 vendor/
    throw new Error('签名库未就绪：请先运行 node setup.js（会从 ' + ENC_JS_URL + ' 下载 vendor/sph_enc.js）');
  }
  const code = fs.readFileSync(ENC_JS, 'utf8');
  const sandbox = buildSandbox();
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'enc.js' });
  if (typeof sandbox.AlgoSign !== 'function') throw new Error('enc.js 加载失败：未找到 AlgoSign');
  _signer = new sandbox.AlgoSign({ appId: 'sph' });
  return _signer;
}

async function makeSign(id) {
  const algo = getSigner();
  const r = await algo.sign({ id, path: QUICK_PATH });
  if (!r || !r._sign) throw new Error('签名生成失败');
  return r._sign;
}

// ---------------------------------------------------------------------------
// 2. 分享链接 → content_id（复刻站点 sph.js 的前端解析逻辑）
// ---------------------------------------------------------------------------

/**
 * 支持的输入形式:
 *  - channels.weixin.qq.com/finder-preview/pages/sph...?id=xxx  → xxx##1
 *  - weixin.qq.com/sph/xxx                                      → xxx##1
 *  - export/ 开头的 XML 报文                                    → export/...##2
 *  - txexport/ 开头                                             → ...##3
 *  - 纯数字 content_id                                          → 原样
 *  - 消息 JSON（AddMsgList）                                    → 提取 objectId
 *  - 含 objectId 的任意文本                                     → 提取 objectId
 */
function parseInput(raw) {
  let s = String(raw || '').trim();
  if (!s) throw new Error('输入为空');

  if (/^\d+$/.test(s)) return s; // 纯数字 id

  if (/channels\.weixin\.qq\.com\/finder-preview\/pages\/sph/.test(s)) {
    const u = new URL(s);
    return u.searchParams.get('id') + '##1';
  }
  if (/weixin\.qq\.com\/sph\//.test(s)) {
    const u = new URL(s);
    return u.pathname.replace(/.*\/sph\//, '') + '##1';
  }
  if (/^export\//.test(s)) return s + '##2';
  if (/txexport\//.test(s)) return s + '##3';

  // XML 报文 / JSON 消息 / 散文本
  let m = s.match(/objectId.*?(\d+).*?objectId/);
  if (m) return m[1];

  // content_ID 参数形式
  try {
    const u = new URL(s);
    const c = u.searchParams.get('content_ID');
    if (c) return c;
  } catch (e) { /* 不是 URL，继续 */ }

  // JSON 消息体
  try {
    const o = JSON.parse(s);
    for (const item of (o.AddMsgList || [])) {
      const mm = String(item.Content || '').match(/objectId.*?(\d+).*?objectId/);
      if (mm) return mm[1];
    }
  } catch (e) { /* 不是 JSON */ }

  throw new Error('无法识别的输入：请粘贴视频号分享链接、export 报文或纯数字 id');
}

/** 从分享文本中提取标题（desc 字段最长者），用于命名文件 */
function extractTitle(raw) {
  const s = String(raw || '');
  const matches = s.match(/desc&gt;([\s\S]*?)&lt;\/desc/g);
  let title = '', len = 0;
  if (matches) {
    for (const m0 of matches) {
      const t = m0.replace('desc&gt;', '').replace('&lt;/desc', '');
      if (t === 'null') continue;
      if (t.length > len) { title = t; len = t.length; }
    }
  }
  return title;
}

// ---------------------------------------------------------------------------
// 3. 调 quick 接口 + 下载 + XOR 还原
// ---------------------------------------------------------------------------

async function resolveVideo(contentId, { title = '', from = '' } = {}) {
  const sign = await makeSign(contentId);
  const url = `${API_BASE}${QUICK_PATH}?id=${encodeURIComponent(contentId)}&sign=${encodeURIComponent(sign)}&_from=${encodeURIComponent(from)}&title=${encodeURIComponent(title)}`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': UA, 'Referer': `${API_BASE}/` }
  });
  let data;
  try { data = await resp.json(); } catch (e) { throw new Error(`接口返回异常 (HTTP ${resp.status})`); }
  if (data.error !== 0) {
    const err = new Error(data.message || `接口错误 ${data.error}`);
    err.code = data.error;
    throw err;
  }
  if (!data.url) throw new Error('接口未返回视频地址（视频可能已过期或失效）');
  return data;
}

const HTTP_RETRY = 3;
async function fetchWithRetry(url, headers = {}, onProgress) {
  let lastErr;
  for (let i = 0; i < HTTP_RETRY; i++) {
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': UA, ...headers },
        redirect: 'follow'
      });
      if (!resp.ok && resp.status !== 206) throw new Error(`HTTP ${resp.status}`);
      return resp;
    } catch (e) {
      lastErr = e;
      if (i < HTTP_RETRY - 1) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr;
}

function sanitizeFilename(name, fallback = 'video') {
  let n = String(name || '').replace(/[\r\n]/g, '').trim().substr(0, 80);
  n = n.replace(/[\\/:*?"<>|]/g, '_');
  return n || fallback;
}

/**
 * 下载并还原视频。站点方案: 视频源文件前 N 字节被 XOR 加密（N = 密钥长度），
 * 拿到流后把前 N 字节与密钥逐字节 XOR 即可还原。
 */
async function downloadVideo(info, { onProgress } = {}) {
  const key = Buffer.from(info._data || '', 'base64');
  const file_size = (info.media && info.media.file_size) || 0;
  const title = sanitizeFilename(info.media && info.media.title);
  const filename = `${title}.mp4`;
  const filepath = uniquePath(path.join(DOWNLOAD_DIR, filename));

  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const out = fs.createWriteStream(filepath);

  const resp = await fetchWithRetry(info.url, { Referer: '' });
  const total = Number(resp.headers.get('content-length')) || file_size;
  const reader = resp.body.getReader();

  let loaded = 0;
  let headChunks = [];
  let headLen = 0;
  let keyIdx = 0;
  let doneHead = key.length === 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    let chunk = Buffer.from(value);
    if (!doneHead) {
      // 头部密文区：逐字节 XOR
      const outBuf = Buffer.allocUnsafe(chunk.length);
      for (let i = 0; i < chunk.length; i++) {
        if (keyIdx < key.length) {
          outBuf[i] = chunk[i] ^ key[keyIdx++];
        } else {
          outBuf[i] = chunk[i];
        }
      }
      if (keyIdx >= key.length) doneHead = true;
      chunk = outBuf;
    }
    out.write(chunk);
    loaded += chunk.length;
    if (onProgress && total > 0) onProgress(loaded, total);
  }
  await new Promise((resolve, reject) => { out.end(resolve); out.on('error', reject); });

  return { filepath, size: loaded, title };
}

function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p);
  const base = p.slice(0, -ext.length);
  for (let i = 1; i < 999; i++) {
    const np = `${base} (${i})${ext}`;
    if (!fs.existsSync(np)) return np;
  }
  return p + '.new';
}

// ---------------------------------------------------------------------------
// 4. CLI 入口
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    console.log(`
视频号视频下载器（本地版）

用法:
  node app.js "<分享链接 | export报文 | objectId | 纯数字id>"
  node app.js --gui        启动网页界面（默认）

输入支持:
  - 视频号分享链接（channels.weixin.qq.com / weixin.qq.com/sph/）
  - 微信消息导出报文（export/ 或 txexport/ 开头）
  - 消息 JSON（含 AddMsgList / objectId）
  - 纯数字 content_id

文件保存到: ${DOWNLOAD_DIR}`);
    process.exit(0);
  }

  if (args[0] === '--gui') {
    process.env.GUI = '1';
    const { startServer } = require('./server');
    return startServer();
  }

  const raw = args.join(' ');
  await runDownload(raw, {
    progress: (loaded, total) => {
      const pct = ((loaded / total) * 100).toFixed(1);
      process.stdout.write(`\r下载中 ${pct}%  (${(loaded / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MB)`);
    }
  });
  process.exit(0);
}

async function runDownload(raw, { progress } = {}) {
  console.log('解析输入...');
  const contentId = parseInput(raw);
  const title = extractTitle(raw);
  console.log(`content_id: ${contentId}`);

  console.log('生成签名...');
  console.log('请求解析接口...');
  const info = await resolveVideo(contentId, { title });
  console.log(`标题: ${info.media && info.media.title}`);
  const metaSize = ((info.media && info.media.file_size) || 0);
  let realSize = 0;
  try {
    const h = await fetch(info.url, { method: 'HEAD', headers: { 'User-Agent': UA } });
    realSize = Number(h.headers.get('content-length')) || 0;
  } catch (e) { /* HEAD 失败就用元数据 */ }
  if (realSize) {
    console.log(`大小: ${(realSize / 1048576).toFixed(1)} MB（CDN 实际文件）`);
    if (metaSize && metaSize > realSize * 1.05) {
      console.log(`      原始上传 ${ (metaSize / 1048576).toFixed(1) } MB，微信已转码，以下载的实际文件为准`);
    }
  } else {
    console.log(`大小: ${(metaSize / 1048576).toFixed(1)} MB`);
  }

  console.log('开始下载...');
  const r = await downloadVideo(info, { onProgress: progress });
  console.log(`\n完成: ${r.filepath} (${(r.size / 1048576).toFixed(1)} MB)`);
  return r;
}

if (require.main === module) main().catch(e => { console.error('失败:', e.message); process.exit(1); });

module.exports = { parseInput, extractTitle, resolveVideo, downloadVideo, runDownload, makeSign };
