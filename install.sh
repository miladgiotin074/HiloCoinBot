#!/usr/bin/env bash
#
#  HiloCoinBot — one-command installer & updater for Ubuntu / Debian servers
#
#  Install (run on your server):
#    curl -fsSL https://raw.githubusercontent.com/miladgiotin074/HiloCoinBot/main/install.sh -o install.sh && sudo bash install.sh
#
#  What it does: installs Node.js + Nginx + Certbot, downloads the bot to /opt/hilocoinbot,
#  asks for your bot token / domain, gets a free HTTPS certificate, and runs the bot as a
#  system service that starts automatically after reboots.
#
#  Non-interactive (everything except BOT_TOKEN is optional):
#    sudo BOT_TOKEN=123:ABC DOMAIN=bot.example.com ADMIN_IDS=111,222 bash install.sh
#
#  Running it again updates the code and restarts the bot — your .env and database are kept.
#  Options:  --reconfigure   answer the setup questions again
#
set -Eeuo pipefail

REPO_URL="${REPO_URL:-https://github.com/miladgiotin074/HiloCoinBot.git}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-/opt/hilocoinbot}"
APP_USER="${APP_USER:-hilocoin}"
SERVICE="hilocoinbot"
NODE_MAJOR=22
ENV_FILE="$APP_DIR/.env"

RECONFIGURE=0
GENERATED_PW=""
BOT_USERNAME=""
SSL_OK=0
DOMAIN=""
PORT_NUM=""

# ─────────────────────────────── helpers ───────────────────────────────

if [ -t 1 ]; then
  B=$'\e[1m' G=$'\e[32m' Y=$'\e[33m' R=$'\e[31m' C=$'\e[36m' D=$'\e[2m' N=$'\e[0m'
else
  B='' G='' Y='' R='' C='' D='' N=''
fi
step() { printf '\n%s%s==> %s%s\n' "$C" "$B" "$*" "$N"; }
ok()   { printf '%s✔%s %s\n' "$G" "$N" "$*"; }
info() { printf '%s  %s%s\n' "$D" "$*" "$N"; }
warn() { printf '%s⚠  %s%s\n' "$Y" "$*" "$N"; }
die()  { printf '\n%s✖  %s%s\n' "$R" "$*" "$N" >&2; exit 1; }
on_error() { die "Installation failed (line $1). Fix the problem shown above and run the script again."; }

HAS_TTY=0
if (exec </dev/tty) 2>/dev/null; then HAS_TTY=1; fi

# ask VAR "Question" [default]
ask() {
  local __var=$1 __q=$2 __def=${3:-} __ans=''
  if [ "$HAS_TTY" = 1 ]; then
    if [ -n "$__def" ]; then printf '%s?%s %s %s[%s]%s: ' "$B" "$N" "$__q" "$D" "$__def" "$N" >/dev/tty
    else printf '%s?%s %s: ' "$B" "$N" "$__q" >/dev/tty; fi
    IFS= read -r __ans </dev/tty || true
  fi
  printf -v "$__var" '%s' "${__ans:-$__def}"
}

# ask_secret VAR "Question"  (input is hidden)
ask_secret() {
  local __var=$1 __q=$2 __ans=''
  if [ "$HAS_TTY" = 1 ]; then
    printf '%s?%s %s: ' "$B" "$N" "$__q" >/dev/tty
    IFS= read -rs __ans </dev/tty || true
    printf '\n' >/dev/tty
  fi
  printf -v "$__var" '%s' "$__ans"
}

