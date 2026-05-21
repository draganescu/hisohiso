#!/usr/bin/env bash
#
# bootstrap-host.sh — idempotent host hardening for a hisohiso droplet
#
# Configures everything that lives outside the Docker container:
#   - unattended-upgrades with auto-reboot at 04:00
#   - fail2ban with the default sshd jail
#   - UFW: default deny inbound, allow SSH + 80 + 443 + 443/udp
#   - non-root sudo user with SSH key auth and docker group
#   - chown of the app directory to the new user
#   - .env file mode 600
#
# Does NOT touch sshd_config — that's the destructive lockdown step in
# scripts/lockdown-sshd.sh, run only after manually verifying the new
# user can log in and the deploy pipeline still works.
#
# Re-running this script is safe: every step checks current state first.
#
# Usage:
#   sudo ./scripts/bootstrap-host.sh <username> <path-to-authorized-keys-file>
#
# The pubkeys file is the literal authorized_keys content to install for
# the new user — one key per line. Pass the GH Actions deploy key plus
# every personal admin key you want to keep working.
#
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Must run as root (sudo)." >&2
  exit 1
fi

if [ $# -ne 2 ]; then
  echo "Usage: $0 <username> <path-to-authorized-keys-file>" >&2
  exit 1
fi

USER_NAME="$1"
KEYS_FILE="$2"

if [ ! -f "$KEYS_FILE" ]; then
  echo "Keys file not found: $KEYS_FILE" >&2
  exit 1
fi

if [ ! -s "$KEYS_FILE" ]; then
  echo "Keys file is empty: $KEYS_FILE — refusing to create a passwordless user with no keys" >&2
  exit 1
fi

APP_DIR_DEFAULT="/opt/no-more-bubble-color"
APP_DIR="${APP_DIR:-$APP_DIR_DEFAULT}"

log() { printf '\n[bootstrap] %s\n' "$*"; }

# --- packages ---------------------------------------------------------------
log "Installing fail2ban, ufw, unattended-upgrades..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq fail2ban ufw unattended-upgrades >/dev/null

# --- unattended-upgrades auto-reboot ----------------------------------------
log "Configuring unattended-upgrades auto-reboot..."
# Own file (not /etc/apt/apt.conf.d/50unattended-upgrades) so distro
# upgrades of the default file don't clobber our settings.
cat > /etc/apt/apt.conf.d/52unattended-upgrades-reboot <<'EOF'
// Managed by scripts/bootstrap-host.sh — do not edit by hand.
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-WithUsers "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:00";
EOF

# --- fail2ban ---------------------------------------------------------------
log "Configuring fail2ban sshd jail..."
cat > /etc/fail2ban/jail.d/sshd.local <<'EOF'
# Managed by scripts/bootstrap-host.sh — do not edit by hand.
[sshd]
enabled = true
maxretry = 5
findtime = 10m
bantime  = 1h
EOF
systemctl enable --now fail2ban >/dev/null

# --- UFW --------------------------------------------------------------------
# Whitelist OpenSSH BEFORE enabling — running this script over SSH would
# self-lock-out otherwise. UFW's `--force enable` skips its "are you sure?"
# prompt.
log "Configuring UFW..."
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null
ufw --force enable >/dev/null
# Docker's iptables rules bypass UFW for *published* ports (80, 443) — that's
# expected; UFW here mainly protects future-listening services on the host
# itself (e.g., SSH, any service bound to 0.0.0.0 outside Docker).

# --- user creation ----------------------------------------------------------
if id -u "$USER_NAME" >/dev/null 2>&1; then
  log "User '$USER_NAME' already exists — skipping create."
else
  log "Creating user '$USER_NAME'..."
  adduser --disabled-password --gecos "" "$USER_NAME" >/dev/null
fi

log "Ensuring '$USER_NAME' is in sudo + docker groups..."
usermod -aG sudo,docker "$USER_NAME"

# --- SSH keys ---------------------------------------------------------------
USER_HOME=$(getent passwd "$USER_NAME" | cut -d: -f6)
SSH_DIR="$USER_HOME/.ssh"

log "Installing SSH keys for '$USER_NAME' into $SSH_DIR/authorized_keys..."
install -d -m 700 -o "$USER_NAME" -g "$USER_NAME" "$SSH_DIR"
install -m 600 -o "$USER_NAME" -g "$USER_NAME" "$KEYS_FILE" "$SSH_DIR/authorized_keys"

# --- sudoers ----------------------------------------------------------------
log "Granting passwordless sudo to '$USER_NAME'..."
SUDOERS_FILE="/etc/sudoers.d/90-$USER_NAME"
echo "$USER_NAME ALL=(ALL) NOPASSWD:ALL" > "$SUDOERS_FILE"
chmod 440 "$SUDOERS_FILE"
visudo -c -f "$SUDOERS_FILE" >/dev/null

# --- app dir ownership ------------------------------------------------------
if [ -d "$APP_DIR" ]; then
  log "Chowning $APP_DIR to '$USER_NAME'..."
  chown -R "$USER_NAME:$USER_NAME" "$APP_DIR"
  if [ -f "$APP_DIR/.env" ]; then
    chmod 600 "$APP_DIR/.env"
    log "Tightened $APP_DIR/.env perms to 600."
  fi
else
  log "App directory $APP_DIR not found — skipping chown (set APP_DIR=… to override)."
fi

# --- done -------------------------------------------------------------------
cat <<EOF

[bootstrap] Host setup complete.

Next steps (do these BEFORE running lockdown-sshd.sh):

  1. From a NEW terminal on your laptop, verify the new user works:
       ssh $USER_NAME@<host> 'whoami && sudo -n whoami && docker ps'
     Must print: $USER_NAME, root, and a docker container list.

  2. If the GH Actions workflow deploys to this droplet, update:
       gh secret set DO_USER --body $USER_NAME
     and confirm the GH Actions SSH key is in the authorized_keys you
     just installed.

  3. Trigger a deploy (push a trivial commit or workflow re-run) and
     watch it succeed end-to-end as $USER_NAME.

  4. Only AFTER 1-3 succeed, run on this droplet:
       sudo ./scripts/lockdown-sshd.sh $USER_NAME

EOF
