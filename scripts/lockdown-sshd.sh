#!/usr/bin/env bash
#
# lockdown-sshd.sh — disable root SSH and restrict to a single non-root user
#
# This is the DESTRUCTIVE step in the host bootstrap. Run it only after:
#
#   1. scripts/bootstrap-host.sh has created the target user
#   2. You have verified — in a separate terminal session — that you can
#      SSH in as that user, run `sudo -n whoami`, and `docker ps`.
#   3. The GH Actions deploy pipeline (if used) has been switched to the
#      new user via `gh secret set APP_USER` and a deploy has succeeded.
#
# Skipping any of those preconditions risks locking yourself out.
#
# Usage:
#   sudo ./scripts/lockdown-sshd.sh <username>
#
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Must run as root (sudo)." >&2
  exit 1
fi

if [ $# -ne 1 ]; then
  echo "Usage: $0 <username>" >&2
  exit 1
fi

USER_NAME="$1"

# --- safety preconditions ---------------------------------------------------
if ! id -u "$USER_NAME" >/dev/null 2>&1; then
  echo "User '$USER_NAME' does not exist. Run bootstrap-host.sh first." >&2
  exit 1
fi

USER_HOME=$(getent passwd "$USER_NAME" | cut -d: -f6)
if [ ! -s "$USER_HOME/.ssh/authorized_keys" ]; then
  echo "User '$USER_NAME' has no authorized_keys. Refusing to disable root login." >&2
  exit 1
fi

# --- write hardening drop-in -----------------------------------------------
DROPIN="/etc/ssh/sshd_config.d/99-hardening.conf"
echo "[lockdown] Writing $DROPIN..."
cat > "$DROPIN" <<EOF
# Managed by scripts/lockdown-sshd.sh — do not edit by hand.
PermitRootLogin no
X11Forwarding no
AllowTcpForwarding no
MaxAuthTries 3
AllowUsers $USER_NAME
EOF
chmod 644 "$DROPIN"

# --- validate before reloading ---------------------------------------------
echo "[lockdown] Syntax-checking sshd config..."
if ! sshd -t; then
  echo "sshd config is invalid — reverting." >&2
  rm -f "$DROPIN"
  exit 1
fi

# --- reload (does not drop existing sessions) -------------------------------
echo "[lockdown] Reloading ssh..."
systemctl reload ssh

cat <<EOF

[lockdown] sshd is now restricted:
  - Root login disabled.
  - Only '$USER_NAME' is allowed via SSH.
  - X11 + TCP forwarding off, MaxAuthTries=3.

Your current session is NOT dropped by reload. Before disconnecting:

  In a NEW terminal, confirm:
    ssh root@<host> 'whoami'              # must FAIL
    ssh $USER_NAME@<host> 'whoami'        # must succeed

  Optional final cleanup (only after the above passes):
    sudo truncate -s 0 /root/.ssh/authorized_keys
    sudo passwd -l root

EOF
