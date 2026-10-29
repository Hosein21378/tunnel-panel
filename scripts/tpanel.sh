#!/usr/bin/env bash
# Tunnel Panel manager (v2 - single binary, zero dependencies)
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/Hosein21378/tunnel-panel/main/scripts/tpanel.sh)
#
# Without arguments it opens a menu. Commands:
#   tpanel-manager                      menu
#   tpanel-manager panel install [--port 8080]
#   tpanel-manager panel password       reset admin password
#   tpanel-manager panel logs|status|restart|uninstall
#   tpanel-manager agent --panel http://PANEL:8080 --token TOKEN [--relay-port 10000]
#   tpanel-manager agent logs|status|restart|uninstall
#   tpanel-manager status
#
# Nothing here needs python, pip or any package manager: the panel and the agent are
# one static binary. Only curl (or wget) and systemd (optional) are used.

REPO_RAW="${TPANEL_RAW_BASE:-https://raw.githubusercontent.com/Hosein21378/tunnel-panel/main}"
BIN=/usr/local/bin/tpanel
MANAGER=/usr/local/bin/tpanel-manager
DATA_DIR=/var/lib/tpanel
DATA_FILE=$DATA_DIR/data.json
CONF_DIR=/etc/tpanel
PANEL_UNIT=tpanel-panel
AGENT_UNIT=tpanel-agent
DEFAULT_PORT=8080

if [[ -t 1 ]]; then
  B=$'\e[1m'; R=$'\e[0m'; GRN=$'\e[32m'; RED=$'\e[31m'; YEL=$'\e[33m'; CYN=$'\e[36m'; DIM=$'\e[2m'
else
  B=''; R=''; GRN=''; RED=''; YEL=''; CYN=''; DIM=''
fi
info() { echo "  ${CYN}●${R} $*"; }
ok()   { echo "  ${GRN}✔${R} $*"; }
warn() { echo "  ${YEL}▲${R} $*" >&2; }
die()  { echo "  ${RED}✖ $*${R}" >&2; exit 1; }

# ---------- ابزارها ----------
need_root() {
  if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
    if command -v sudo >/dev/null 2>&1; then
      exec sudo -E bash "$MANAGER" "$@" 2>/dev/null || exec sudo -E bash <(curl -fsSL "$REPO_RAW/scripts/tpanel.sh") "$@"
    fi
    die "Run as root (sudo)."
  fi
}

arch_name() {
  case "$(uname -m)" in
    x86_64|amd64) echo amd64 ;;
    aarch64|arm64) echo arm64 ;;
    *) die "Unsupported CPU architecture: $(uname -m) (only x86_64 / arm64)" ;;
  esac
}

download() { # $1=url $2=dest
  local url=$1 dest=$2
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 --connect-timeout 15 -o "$dest" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$dest" "$url"
  else
    return 127
  fi
}

fetch_binary() { # $1=dest  $2=panel_url_or_empty
  local dest=$1 panel=${2:-} arch tmp
  arch=$(arch_name)
  tmp=$(mktemp)
  # ۱) از خود پنل (ایجنت: بدون نیاز به گیت‌هاب)
  if [[ -n "$panel" ]]; then
    info "Downloading agent binary from panel $panel ..."
    if download "$panel/tpanel" "$tmp" && [[ -s "$tmp" ]]; then
      install -m 0755 "$tmp" "$dest"; rm -f "$tmp"; return 0
    fi
    warn "Could not download from panel, trying GitHub ..."
  fi
  # ۲) از گیت‌هاب (داخل ریپو، پوشه bin)
  info "Downloading tpanel-linux-$arch from GitHub ..."
  if download "$REPO_RAW/bin/tpanel-linux-$arch" "$tmp" && [[ -s "$tmp" ]]; then
    install -m 0755 "$tmp" "$dest"; rm -f "$tmp"; return 0
  fi
  rm -f "$tmp"
  return 1
}

