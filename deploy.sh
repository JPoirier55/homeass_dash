#!/usr/bin/env bash
# Deploy to a Podman host as a rootless Quadlet service.
#   ./deploy.sh user@host [ha_url]
# ha_url is only used the first time, to create the server's .env from the local one
# (containers often can't resolve homeassistant.local, so pass an IP).
set -euo pipefail

TARGET="${1:?usage: ./deploy.sh user@host [ha_url]}"
HA_URL_REMOTE="${2:-}"
DIR=homeass-dash
cd "$(dirname "$0")"

echo "→ Copying app to $TARGET:~/$DIR"
COPYFILE_DISABLE=1 tar czf - --exclude .git --exclude .env --exclude config.json \
  package.json server.js public deploy Dockerfile \
  | ssh "$TARGET" "mkdir -p ~/$DIR && tar xzf - -C ~/$DIR"

if [[ -f config.json ]]; then
  echo "→ Copying config.json"
  ssh "$TARGET" "cat > ~/$DIR/config.json" < config.json
else
  ssh "$TARGET" "test -f ~/$DIR/config.json || echo '{}' > ~/$DIR/config.json"
fi

if ! ssh "$TARGET" "test -f ~/$DIR/.env"; then
  echo "→ Creating server .env from local .env"
  [[ -f .env ]] || { echo "No local .env to copy" >&2; exit 1; }
  grep -vE '^(HOST|PORT)=' .env \
    | { if [[ -n "$HA_URL_REMOTE" ]]; then sed "s|^HA_URL=.*|HA_URL=$HA_URL_REMOTE|"; else cat; fi; } \
    | ssh "$TARGET" "umask 077 && cat > ~/$DIR/.env"
fi

echo "→ Building image and (re)starting service"
ssh "$TARGET" bash -s <<EOF
set -euo pipefail
cd ~/$DIR
podman build --format docker -t localhost/homeass-dash:latest .
mkdir -p ~/.config/containers/systemd
cp deploy/homeass-dash.container ~/.config/containers/systemd/
systemctl --user daemon-reload
systemctl --user restart homeass-dash.service
loginctl enable-linger "\$USER" || echo "WARN: could not enable linger; run 'sudo loginctl enable-linger \$USER' so it starts at boot"
sleep 3
systemctl --user --no-pager --lines=5 status homeass-dash.service
EOF

echo "✓ Deployed: http://${TARGET#*@}:8080"
