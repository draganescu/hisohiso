# Host bootstrap — provisioning a hisohiso droplet

This is the host-OS counterpart to [README.md](../README.md)'s "Production setup". The README covers what to run inside the container (Docker, compose). This doc covers what to do *to* the host before that, and how to harden SSH after.

The repo carries two scripts:

| Script                          | When                                               | What it does                                                                                                       |
| ------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `scripts/bootstrap-host.sh`     | Once per droplet (fresh or migrating)              | Installs fail2ban, ufw, unattended-upgrades. Configures auto-reboot. Creates a non-root sudo user with SSH keys.   |
| `scripts/lockdown-sshd.sh`      | Once per droplet, AFTER verifying the new user     | Disables root SSH, restricts SSH to the new user only, turns off X11 + TCP forwarding.                             |

The split is deliberate: `bootstrap-host.sh` is idempotent and safe to re-run; `lockdown-sshd.sh` is destructive and the only step that can lock you out if you haven't tested first.

---

## Fresh droplet

Assumes Ubuntu 22.04 or 24.04 LTS, a clone of this repo at `/opt/no-more-bubble-color`, and `.env` populated per the README.

```bash
# As root on the droplet
cd /opt/no-more-bubble-color

# Curate the keys the new deploy user will get. Typically:
#   - Your personal admin key
#   - The GH Actions deploy key (whatever you have in the DO_SSH_KEY secret)
cat > /tmp/deploy-keys <<'EOF'
ssh-ed25519 AAAA...your-admin-key... admin
ssh-ed25519 AAAA...github-actions-key... gh-actions
EOF

# Run the bootstrap. `deploy` is the conventional service-account name;
# pick anything you like.
./scripts/bootstrap-host.sh deploy /tmp/deploy-keys
rm /tmp/deploy-keys

# Verify the new user, then deploy the app:
sudo -u deploy ./scripts/deploy.sh

# In a separate terminal on your laptop:
ssh deploy@<host> 'whoami && sudo -n whoami && docker ps'
# Expect: deploy, root, the container list.

# Only after that succeeds:
./scripts/lockdown-sshd.sh deploy
```

After lockdown, root SSH is disabled and only `deploy` can log in. Your existing root session is NOT dropped by the reload — confirm the lockdown works in a separate terminal before closing it.

---

## Existing droplet (migrating from root-only)

Same scripts; just take the safety gates seriously because you're in a session that the lockdown step could in principle break.

```bash
# As root on the droplet
cd /opt/no-more-bubble-color

# Stage the keys (same as fresh-droplet case)
cat > /tmp/deploy-keys <<'EOF'
ssh-ed25519 AAAA...admin... admin
ssh-ed25519 AAAA...github-actions-key... gh-actions
EOF

./scripts/bootstrap-host.sh deploy /tmp/deploy-keys
rm /tmp/deploy-keys
```

🔒 **Safety gate.** From a NEW terminal on your laptop — **don't close the current root SSH session** — verify:

```bash
ssh deploy@<host> 'whoami && sudo -n whoami && docker ps'
```

Must succeed. If it doesn't, debug from your existing root session.

Then update the GH Actions deploy user:

```bash
gh secret set DO_USER --body deploy --repo <owner>/<repo>
```

Push any trivial commit (or re-run the last deploy workflow). The workflow must succeed end-to-end as `deploy`. If it doesn't, fix and retry before continuing.

🔒 **Final gate.** Only once both the manual SSH and the GH Actions deploy succeed as `deploy`:

```bash
./scripts/lockdown-sshd.sh deploy
```

The reload doesn't drop existing sessions. In a fresh terminal, confirm:

```bash
ssh root@<host> 'whoami'        # must FAIL with "Permission denied"
ssh deploy@<host> 'whoami'      # must succeed
```

Then close your old root session. Optionally, on the droplet:

```bash
sudo truncate -s 0 /root/.ssh/authorized_keys
sudo passwd -l root
```

---

## What the scripts skip (and why)

- **The Docker install.** Use the standard Docker repo (`get.docker.com` or the manual repo setup). The bootstrap script assumes Docker is already installed.
- **DigitalOcean cloud firewall.** Configure via the DO web console — it sits *outside* the droplet, doesn't fight UFW + Docker iptables rules. Cleaner than trying to thread UFW through Docker's DOCKER-USER chain.
- **TLS certificates.** Caddy handles them automatically (Let's Encrypt) once the container is up and the domain points at the droplet.
- **Backups / snapshots.** Out of scope; use DigitalOcean snapshots or `borg` to a separate host.

---

## Re-running

`bootstrap-host.sh` is idempotent — re-run it any time to re-apply the configuration (e.g., after editing `unattended-upgrades-reboot` or rotating which keys are authorized). It rewrites the managed files in place.

`lockdown-sshd.sh` is also idempotent in effect (re-running it just rewrites the same drop-in), but you only really need to run it once per droplet.
