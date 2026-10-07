/** 网页界面：一个极简本地服务，浏览器里粘贴链接即可下载 */
'use strict';

const http = require('http');
const path = require('path');
const { runDownload } = require('./app');

const PORT = 4580;

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>视频号下载器</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif;
    background: linear-gradient(160deg, #f5f7fa 0%, #e8ecf3 100%);
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    color: #1a2333;
  }
  .card {
    background: #fff; border-radius: 20px; padding: 40px;
    width: min(560px, 92vw);
    box-shadow: 0 20px 60px rgba(30, 50, 90, .12);
  }
  h1 { font-size: 22px; margin-bottom: 6px; }
  .sub { color: #7a8699; font-size: 13px; margin-bottom: 24px; }
  textarea {
    width: 100%; height: 110px; border: 1.5px solid #dde3ec; border-radius: 12px;
    padding: 12px 14px; font-size: 14px; resize: vertical; outline: none;
    font-family: inherit; transition: border .2s;
  }
  textarea:focus { border-color: #4a7dff; }
  .row { display: flex; gap: 10px; margin-top: 14px; }
  button {
    flex: 1; border: none; border-radius: 12px; padding: 13px;
    font-size: 15px; font-weight: 600; cursor: pointer; transition: all .2s;
  }
  .btn-go { background: #4a7dff; color: #fff; }
  .btn-go:hover { background: #3a6bef; }
  .btn-go:disabled { background: #b8c6e8; cursor: not-allowed; }
  .btn-open { background: #eef2f9; color: #43526b; }
  .btn-open:hover { background: #e2e9f5; }
  .log {
    margin-top: 20px; background: #f7f9fc; border-radius: 12px; padding: 16px;
    font-size: 13px; line-height: 1.7; color: #43526b; display: none;
    max-height: 260px; overflow-y: auto; word-break: break-all;
  }
  .log.show { display: block; }
  .bar { height: 8px; border-radius: 4px; background: #e6ebf3; margin-top: 14px; overflow: hidden; display: none; }
  .bar.show { display: block; }
  .bar > div { height: 100%; background: linear-gradient(90deg, #4a7dff, #6c9bff); width: 0%; transition: width .2s; border-radius: 4px; }
  .ok { color: #18a058; font-weight: 600; }
  .err { color: #d03050; }
  .foot { margin-top: 18px; font-size: 12px; color: #aab4c5; text-align: center; }
</style>
</head>
<body>
<div class="card">
  <h1>视频号视频下载器</h1>
  <div class="sub">粘贴分享链接 / export 报文 / objectId，自动解析下载并还原 MP4</div>
  <textarea id="input" placeholder="在这里粘贴（支持分享链接、消息报文、纯数字 id）…"></textarea>
  <div class="row">
    <button class="btn-go" id="go" onclick="go()">下载</button>
    <button class="btn-open" onclick="fetch('/open').then(()=>{})">打开下载目录</button>
  </div>
  <div class="bar" id="bar"><div id="barIn"></div></div>
  <div class="log" id="log"></div>
  <div class="foot">本地运行 · 不上传任何数据 · 文件保存在 downloads/ 目录</div>
</div>
<script>
let busy = false;
function log(msg, cls) {
  const el = document.getElementById('log');
  el.classList.add('show');
  const d = document.createElement('div');
  if (cls) d.className = cls;
  d.textContent = msg;
  el.appendChild(d);
  el.scrollTop = el.scrollHeight;
}
async function go() {
  if (busy) return;
  const input = document.getElementById('input').value.trim();
  if (!input) { log('请先粘贴链接', 'err'); return; }
  busy = true;
  const btn = document.getElementById('go');
  btn.disabled = true; btn.textContent = '处理中…';
  document.getElementById('log').innerHTML = '';
  document.getElementById('log').classList.remove('show');
  const bar = document.getElementById('bar'); const barIn = document.getElementById('barIn');
  bar.classList.remove('show'); barIn.style.width = '0%';
  log('解析输入并请求接口…');
  try {
    const resp = await fetch('/download', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input })
    });
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\\n')) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        if (ev.type === 'log') log(ev.msg);
        else if (ev.type === 'progress') { bar.classList.add('show'); barIn.style.width = ev.pct + '%'; log('下载 ' + ev.pct.toFixed(1) + '%'); }
        else if (ev.type === 'done') { log('完成: ' + ev.file, 'ok'); log('大小: ' + (ev.size / 1048576).toFixed(1) + ' MB', 'ok'); barIn.style.width = '100%'; }
        else if (ev.type === 'error') log('失败: ' + ev.msg, 'err');
      }
    }
  } catch (e) { log('请求失败: ' + e.message, 'err'); }
  btn.disabled = false; btn.textContent = '下载'; busy = false;
}
document.getElementById('input').addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') go(); });
</script>
</body>
</html>`;

function sse(res, obj) {
  res.write(JSON.stringify(obj) + '\n');
}

function startServer() {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(HTML);
    }
    if (req.method === 'GET' && req.url === '/open') {
      const { exec } = require('child_process');
      if (process.platform === 'darwin') exec('open "' + path.join(__dirname, 'downloads') + '"');
      else if (process.platform === 'win32') exec('explorer "' + path.join(__dirname, 'downloads') + '"');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('{"ok":true}');
    }
    if (req.method === 'POST' && req.url === '/download') {
      let body = '';
      for await (const chunk of req) body += chunk;
      let input = '';
      try { input = JSON.parse(body).input; } catch (e) {}
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache'
      });
      try {
        const r = await runDownloadStreaming(input, res);
      } catch (e) {
        sse(res, { type: 'error', msg: e.message });
      }
      res.end();
      return;
    }
    res.writeHead(404); res.end();
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`视频号下载器已启动: http://127.0.0.1:${PORT}`);
    console.log('按 Ctrl+C 退出');
    const { exec } = require('child_process');
    if (process.env.GUI !== '1') exec(`open http://127.0.0.1:${PORT}`);
  });
  return server;
}

async function runDownloadStreaming(raw, res) {
  const { parseInput, extractTitle, resolveVideo, downloadVideo } = require('./app');
  sse(res, { type: 'log', msg: '解析输入…' });
  const contentId = parseInput(raw);
  const title = extractTitle(raw);
  sse(res, { type: 'log', msg: 'content_id: ' + contentId });
  sse(res, { type: 'log', msg: '生成签名并请求解析接口…' });
  const info = await resolveVideo(contentId, { title });
  sse(res, { type: 'log', msg: '标题: ' + (info.media && info.media.title || '-') });
  // 优先 HEAD 拿 CDN 真实大小（元数据里的 file_size 是作者原始上传大小，可能已转码变小）
  let realSize = 0;
  try {
    const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    const h = await fetch(info.url, { method: 'HEAD', headers: { 'User-Agent': UA } });
    realSize = Number(h.headers.get('content-length')) || 0;
  } catch (e) {}
  const metaSize = (info.media && info.media.file_size) || 0;
  if (realSize) {
    sse(res, { type: 'log', msg: '大小: ' + (realSize / 1048576).toFixed(1) + ' MB' + (metaSize > realSize * 1.05 ? '（原始上传 ' + (metaSize / 1048576).toFixed(1) + ' MB，微信已转码）' : '') });
  } else {
    sse(res, { type: 'log', msg: '大小: ' + (metaSize / 1048576).toFixed(1) + ' MB' });
  }
  sse(res, { type: 'log', msg: '开始下载…' });
  let lastPct = -1;
  const r = await downloadVideo(info, {
    onProgress: (loaded, total) => {
      const pct = (loaded / total) * 100;
      if (pct - lastPct >= 1 || pct >= 100) {
        lastPct = pct;
        sse(res, { type: 'progress', pct });
      }
    }
  });
  sse(res, { type: 'done', file: r.filepath, size: r.size });
  return r;
}

if (require.main === module) startServer();
module.exports = { startServer };
