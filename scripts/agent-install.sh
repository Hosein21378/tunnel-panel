#!/usr/bin/env bash
# نصب ایجنت تونل روی یک سرور - توسط خود پنل سرو می‌شود: /install-agent.sh
# استفاده:
#   bash <(curl -Ls http://PANEL:8080/install-agent.sh) --panel http://PANEL:8080 --token TOKEN [--relay-port 10000]
set -e

PANEL=""; TOKEN=""; RELAY_PORT=10000
while [ $# -gt 0 ]; do
  case "$1" in
    --panel) PANEL="$2"; shift 2;;
    --token) TOKEN="$2"; shift 2;;
    --relay-port) RELAY_PORT="$2"; shift 2;;
    *) echo "unknown arg: $1"; exit 1;;
  esac
done
[ -z "$PANEL" ] || [ -z "$TOKEN" ] && { echo "Usage: $0 --panel http://PANEL:8080 --token TOKEN [--relay-port 10000]"; exit 1; }

echo "==> Installing Tunnel Agent (panel: $PANEL)"

# پایتون ۳
if ! command -v python3 >/dev/null 2>&1; then
  echo "==> Installing python3 ..."
  if command -v apt-get >/dev/null 2>&1; then apt-get update -y && apt-get install -y python3 curl;
  elif command -v yum >/dev/null 2>&1; then yum install -y python3 curl;
  elif command -v dnf >/dev/null 2>&1; then dnf install -y python3 curl;
  else echo "python3 not found and no supported package manager"; exit 1; fi
fi

# دانلود ایجنت از خود پنل (بدون نیاز به گیت‌هاب)
sudo mkdir -p /opt/tunnel-agent 2>/dev/null || mkdir -p /opt/tunnel-agent
echo "==> Downloading agent from $PANEL/agent.py"
curl -Ls "$PANEL/agent.py" -o /tmp/agent.py
[ -s /tmp/agent.py ] || { echo "ERROR: download failed"; exit 1; }
sudo cp /tmp/agent.py /opt/tunnel-agent/agent.py 2>/dev/null || cp /tmp/agent.py /opt/tunnel-agent/agent.py

# فایل کانفیگ
cat > /tmp/tunnel-agent.env <<EOF
PANEL_URL=$PANEL
NODE_TOKEN=$TOKEN
RELAY_PORT=$RELAY_PORT
EOF
sudo cp /tmp/tunnel-agent.env /opt/tunnel-agent/agent.env 2>/dev/null || cp /tmp/tunnel-agent.env /opt/tunnel-agent/agent.env

# سرویس systemd (اگر موجود بود)
if command -v systemctl >/dev/null 2>&1; then
  cat > /tmp/tunnel-agent.service <<EOF
[Unit]
Description=Tunnel Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/opt/tunnel-agent/agent.env
ExecStart=/usr/bin/env python3 /opt/tunnel-agent/agent.py
Restart=always
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
EOF
  sudo cp /tmp/tunnel-agent.service /etc/systemd/system/tunnel-agent.service 2>/dev/null || cp /tmp/tunnel-agent.service /etc/systemd/system/tunnel-agent.service
  systemctl daemon-reload
  systemctl enable --now tunnel-agent
  echo "==> Service started. Status:  systemctl status tunnel-agent   |   Logs:  journalctl -u tunnel-agent -f"
else
  echo "==> systemd not found; running with nohup"
  nohup env $(cat /opt/tunnel-agent/agent.env | xargs) python3 /opt/tunnel-agent/agent.py > /var/log/tunnel-agent.log 2>&1 &
  echo "==> Logs: tail -f /var/log/tunnel-agent.log"
fi

echo "==> Done! Check the panel: this server should become ONLINE in a few seconds."