ensure_binary() { # $1=panel_url_or_empty
  if [[ -x "$BIN" ]] && "$BIN" version >/dev/null 2>&1; then
    return 0
  fi
  fetch_binary "$BIN" "${1:-}" || die "Download failed. Check internet/DNS, or set another mirror. Nothing was installed."
  "$BIN" version >/dev/null 2>&1 || die "Downloaded file is not a valid tpanel binary for this server."
  ok "Binary installed: $($BIN version)"
}

has_systemd() { command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; }

public_ip() {
  local ip
  ip=$(curl -fsS --max-time 4 https://api.ipify.org 2>/dev/null || true)
  [[ -z "$ip" ]] && ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  echo "${ip:-YOUR_SERVER_IP}"
}

gen_password() { tr -dc 'A-Za-z0-9' </dev/urandom | head -c 14; echo; }

install_manager_self() {
  local tmp; tmp=$(mktemp)
  if download "$REPO_RAW/scripts/tpanel.sh" "$tmp" 2>/dev/null && [[ -s "$tmp" ]]; then
    install -m 0755 "$tmp" "$MANAGER" 2>/dev/null || true
  fi
  rm -f "$tmp"
  [[ -x "$MANAGER" ]] && info "Later, just type: ${B}tpanel-manager${R}"
}

run_service() { # $1=unit-name $2=log-name $3...=command line (for no-systemd fallback)
  local unit=$1 logname=$2; shift 2
  if has_systemd; then
    systemctl enable --now "$unit" >/dev/null 2>&1 || systemctl start "$unit"
  else
    warn "systemd not found; starting in background (nohup)."
    mkdir -p /var/log
    nohup "$@" >/var/log/$logname.log 2>&1 &
    echo $! > /run/$logname.pid
  fi
}

stop_service() { # $1=unit $2=logname
  if has_systemd; then
    systemctl disable --now "$1" >/dev/null 2>&1 || true
  else
    [[ -f /run/$2.pid ]] && kill "$(cat /run/$2.pid)" 2>/dev/null || true
    rm -f /run/$2.pid
  fi
}

service_running() { # $1=unit $2=logname
  if has_systemd; then systemctl is-active --quiet "$1"; else [[ -f /run/$2.pid ]] && kill -0 "$(cat /run/$2.pid)" 2>/dev/null; fi
}

# ---------- پنل ----------
panel_install() {
  local port=$DEFAULT_PORT
  while [[ $# -gt 0 ]]; do case "$1" in --port) port=$2; shift 2;; *) shift;; esac; done
  need_root "$@"
  echo; echo "  ${B}◆ Installing Tunnel Panel (port $port)${R}"
  ensure_binary ""
  mkdir -p "$DATA_DIR" "$CONF_DIR"
  # رمز ادمین: فقط اگر قبلا ساخته نشده باشد
  if [[ ! -f "$DATA_FILE" && ! -f "$CONF_DIR/panel.env" ]]; then
    local pw; pw=$(gen_password)
    printf 'TPANEL_ADMIN_USERNAME=admin\nTPANEL_ADMIN_PASSWORD=%s\n' "$pw" > "$CONF_DIR/panel.env"
    chmod 600 "$CONF_DIR/panel.env"
  fi
  if has_systemd; then
    cat > /etc/systemd/system/$PANEL_UNIT.service <<EOF
[Unit]
Description=Tunnel Panel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=-$CONF_DIR/panel.env
ExecStart=$BIN panel --port $port --data $DATA_FILE
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
  else
    set -a; [[ -f "$CONF_DIR/panel.env" ]] && . "$CONF_DIR/panel.env"; set +a
  fi
  stop_service $PANEL_UNIT tpanel-panel
  if has_systemd; then systemctl enable --now $PANEL_UNIT >/dev/null 2>&1; else run_service $PANEL_UNIT tpanel-panel "$BIN" panel --port "$port" --data "$DATA_FILE"; fi

  local i okflag=0
  for i in $(seq 1 15); do
    if curl -fsS --max-time 2 "http://127.0.0.1:$port/health" >/dev/null 2>&1; then okflag=1; break; fi
    sleep 1
  done
  install_manager_self
  local ip; ip=$(public_ip)
  echo
  if [[ $okflag -eq 1 ]]; then ok "Panel is up!"; else warn "Panel did not answer yet on :$port (check logs: tpanel-manager panel logs)"; fi
  echo "  ${B}Panel URL:${R}  http://$ip:$port"
  echo "  ${B}Username:${R}   admin"
  if [[ -f "$CONF_DIR/panel.env" ]]; then
    echo "  ${B}Password:${R}   $(grep TPANEL_ADMIN_PASSWORD "$CONF_DIR/panel.env" | cut -d= -f2)   ${DIM}(also saved in $CONF_DIR/panel.env - change it after login)${R}"
  fi
  echo "  Open ports $port/tcp (panel) and 10000/tcp (relay, on public servers) in your firewall."
}

panel_password() {
  need_root "$@"
  command -v "$BIN" >/dev/null 2>&1 || [[ -x "$BIN" ]] || die "Panel is not installed on this server."
  local pw pw2
  read -r -s -p "  New admin password: " pw </dev/tty; echo
  read -r -s -p "  Repeat it: " pw2 </dev/tty; echo
  [[ "$pw" == "$pw2" && -n "$pw" ]] || die "Passwords do not match or empty."
  stop_service $PANEL_UNIT tpanel-panel
  "$BIN" reset-password --data "$DATA_FILE" --username admin --password "$pw" || die "Reset failed."
  printf 'TPANEL_ADMIN_USERNAME=admin\nTPANEL_ADMIN_PASSWORD=%s\n' "$pw" > "$CONF_DIR/panel.env"
  chmod 600 "$CONF_DIR/panel.env"
  run_service $PANEL_UNIT tpanel-panel "$BIN" panel --data "$DATA_FILE"
  ok "Admin password changed."
}

panel_uninstall() {
  need_root "$@"
  stop_service $PANEL_UNIT tpanel-panel
  if has_systemd; then rm -f /etc/systemd/system/$PANEL_UNIT.service; systemctl daemon-reload; fi
  echo "  Panel service removed. Data kept in $DATA_FILE"
  echo "  To delete everything:  rm -rf $DATA_DIR $CONF_DIR $BIN $MANAGER"
}

# ---------- ایجنت ----------
agent_install() {
  local panel="" token="" relay=10000
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --panel) panel=$2; shift 2;;
      --token) token=$2; shift 2;;
      --relay-port) relay=$2; shift 2;;
      *) shift;;
    esac
  done
  need_root "$@"
  if [[ -z "$panel" ]]; then read -r -p "  Panel URL (e.g. http://1.2.3.4:8080): " panel </dev/tty; fi
  if [[ -z "$token" ]]; then read -r -p "  Node token (from panel > Servers > Add server): " token </dev/tty; fi
  [[ -n "$panel" && -n "$token" ]] || die "Panel URL and token are required."
  panel=${panel%/}
  echo; echo "  ${B}◆ Connecting this server to $panel${R}"
  ensure_binary "$panel"
  if has_systemd; then
    cat > /etc/systemd/system/$AGENT_UNIT.service <<EOF
