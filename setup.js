/**
 * 首次运行准备：下载签名库到 vendor/
 * 签名库属于第三方站点的前端资源，仓库不直接分发，
 * 由使用者自行从源站获取。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const API_BASE = 'https://sph.miuistore.com';
const ENC_JS_URL = `${API_BASE}/plugins/sph/enc.js`;
const DEST = path.join(__dirname, 'vendor', 'sph_enc.js');

(async () => {
  if (fs.existsSync(DEST)) {
    console.log('签名库已存在:', DEST);
    console.log('如需更新，删除 vendor/ 目录后重新运行本脚本。');
    return;
  }
  console.log('下载签名库:', ENC_JS_URL);
  const resp = await fetch(ENC_JS_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!resp.ok) throw new Error(`下载失败 HTTP ${resp.status}`);
  const text = await resp.text();
  if (!text.includes('AlgoSign')) throw new Error('下载的内容不像签名库（未找到 AlgoSign），源站可能已改版');
  fs.mkdirSync(path.dirname(DEST), { recursive: true });
  fs.writeFileSync(DEST, text);
  console.log('已保存:', DEST, `(${(text.length / 1024).toFixed(0)} KB)`);
  console.log('现在可以运行 node server.js 或 node app.js "<链接>" 了');
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
