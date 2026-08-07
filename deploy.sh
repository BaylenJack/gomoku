#!/usr/bin/env bash
# 五子棋一键部署脚本 — 在腾讯云 Ubuntu 服务器上以 root 或 sudo 执行
# 用法: sudo bash deploy.sh game.htyiybb.top
set -euo pipefail

DOMAIN="${1:?用法: sudo bash deploy.sh 你的域名 例如 game.htyiybb.top}"
APP_DIR="/opt/gomoku"

echo "==> [1/5] 安装依赖"
if ! command -v node >/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y nodejs >/dev/null
fi
if ! command -v caddy >/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https >/dev/null 2>&1
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update >/dev/null 2>&1
  apt-get install -y caddy >/dev/null
fi
echo "    node: $(node -v)  caddy: $(caddy version | head -c 20)"

echo "==> [2/5] 安装应用"
mkdir -p "$APP_DIR"
# 部署包应解压到 /opt/gomoku (src/ public/ package.json ...)
if [ -f /tmp/gomoku-deploy.zip ]; then
  cd /tmp && rm -rf /tmp/gomoku-extract && mkdir /tmp/gomoku-extract
  unzip -q /tmp/gomoku-deploy.zip -d /tmp/gomoku-extract
  cp -r /tmp/gomoku-extract/* "$APP_DIR/" 2>/dev/null || true
fi
cd "$APP_DIR"
[ -f package.json ] || { echo "!! 找不到 package.json, 请先上传部署包并解压到 $APP_DIR"; exit 1; }
npm install --omit=dev --silent
chmod -R a+rX "$APP_DIR"
mkdir -p "$APP_DIR/data" && chown -R root:root "$APP_DIR" 2>/dev/null || true

echo "==> [3/5] 注册 systemd 服务"
cat > /etc/systemd/system/gomoku.service <<UNIT
[Unit]
Description=Gomoku online server
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/env node src/server.js
Restart=always
RestartSec=3
Environment=PORT=8080

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now gomoku
sleep 1
curl -sf http://127.0.0.1:8080/healthz >/dev/null && echo "    服务已启动 ✓" || { echo "!! 服务启动失败, 查看: journalctl -u gomoku -n 50"; exit 1; }

echo "==> [4/5] 配置 Caddy 反向代理 + 自动 HTTPS"
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
    reverse_proxy 127.0.0.1:8080
}
CADDY
systemctl reload caddy
sleep 2

echo "==> [5/5] 验证"
# 从本机 HTTPS 拉取首页, 确认证书签发成功
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$DOMAIN/" || true)
if [ "$code" = "200" ]; then
  echo "    https://$DOMAIN/ 返回 200 ✓"
else
  echo "    首页返回 $code (首次签证书可能要等 1-2 分钟, 稍后刷新即可)"
fi

echo ""
echo "部署完成! 打开 https://$DOMAIN/ 即可玩。"
echo "让女朋友也打开同一个网址, 两人输入相同的棋室名就能对局。"
echo ""
echo "常用命令:"
echo "  查看日志   journalctl -u gomoku -f"
echo "  重启服务   systemctl restart gomoku"
echo "  停止服务   systemctl stop gomoku"