# env_get KEY  → value from .env (surrounding quotes removed)
env_get() {
  [ -f "$ENV_FILE" ] || return 0
  local line
  line=$(grep -E "^$1=" "$ENV_FILE" | tail -n 1 || true)
  line=${line#*=}
  line=${line%$'\r'}
  line=${line#\'}; line=${line%\'}
  line=${line#\"}; line=${line%\"}
  printf '%s' "$line"
}

public_ip() {
  local ip=''
  ip=$(curl -4 -fsS --max-time 6 https://api.ipify.org 2>/dev/null || true)
  [ -n "$ip" ] || ip=$(curl -4 -fsS --max-time 6 https://ifconfig.me 2>/dev/null || true)
  [ -n "$ip" ] || ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  printf '%s' "$ip"
}

# check_token TOKEN → prints the bot username. Exit codes: 0 valid, 1 rejected, 2 network problem.
check_token() {
  local out
  out=$(curl -sS --max-time 15 "https://api.telegram.org/bot$1/getMe" 2>/dev/null) || return 2
  node -e '
    let j; try { j = JSON.parse(process.argv[1]); } catch { process.exit(2); }
    if (j.ok) console.log(j.result.username); else process.exit(1);
  ' "$out"
}

normalize_domain() {
  local d=$1
  d=${d#http://}; d=${d#https://}; d=${d%%/*}; d=${d%%:*}
  printf '%s' "$d" | tr '[:upper:]' '[:lower:]'
}

# ─────────────────────────────── steps ───────────────────────────────

preflight() {
  [ "$(id -u)" -eq 0 ] || die "Please run as root:  sudo bash install.sh"
  [ -r /etc/os-release ] || die "Unsupported system: /etc/os-release not found."
  # shellcheck disable=SC1091
  . /etc/os-release
  case " ${ID:-} ${ID_LIKE:-} " in
    *" debian "* | *" ubuntu "*) ;;
    *) die "This installer supports Ubuntu and Debian only (found: ${PRETTY_NAME:-unknown})." ;;
  esac
  command -v systemctl >/dev/null || die "systemd is required."
  printf '%s%s\n  🪙  HiloCoinBot installer%s  %s(%s)%s\n' "$B" "$Y" "$N" "$D" "${PRETTY_NAME:-Linux}" "$N"
}

install_packages() {
  step "Installing system packages (Nginx, Certbot, Git…)"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates gnupg git nginx certbot python3-certbot-nginx \
    build-essential python3 openssl >/dev/null
  ok "System packages ready"

  local major=0
  if command -v node >/dev/null; then major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0); fi
  if [ "$major" -lt "$NODE_MAJOR" ]; then
    step "Installing Node.js $NODE_MAJOR"
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null 2>&1
    apt-get install -y -qq nodejs >/dev/null
  fi
  ok "Node.js $(node -v)"
}

fetch_code() {
  step "Downloading HiloCoinBot"
  id -u "$APP_USER" >/dev/null 2>&1 ||
    useradd --system --home-dir "$APP_DIR" --no-create-home --shell /usr/sbin/nologin "$APP_USER"

  local g=(git -c "safe.directory=$APP_DIR" -C "$APP_DIR")
  if [ -d "$APP_DIR/.git" ]; then
    "${g[@]}" fetch --quiet origin "$BRANCH"
    "${g[@]}" reset --quiet --hard "origin/$BRANCH"
    ok "Updated to the latest version ($("${g[@]}" rev-parse --short HEAD))"
  else
    if [ -d "$APP_DIR" ] && [ -n "$(ls -A "$APP_DIR" 2>/dev/null)" ]; then
      die "$APP_DIR already exists and is not a HiloCoinBot folder. Move it away, or run with APP_DIR=/another/path."
    fi
    git clone --quiet --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
    ok "Downloaded to $APP_DIR"
  fi

  step "Installing dependencies"
  cd "$APP_DIR"
  # better-sqlite3 ships prebuilt binaries in the package, so no install scripts are needed.
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error
  if ! node -e "require('better-sqlite3')(':memory:')" >/dev/null 2>&1; then
    info "No prebuilt SQLite binary for this CPU — compiling it (this can take a few minutes)…"
    npm run build-release --prefix node_modules/better-sqlite3 --loglevel=error >/dev/null 2>&1 || true
    node -e "require('better-sqlite3')(':memory:')" >/dev/null 2>&1 || die "Could not build the SQLite module for this system."
  fi
  mkdir -p data backups
  ok "Dependencies installed"
}

configure() {
  step "Configuration"
  if [ "$HAS_TTY" != 1 ] && [ -z "${BOT_TOKEN:-}" ] && [ -z "$(env_get BOT_TOKEN)" ]; then
    die "No terminal to ask questions. Pass the settings as variables, e.g.: sudo BOT_TOKEN=123:ABC DOMAIN=bot.example.com bash install.sh"
  fi

  # 1) Bot token ────────────────────────────────────────────
  local current token="${BOT_TOKEN:-}" rc=0
  current=$(env_get BOT_TOKEN)
  if [ -z "$token" ] && [ -n "$current" ] && [ "$HAS_TTY" = 1 ]; then
    ask token "Bot token (press Enter to keep the current one ${current%%:*}:…)"
  fi
  token=${token:-$current}
  while :; do
    if [ -z "$token" ]; then
      info "Create a bot in Telegram with @BotFather (/newbot) and paste the token it gives you."
      ask token "Bot token"
      [ -n "$token" ] || continue
    fi
    if [[ ! $token =~ ^[0-9]+:[A-Za-z0-9_-]{30,}$ ]]; then
      warn "That does not look like a bot token (format 123456789:AA…)."
      [ "$HAS_TTY" = 1 ] || die "Invalid BOT_TOKEN."
      token=''; continue
    fi
    if BOT_USERNAME=$(check_token "$token"); then
      ok "Token is valid — bot @$BOT_USERNAME"
      break
    else
      rc=$?
    fi
    if [ "$rc" = 2 ]; then
      warn "Could not reach api.telegram.org from this server — continuing without verifying the token."
      warn "The bot needs access to Telegram's API; if Telegram is blocked here, use a server in another country."
      BOT_USERNAME=''
      break
    fi
    warn "Telegram rejected this token. Copy it again from @BotFather."
    [ "$HAS_TTY" = 1 ] || die "Invalid BOT_TOKEN."
    token=''
  done

  # 2) Domain ───────────────────────────────────────────────
  local ip domain
  ip=$(public_ip)
  domain=$(normalize_domain "${DOMAIN:-$(env_get WEBAPP_URL)}")
  if [ -z "${DOMAIN:-}" ] && [ "$HAS_TTY" = 1 ]; then
    info "Telegram Mini Apps need HTTPS. Enter a domain or subdomain whose DNS A record points to this"
    info "server (${ip:-unknown IP}), or leave it empty to use the free address ${ip//./-}.sslip.io"
    ask domain "Domain" "$domain"
    domain=$(normalize_domain "$domain")
  fi
  if [ -z "$domain" ]; then
    [ -n "$ip" ] || die "Could not detect this server's public IP. Please run again with DOMAIN=your.domain"
    domain="${ip//./-}.sslip.io"
    info "Using free domain: $domain"
  fi
  [[ $domain =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$ ]] || die "Invalid domain: $domain"
  local resolved
  resolved=$(getent ahostsv4 "$domain" 2>/dev/null | awk 'NR==1{print $1}' || true)
  if [ -n "$ip" ] && [ "$resolved" != "$ip" ]; then
    warn "DNS of $domain points to '${resolved:-nothing}', not to this server ($ip)."
    warn "Add an A record for $domain → $ip, otherwise the SSL certificate cannot be issued."
  fi

  # 3) Admin IDs ────────────────────────────────────────────
  local admin_ids="${ADMIN_IDS:-$(env_get ADMIN_IDS)}"
  if [ -z "${ADMIN_IDS:-}" ] && [ "$HAS_TTY" = 1 ]; then
    info "Your numeric Telegram ID (send any message to @userinfobot to get it). Admins can use /stats"
    info "in the bot and receive test broadcasts. Separate several IDs with commas."
    ask admin_ids "Admin Telegram ID(s) (optional)" "$admin_ids"
  fi
  admin_ids=$(printf '%s' "$admin_ids" | tr -d ' ')
  if [ -n "$admin_ids" ] && [[ ! $admin_ids =~ ^[0-9]+(,[0-9]+)*$ ]]; then
    warn "Ignoring invalid admin IDs: $admin_ids"
    admin_ids=''
  fi

  # 4) Admin panel password ─────────────────────────────────
  local admin_pw="${ADMIN_PASSWORD:-}"
  if [ -z "$admin_pw" ] && [ "$HAS_TTY" = 1 ]; then
    while :; do
      ask_secret admin_pw "Admin panel password (leave empty to generate a strong one)"
      if [[ $admin_pw == *"'"* || $admin_pw =~ [[:space:]] ]]; then warn "Please don't use spaces or ' in the password."; continue; fi
      if [ -n "$admin_pw" ] && [ ${#admin_pw} -lt 8 ]; then warn "Use at least 8 characters."; continue; fi
      break
    done
  fi
  if [ -z "$admin_pw" ]; then
    admin_pw=$(openssl rand -hex 12)
    GENERATED_PW=$admin_pw
  fi

  # 5) Email for the SSL certificate ────────────────────────
  if [ -z "${LE_EMAIL:-}" ] && [ "$HAS_TTY" = 1 ]; then
    ask LE_EMAIL "Email for SSL expiry notices (optional)"
  fi

  local port="${PORT:-$(env_get PORT)}"
  port=${port:-3000}

  umask 077
  cat >"$ENV_FILE" <<EOF
# HiloCoinBot settings — generated by install.sh on $(date -u '+%Y-%m-%d %H:%M UTC')
# Change them with:  sudo hilocoin config
BOT_TOKEN=$token
WEBAPP_URL=https://$domain
ADMIN_PASSWORD='$admin_pw'
ADMIN_IDS=$admin_ids
PORT=$port
BOT_MODE=polling
DEV_MODE=false
EOF
  umask 022
  ok "Settings saved to $ENV_FILE"
}

load_config() {
  DOMAIN=$(normalize_domain "$(env_get WEBAPP_URL)")
  PORT_NUM=$(env_get PORT)
  PORT_NUM=${PORT_NUM:-3000}
  if [ -z "$BOT_USERNAME" ]; then BOT_USERNAME=$(check_token "$(env_get BOT_TOKEN)" 2>/dev/null || true); fi
}

check_port() {
  systemctl is-active --quiet "$SERVICE" && return 0
  if [ -n "$(ss -ltnH "sport = :$PORT_NUM" 2>/dev/null || true)" ]; then
    die "Port $PORT_NUM is already used by another program. Run again with PORT=3001 (or another free port) and --reconfigure."
  fi
}

setup_nginx() {
  step "Configuring Nginx for $DOMAIN"
  local conf="/etc/nginx/sites-available/$SERVICE" marker="# hilocoin: $DOMAIN $PORT_NUM" current=''
  [ -f "$conf" ] && current=$(cat "$conf")
  # Keep the existing file (it holds Certbot's HTTPS settings) unless the domain or port changed.
  if [[ $current != *"$marker"* ]]; then
    write_nginx_conf "$conf" "$marker"
  fi
  ln -sf "$conf" "/etc/nginx/sites-enabled/$SERVICE"
  nginx -t -q 2>/dev/null || { nginx -t; die "Nginx configuration test failed."; }
  systemctl enable --now nginx >/dev/null 2>&1
  systemctl reload nginx

  local fw
  if command -v ufw >/dev/null; then
    fw=$(ufw status 2>/dev/null || true)
    if [[ $fw == *"Status: active"* ]]; then
      ufw allow OpenSSH >/dev/null 2>&1 || true
      ufw allow 'Nginx Full' >/dev/null 2>&1 || true
      ok "Firewall: ports 80 and 443 opened"
    fi
  fi
  ok "Nginx ready"
}

write_nginx_conf() {
  local v6=''
  [ -f /proc/net/if_inet6 ] && v6='    listen [::]:80;'
  cat >"$1" <<EOF
# HiloCoinBot — generated by install.sh
$2
server {
    listen 80;
$v6
    server_name $DOMAIN;
    client_max_body_size 1m;

    location / {
        proxy_pass http://127.0.0.1:$PORT_NUM;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;
    }
}
EOF
}

setup_ssl() {
  step "Getting a free SSL certificate (Let's Encrypt)"
  local conf
  conf=$(cat "/etc/nginx/sites-available/$SERVICE")
  if [[ $conf == *"ssl_certificate"* ]] && [ -d "/etc/letsencrypt/live/$DOMAIN" ]; then
    SSL_OK=1
    ok "HTTPS already enabled for $DOMAIN (renews automatically)"
    return 0
  fi
  local mail=(--register-unsafely-without-email)
  [ -n "${LE_EMAIL:-}" ] && mail=(-m "$LE_EMAIL")
  if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos "${mail[@]}" \
    --redirect --keep-until-expiring >/var/log/hilocoin-certbot.log 2>&1; then
    SSL_OK=1
    ok "HTTPS enabled for $DOMAIN (renews automatically)"
  else
    SSL_OK=0
    warn "Could not get an SSL certificate for $DOMAIN — details: /var/log/hilocoin-certbot.log"
    warn "Check that the domain's A record points to this server and ports 80/443 are open, then run:  sudo hilocoin update"
  fi
}

setup_service() {
  step "Starting the bot service"
  chown -R "$APP_USER:$APP_USER" "$APP_DIR"
  chmod 600 "$ENV_FILE"

  cat >"/etc/systemd/system/$SERVICE.service" <<EOF
[Unit]
Description=HiloCoinBot (Telegram bot + Mini App)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=$(command -v node) src/index.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

  write_cli /usr/local/bin/hilocoin

  systemctl daemon-reload
  systemctl enable "$SERVICE" >/dev/null 2>&1
  START_TS=$(date '+%Y-%m-%d %H:%M:%S')
  systemctl restart "$SERVICE"

  local i
  for i in $(seq 1 30); do
    if curl -fsS --max-time 2 "http://127.0.0.1:$PORT_NUM/health" >/dev/null 2>&1; then break; fi
    if [ "$i" = 30 ]; then
      journalctl -u "$SERVICE" -n 40 --no-pager || true
      die "The server did not start. See the log above."
    fi
    sleep 1
  done
  ok "Server is running on port $PORT_NUM"

  local logs=''
  for i in $(seq 1 15); do
    logs=$(journalctl -u "$SERVICE" --since "$START_TS" --no-pager 2>/dev/null || true)
    [[ $logs == *"polling started"* || $logs == *"failed to start"* ]] && break
    sleep 1
  done
  if [[ $logs == *"polling started"* ]]; then
    ok "Telegram bot is online"
  else
    warn "The bot has not connected to Telegram yet. Check the logs with:  hilocoin logs"
  fi
}

# write_cli PATH — the `hilocoin` management command
write_cli() {
  cat >"$1" <<EOF
#!/usr/bin/env bash
# HiloCoinBot management command — generated by install.sh
APP_DIR="$APP_DIR"; SERVICE="$SERVICE"; APP_USER="$APP_USER"
[ "\$(id -u)" -eq 0 ] || exec sudo "\$0" "\$@"
case "\${1:-help}" in
  status)  systemctl status "\$SERVICE" --no-pager ;;
  logs)    journalctl -u "\$SERVICE" -n 100 -f ;;
  restart) systemctl restart "\$SERVICE" && echo "✔ restarted" ;;
  start|stop) systemctl "\$1" "\$SERVICE" && echo "✔ \$1" ;;
  update)  cp "\$APP_DIR/install.sh" /tmp/hilocoin-install.sh && exec bash /tmp/hilocoin-install.sh ;;
  config)  cp "\$APP_DIR/install.sh" /tmp/hilocoin-install.sh && exec bash /tmp/hilocoin-install.sh --reconfigure ;;
  backup)
    f="\$APP_DIR/backups/hilocoin-\$(date +%Y%m%d-%H%M%S).db"
    cd "\$APP_DIR" && sudo -u "\$APP_USER" node -e "require('better-sqlite3')('data/hilocoin.db',{readonly:true}).backup(process.argv[1]).then(()=>console.log('✔ backup saved: '+process.argv[1]))" "\$f" ;;
  *)
    echo "Usage: hilocoin <command>"
    echo "  status    show whether the bot is running"
    echo "  logs      live logs (Ctrl+C to exit)"
    echo "  restart   restart the bot"
    echo "  stop      stop the bot          start   start the bot"
    echo "  update    download the latest version and restart"
    echo "  config    change token / domain / admin settings"
    echo "  backup    save a copy of the database to \$APP_DIR/backups" ;;
