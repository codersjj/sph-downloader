#!/bin/bash
# 视频号下载器 启动脚本（macOS 双击可用）
cd "$(dirname "$0")"
NODE="$(command -v node)"
if [ ! -x "$NODE" ]; then
  echo "未找到 node，请先安装 Node.js 18+"
  read -r -p "按回车关闭" _
  exit 1
fi
exec "$NODE" server.js
