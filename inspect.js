// 检查 quick 接口对这条视频返回的完整元数据（不下载）
'use strict';
const { resolveVideo, parseInput } = require('./app');

(async () => {
  const raw = process.argv[2]; // 用法: node inspect.js "<分享链接或id>"
  if (!raw) { console.error('用法: node inspect.js "<分享链接或id>"'); process.exit(1); }
  const info = await resolveVideo(parseInput(raw), {});
  // 只展示结构与关键字段，密钥类字段截断
  const safe = {};
  for (const k of Object.keys(info)) {
    const v = info[k];
    if (typeof v === 'string' && v.length > 120) safe[k] = v.slice(0, 120) + `...(len=${v.length})`;
    else safe[k] = v;
  }
  console.log(JSON.stringify(safe, null, 2));

  // media 对象完整内容
  console.log('--- media 完整 ---');
  console.log(JSON.stringify(info.media, null, 2));

  // url 里的线索（清晰度参数）
  console.log('--- url 结构 ---');
  try {
    const u = new URL(info.url);
    console.log('host:', u.hostname);
    console.log('pathname:', u.pathname);
    console.log('params:', JSON.stringify(Object.fromEntries(u.searchParams.entries()), null, 2));
  } catch (e) { console.log('url parse err', e.message); }

  // HEAD 看真实大小
  const r = await fetch(info.url, { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0' } });
  console.log('--- HEAD ---');
  console.log('status:', r.status, 'content-length:', r.headers.get('content-length'), 'content-type:', r.headers.get('content-type'));
})().catch(e => console.error('ERR:', e.message));
