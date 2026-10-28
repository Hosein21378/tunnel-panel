#!/usr/bin/env bash
# نصب‌کننده اصلی Tunnel Panel
#
# نصب پنل (از ریپوی گیت):
#   bash <(curl -Ls https://raw.githubusercontent.com/Hosein21378/tunnel-panel/main/install.sh)
#   یا بعد از کلون:  sudo bash install.sh --mode panel
#
# نصب ایجنت (راه ساده‌تر: از داخل خود پنل دستور آماده بگیرید):
#   bash <(curl -Ls http://PANEL:8080/install-agent.sh) --panel http://PANEL:8080 --token TOKEN
set -e

MODE="panel"; PANEL_URL=""; TOKEN=""; PORT=8080; RELAY_PORT=10000
REPO_URL="${REPO_URL:-https://github.com/Hosein21378/tunnel-panel.git}"
INSTALL_DIR="/opt/tunnel-panel"

while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="$2"; shift 2;;
    --panel) PANEL_URL="$2"; shift 2;;
    --token) TOKEN="$2"; shift 2;;
    --port) PORT="$2"; shift 2;;
    --relay-port) RELAY_PORT="$2"; shift 2;;
    --repo) REPO_URL="$2"; shift 2;;
    *) echo "unknown arg: $1"; exit 1;;
  esac
done

if [ "$MODE" = "agent" ]; then
  [ -n "$PANEL_URL" ] && [ -n "$TOKEN" ] || { echo "agent mode needs --panel and --token"; exit 1; }
  exec bash <(curl -Ls "$PANEL_URL/install-agent.sh") --panel "$PANEL_URL" --token "$TOKEN" --relay-port "$RELAY_PORT"
fi

echo "==> Installing Tunnel Panel on port $PORT"

# وابستگی‌ها
if command -v apt-get >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y python3 python3-venv python3-pip git curl
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y python3 python3-devel git curl
fi

# دریافت سورس
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-/dev/null}")" 2>/dev/null && pwd || echo "")"
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/requirements.txt" ]; then
  echo "==> Using local source: $SCRIPT_DIR"
  mkdir -p "$INSTALL_DIR"
  cp -r "$SCRIPT_DIR"/. "$INSTALL_DIR"/
elif [ -n "$REPO_URL" ]; then
  echo "==> Cloning $REPO_URL"
  rm -rf "$INSTALL_DIR"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
else
  echo "ERROR: run from cloned repo, or set REPO_URL (default: https://github.com/Hosein21378/tunnel-panel.git)"
  exit 1
fi

cd "$INSTALL_DIR"
python3 -m venv .venv
# نصب وابستگی‌ها با تلاش مجدد و میرور جایگزین (برای سرورهایی که DNS/PyPI مشکل دارد)
install_deps() {
  local idx
  for idx in "${PIP_INDEX_URL:-}" "https://pypi.org/simple" "https://mirrors.aliyun.com/pypi/simple" "https://pypi.tuna.tsinghua.edu.cn/simple"; do
    [ -z "$idx" ] && continue
    echo "==> Trying package index: $idx"
    if .venv/bin/pip install --retries 5 --timeout 60 -i "$idx" -r requirements.txt; then
      return 0
    fi
    echo "==> failed with $idx -- trying next ..."
  done
  echo "ERROR: pip install failed from all indexes."
  echo "Check internet/DNS on this server, e.g.:  ping -c1 pypi.org"
  echo "Fix DNS (example):  echo 'nameserver 8.8.8.8' | sudo tee /etc/resolv.conf"
  return 1
}
install_deps

# ساخت .env با سکرت تصادفی (فقط بار اول)
if [ ! -f .env ]; then
  SECRET=$(python3 -c "import secrets; print(secrets.token_hex(32))")
  ADMIN_PASS=$(python3 -c "import secrets; print(secrets.token_urlsafe(9))")
  cat > .env <<EOF
SECRET_KEY=$SECRET
ADMIN_USERNAME=admin
ADMIN_PASSWORD=$ADMIN_PASS
DATABASE_URL=sqlite:////opt/tunnel-panel/tunnel-panel.db
EOF
  echo ""
  echo "=================================================="
  echo "  Panel admin username: admin"
  echo "  Panel admin password: [SECURITY_DATA]"
  echo "  (ذخیره‌اش کنید - در فایل $INSTALL_DIR/.env هم هست)"
  echo "=================================================="
  echo ""
fi

# سرویس systemd
if command -v systemctl >/dev/null 2>&1; then
  cat > /etc/systemd/system/tunnel-panel.service <<EOF
[Unit]
Description=Tunnel Panel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$INSTALL_DIR/.env
ExecStart=$INSTALL_DIR/.venv/bin/uvicorn app.main:app --app-dir $INSTALL_DIR/panel --host 0.0.0.0 --port $PORT
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now tunnel-panel
  echo "==> Panel is up:  http://$(hostname -I | awk '{print $1}'):$PORT"
  echo "==> Logs: journalctl -u tunnel-panel -f"
else
  echo "==> systemd not found. Run manually:"
  echo "    cd $INSTALL_DIR && set -a && . ./.env && .venv/bin/uvicorn app.main:app --app-dir panel --host 0.0.0.0 --port $PORT"
fi
