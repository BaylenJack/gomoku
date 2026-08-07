# 部署指南

## systemd 守护

```bash
sudo cp deploy/systemd.service /etc/systemd/system/gomoku.service
sudo systemctl daemon-reload
sudo systemctl enable --now gomoku
curl http://localhost:8080/healthz
```

## Cloudflare Tunnel（免备案公网方案）

见项目 README。
