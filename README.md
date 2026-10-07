# 视频号下载器（本地版）

把视频号分享链接变成本地 MP4 的纯本地小工具：粘贴链接 → 自动解析 → 下载还原，带网页界面和命令行两种用法，零 npm 依赖（Node 18+）。

## 快速开始

```bash
# 1. 首次运行：下载签名库（第三方站点前端资源，仓库不直接分发）
node setup.js

# 2a. 网页界面（推荐）
node server.js          # 打开 http://127.0.0.1:4580
# macOS 可直接双击 start.command

# 2b. 命令行
node app.js "<分享链接>"
```

## 支持的输入

| 输入形式 | 示例 |
|---|---|
| 视频号分享链接 | `https://channels.weixin.qq.com/finder-preview/pages/sph?id=xxx` |
| 短链 | `https://weixin.qq.com/sph/xxx` |
| 消息导出报文 | `export/...` 开头的 XML |
| txexport 报文 | `txexport/...` |
| 消息 JSON | 含 AddMsgList/objectId 的 JSON |
| 纯数字 id | `1234567890123457890` |

视频保存到 `downloads/` 目录，自动按标题命名，重名自动加序号。

## 工作原理

整个链路分四步：

### 1. 输入解析（纯本地）
粘贴的分享文本在本地解析出 content_id：
- 分享链接 → 取 URL 参数 id（或路径尾段），拼 `##1` 后缀
- export 报文 → 原文 + `##2`；txexport → `##3`
- 散文本/JSON → 正则提取 `objectId` 数字串

### 2. 请求签名
解析接口 `GET /sph/public/quick?id=...&sign=...` 需要带 sign 参数。sign 由
`vendor/sph_enc.js` 在本地计算（`node setup.js` 从源站获取）：

```
_sign = 时间戳;设备指纹;appId;token;sha256;版本;加密载荷
```

本项目在 Node vm 沙箱里补齐 `window/document/canvas/navigator/localStorage`
环境，让签名库脱离浏览器也能运行——不改其一行代码。

### 3. 视频地址解析
`/sph/public/quick` 返回：
```json
{
  "error": 0,
  "url": "https://...mp4",
  "_data": "base64...",
  "media": { "title": "...", "file_size": 12345678 }
}
```

### 4. 下载 + 头部还原
视频源文件前 N 字节被 XOR 加密（N = 密钥长度，通常几十 KB），直接访问
url 得到的视频无法播放。下载流式写入时把前 N 字节与密钥逐字节 XOR
还原，得到的才是正常 mp4（标准 ftyp 头）。

> 关于文件大小：`media.file_size` 是作者上传时的原始大小，CDN 实际分发
> 的往往是转码后的文件（更小），以实际下载为准。工具会在下载前先查
> CDN 真实大小并显示。

## 文件结构

```
├── app.js        # 核心逻辑：解析/签名/下载/还原（可作库引用）
├── server.js     # 本地 Web 界面（127.0.0.1:4580）
├── setup.js      # 首次运行：从源站下载签名库到 vendor/
├── inspect.js    # 调试工具：查看某视频的解析元数据
├── start.command # macOS 双击启动
└── downloads/    # 视频保存目录（不入库）
```

## 常见问题

- **视频号视频是原画质吗？** 是微信 CDN 分发的最高画质。作者上传的原始
  母带（可能大好几倍）不对外分发，任何工具都拿不到。
- **能下评论/弹幕吗？** 不能。评论数据只通过微信 App 内部协议下发，网页
  链路拿不到。
- **接口失效怎么办？** 本工具依赖第三方解析服务的公开接口，源站改版或
  关站会导致失效。可重新运行 `node setup.js` 更新签名库试试，仍不行则
  需要等项目更新。

## 注意

- 本项目与微信/Tencent 无关，解析能力来自第三方公开网站，仅供个人学习研究
- 请尊重原创内容版权，下载的视频仅供个人存档，勿用于商业用途或二次传播
- 使用者需自行承担使用风险，开发者不对任何滥用行为负责

## License

MIT（见 [LICENSE](LICENSE)）