[Unit]
Description=Tunnel Panel Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$BIN agent --panel $panel --token $token --relay-port $relay
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable --now $AGENT_UNIT >/dev/null 2>&1
  else
    stop_service $AGENT_UNIT tpanel-agent
    run_service $AGENT_UNIT tpanel-agent "$BIN" agent --panel "$panel" --token "$token" --relay-port "$relay"
  fi
  sleep 2
  install_manager_self
  if service_running $AGENT_UNIT tpanel-agent; then
    ok "Agent is running. Check the panel: this server should be ONLINE."
  else
    warn "Agent service is not running; see: tpanel-manager agent logs"
  fi
}

agent_uninstall() {
  need_root "$@"
  stop_service $AGENT_UNIT tpanel-agent
  if has_systemd; then rm -f /etc/systemd/system/$AGENT_UNIT.service; systemctl daemon-reload; fi
  ok "Agent removed from this server. (Delete its record in the panel too.)"
}

show_logs() { # $1=unit $2=logname
  if has_systemd; then journalctl -u "$1" -n 50 -f; else tail -n 50 -f /var/log/$2.log; fi
}

show_status() {
  echo "  ${B}Server${R}"
  echo "    IP:       $(public_ip)  (local: $(hostname -I 2>/dev/null | awk '{print $1}'))"
  echo "    Hostname: $(hostname)"
  if [[ -x "$BIN" ]]; then echo "    Binary:   $($BIN version) at $BIN"; else echo "    Binary:   not installed"; fi
  printf "    Panel:    "; if service_running $PANEL_UNIT tpanel-panel; then echo "${GRN}running${R}  -> http://$(public_ip):$DEFAULT_PORT"; else echo "${RED}stopped${R}"; fi
  printf "    Agent:    "; if service_running $AGENT_UNIT tpanel-agent; then echo "${GRN}running${R}"; else echo "${RED}stopped${R}"; fi
}

