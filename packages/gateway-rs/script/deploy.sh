#!/bin/bash
# 编译 musl 静态二进制并部署到远程服务器
# 用法：
#   ./script/deploy.sh              # 编译 + 上传 + 重启服务
#   ./script/deploy.sh --no-build   # 跳过编译，只上传已有产物并重启
# 部署目标从本地 .deploy-env（gitignore，不入库）读取，可被环境变量覆盖
set -euo pipefail
cd "$(dirname "$0")/.."

# 本地部署配置（不入库），格式：
#   DEPLOY_HOST=root@your-server
#   DEPLOY_BIN=/root/app/dynapm
#   DEPLOY_SERVICE=dynapm
if [ -f .deploy-env ]; then
  source .deploy-env
fi
: "${DEPLOY_HOST:?请在 packages/gateway-rs/.deploy-env 设置 DEPLOY_HOST（不入库，参考 deploy.sh 头部注释）}"
: "${DEPLOY_BIN:=/root/app/dynapm}"
: "${DEPLOY_SERVICE:=dynapm}"
# musl 静态编译产物本地路径
LOCAL_BIN="target/x86_64-unknown-linux-musl/release/dynapm"

if [ "${1:-}" != "--no-build" ]; then
  echo "🔨 编译 musl 静态二进制..."
  RUSTFLAGS="-C target-feature=+crt-static" cargo build --release --target x86_64-unknown-linux-musl
fi

if [ ! -f "$LOCAL_BIN" ]; then
  echo "❌ 找不到编译产物 $LOCAL_BIN，先执行编译（去掉 --no-build）" >&2
  exit 1
fi

echo "📤 上传到 $DEPLOY_HOST:$DEPLOY_BIN ..."
# 二进制运行中时 scp 直接覆盖会报 text file busy，先传临时文件再原子 mv
TMP="$DEPLOY_BIN.tmp.$$"
scp -q "$LOCAL_BIN" "$DEPLOY_HOST:$TMP"
ssh "$DEPLOY_HOST" "mv $TMP $DEPLOY_BIN && chmod +x $DEPLOY_BIN"

echo "🔄 重启 $DEPLOY_SERVICE ..."
ssh "$DEPLOY_HOST" "systemctl restart $DEPLOY_SERVICE && sleep 1 && systemctl is-active $DEPLOY_SERVICE"

echo "✅ 部署完成"
