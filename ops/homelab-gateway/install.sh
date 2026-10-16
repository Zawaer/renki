#!/usr/bin/env bash
# Installs the homelab gateway on the host. Run on the homelab: sudo ./install.sh
# Idempotent. Never overwrites an existing policy.json (writes policy.json.new instead).
set -euo pipefail
[ "$(id -u)" = 0 ] || exec sudo "$0" "$@"

OPS_USER="${OPS_USER:-zawaer}"        # the user the gateway acts as (owns the apps, in the docker group)
GW_USER="homelab-gw"                  # the account the SSH key logs in as; can run nothing but the gateway
HERE="$(cd "$(dirname "$0")" && pwd)"
OPS_HOME="$(getent passwd "$OPS_USER" | cut -d: -f6)"
KEYDIR="$OPS_HOME/.homelab-gateway"

id "$GW_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir "/var/lib/$GW_USER" --shell /bin/sh "$GW_USER"
usermod -p '*' "$GW_USER"             # no password, but allowed to log in with a key
gpasswd -d "$GW_USER" docker >/dev/null 2>&1 || true

install -d -m 755 -o root -g root /etc/homelab-gateway
install -m 755 -o root -g root "$HERE/gateway.py" /usr/local/sbin/homelab-gateway
if [ -e /etc/homelab-gateway/policy.json ] && [ -z "${REPLACE_POLICY:-}" ]; then
  install -m 644 -o root -g root "$HERE/policy.json" /etc/homelab-gateway/policy.json.new
  echo "policy.json exists; wrote policy.json.new next to it. Review it, or re-run with REPLACE_POLICY=1 to take the repo's version."
else
  install -m 644 -o root -g root "$HERE/policy.json" /etc/homelab-gateway/policy.json
fi

install -d -m 700 -o "$OPS_USER" /var/lib/homelab-gateway /var/lib/homelab-gateway/approvals
install -m 644 "$HERE/homelab-gateway-approvals.service" /etc/systemd/system/homelab-gateway-approvals.service
systemctl daemon-reload
systemctl enable --now homelab-gateway-approvals.service
systemctl restart homelab-gateway-approvals.service

# The approval service listens on the Docker network's bridge address, so the phone (via Caddy)
# can reach it. Open exactly that port, from that network only.
NET="${APPROVAL_NET:-homelab_net}"
if command -v ufw >/dev/null && ufw status | grep -q "Status: active" && docker network inspect "$NET" >/dev/null 2>&1; then
  BR="br-$(docker network inspect "$NET" --format '{{.Id}}' | cut -c1-12)"
  GWIP="$(docker network inspect "$NET" --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}')"
  SUBNET="$(docker network inspect "$NET" --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}')"
  ufw allow in on "$BR" from "$SUBNET" to "$GWIP" port 4530 proto tcp comment 'homelab gateway approvals'
fi

touch /var/log/homelab-gateway.log
chown "$OPS_USER" /var/log/homelab-gateway.log; chmod 640 /var/log/homelab-gateway.log
install -d -m 750 -o "$OPS_USER" /var/log/homelab-gateway-jobs

cat > /etc/sudoers.d/homelab-gateway <<SUDO
Defaults:$GW_USER env_keep += "SSH_ORIGINAL_COMMAND SSH_CONNECTION"
$GW_USER ALL=($OPS_USER) NOPASSWD: /usr/local/sbin/homelab-gateway
SUDO
chmod 440 /etc/sudoers.d/homelab-gateway
visudo -cf /etc/sudoers.d/homelab-gateway >/dev/null

# Key pair for the Renki container. The private half goes into the container; the
# public half is only allowed to run the gateway (restrict = no shell, pty, forwarding).
install -d -m 700 -o "$OPS_USER" "$KEYDIR"
[ -e "$KEYDIR/renki_key" ] || sudo -u "$OPS_USER" ssh-keygen -q -t ed25519 -N "" -C "renki-container" -f "$KEYDIR/renki_key"
ssh-keyscan -t ed25519 localhost 2>/dev/null | sed 's/^localhost/homelab-host/' > "$KEYDIR/known_hosts"
chown "$OPS_USER" "$KEYDIR/known_hosts"; chmod 644 "$KEYDIR/known_hosts"

install -d -m 700 -o "$GW_USER" -g "$GW_USER" "/var/lib/$GW_USER/.ssh"
printf 'restrict,command="sudo -n -u %s /usr/local/sbin/homelab-gateway" %s\n' "$OPS_USER" "$(cat "$KEYDIR/renki_key.pub")" \
  > "/var/lib/$GW_USER/.ssh/authorized_keys"
chown "$GW_USER:$GW_USER" "/var/lib/$GW_USER/.ssh/authorized_keys"; chmod 600 "/var/lib/$GW_USER/.ssh/authorized_keys"

cat <<DONE

Installed.
  kill switch on :  sudo touch /etc/homelab-gateway/DISABLED
  kill switch off:  sudo rm /etc/homelab-gateway/DISABLED
  audit log      :  /var/log/homelab-gateway.log
  container key  :  $KEYDIR/renki_key  (mount read-only into renki-daemon)
Test from this host:  ssh -i $KEYDIR/renki_key -o UserKnownHostsFile=$KEYDIR/known_hosts $GW_USER@localhost status
DONE
