#!/bin/sh
# Mounted into the renki-daemon container as /usr/local/bin/homelab.
#   homelab status [app] | logs <container> | top | deploy <app> | restart <app> | builder-prune | caddy-reload | backup-audit
exec ssh -q -i /gateway/renki_key -o IdentitiesOnly=yes -o BatchMode=yes \
  -o UserKnownHostsFile=/gateway/known_hosts -o ConnectTimeout=10 \
  homelab-gw@homelab-host "$@"