esac
EOF
  chmod 755 "$1"
}

summary() {
  local scheme=https
  [ "$SSL_OK" = 1 ] || scheme=http
  local line='════════════════════════════════════════════════════════════'
  printf '\n%s%s%s\n' "$G" "$line" "$N"
  printf '%s  🎉  HiloCoinBot is ready!%s\n\n' "$B" "$N"
  [ -n "$BOT_USERNAME" ] && printf '  🤖 Bot:           %shttps://t.me/%s%s\n' "$B" "$BOT_USERNAME" "$N"
  printf '  📱 Mini App:      %s://%s/\n' "$scheme" "$DOMAIN"
  printf '  🛠  Admin panel:  %s%s://%s/admin/%s\n' "$B" "$scheme" "$DOMAIN" "$N"
  if [ -n "$GENERATED_PW" ]; then
    printf '  🔑 Admin password: %s%s%s   %s(also saved in %s)%s\n' "$Y$B" "$GENERATED_PW" "$N" "$D" "$ENV_FILE" "$N"
  else
    printf '  🔑 Admin password: the one you entered %s(saved in %s)%s\n' "$D" "$ENV_FILE" "$N"
  fi
  printf '\n  Commands:  %shilocoin status | logs | restart | update | config | backup%s\n' "$B" "$N"
  printf '  Data:      %s/data  (database — back it up regularly)\n' "$APP_DIR"
  printf '%s%s%s\n' "$G" "$line" "$N"
  if [ "$SSL_OK" != 1 ]; then
    warn "HTTPS is not active yet, so the Mini App button will not appear in the bot. Fix DNS, then run: sudo hilocoin update"
  fi
  [ -n "$BOT_USERNAME" ] && info "Open https://t.me/$BOT_USERNAME and press Start."
  return 0
}

main() {
  for arg in "$@"; do
    case "$arg" in
      --reconfigure) RECONFIGURE=1 ;;
      -h | --help) sed -n '2,20p' "$0" 2>/dev/null || true; exit 0 ;;
      *) die "Unknown option: $arg  (use --help)" ;;
    esac
  done
  trap 'on_error $LINENO' ERR

  preflight
  install_packages
  fetch_code
  if [ "$RECONFIGURE" = 1 ] || [ -z "$(env_get BOT_TOKEN)" ] || [ -z "$(env_get WEBAPP_URL)" ]; then
    configure
  else
    ok "Using existing settings from $ENV_FILE  (change them with: sudo hilocoin config)"
  fi
  load_config
  check_port
  setup_nginx
  setup_ssl
  setup_service
  summary
}

# HILO_SOURCE_ONLY=1 lets tests load the functions without running the installer.
if [ "${HILO_SOURCE_ONLY:-0}" != 1 ]; then main "$@"; fi