# ---------- منو ----------
banner() {
  echo
  echo "  ${CYN}${B}◆ Tunnel Panel manager${R} ${DIM}v2 - single binary tunnel panel${R}"
  echo "  ${DIM}────────────────────────────────────────────${R}"
}
menu() {
  banner
  show_status
  echo
  echo "    1) Install / update PANEL on this server"
  echo "    2) Connect this server as AGENT to a panel"
  echo "    3) Status"
  echo "    4) Panel logs"
  echo "    5) Agent logs"
  echo "    6) Restart panel + agent"
  echo "    7) Reset panel admin password"
  echo "    8) Uninstall panel"
  echo "    9) Uninstall agent"
  echo "    0) Exit"
  echo
  local choice
  read -r -p "  Choose [0-9]: " choice </dev/tty || exit 0
  case "$choice" in
    1) panel_install ;;
    2) agent_install ;;
    3) show_status ;;
    4) show_logs $PANEL_UNIT tpanel-panel ;;
    5) show_logs $AGENT_UNIT tpanel-agent ;;
    6) stop_service $PANEL_UNIT tpanel-panel; stop_service $AGENT_UNIT tpanel-agent;
       has_systemd && { systemctl start $PANEL_UNIT 2>/dev/null; systemctl start $AGENT_UNIT 2>/dev/null; }
       service_running $PANEL_UNIT tpanel-panel || run_service $PANEL_UNIT tpanel-panel "$BIN" panel --data "$DATA_FILE";
       ok "Restarted." ;;
    7) panel_password ;;
    8) panel_uninstall ;;
    9) agent_uninstall ;;
    0) exit 0 ;;
    *) warn "Invalid choice: $choice"; sleep 1; menu ;;
  esac
}

case "${1:-}" in
  "") menu ;;
  panel)
    shift
    case "${1:-install}" in
      install) shift; panel_install "$@" ;;
      password|passwd) panel_password ;;
      logs) show_logs $PANEL_UNIT tpanel-panel ;;
      status) show_status ;;
      restart) stop_service $PANEL_UNIT tpanel-panel; run_service $PANEL_UNIT tpanel-panel "$BIN" panel --data "$DATA_FILE" ;;
      uninstall|remove) panel_uninstall ;;
      *) die "Usage: tpanel-manager panel install|password|logs|status|restart|uninstall" ;;
    esac ;;
  agent)
    shift
    case "${1:-}" in
      logs) show_logs $AGENT_UNIT tpanel-agent ;;
      status) show_status ;;
      restart) stop_service $AGENT_UNIT tpanel-agent; warn "Start it again with: tpanel-manager agent --panel URL --token TOKEN" ;;
      uninstall|remove) agent_uninstall ;;
      *) agent_install "$@" ;;
    esac ;;
  status) show_status ;;
  install) panel_install "$@" ;;
  uninstall|remove) panel_uninstall; agent_uninstall ;;
  help|-h|--help)
    sed -n '2,20p' "$MANAGER" 2>/dev/null || echo "See: $REPO_RAW/scripts/tpanel.sh" ;;
  *) die "Unknown command: $1 (try: tpanel-manager help)" ;;
esac
