#!/usr/bin/env bash
# Installs node_exporter and cAdvisor as Docker containers on any EC2 host.
set -euo pipefail

NODE_EXPORTER_IMAGE="prom/node-exporter:v1.8.2"
CADVISOR_IMAGE="gcr.io/cadvisor/cadvisor:v0.49.1"

ensure_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    return 0
  fi

  if ! command -v apt-get >/dev/null 2>&1; then
    echo "Docker is not installed and this script only automates Debian/Ubuntu installs." >&2
    exit 1
  fi

  echo "==> Installing Docker Engine and Compose plugin..."
  export DEBIAN_FRONTEND=noninteractive
  if [ "$(id -u)" -ne 0 ]; then
    SUDO="sudo"
  else
    SUDO=""
  fi

  ${SUDO} apt-get update
  ${SUDO} apt-get install -y ca-certificates curl gnupg lsb-release
  ${SUDO} install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | ${SUDO} gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | ${SUDO} tee /etc/apt/sources.list.d/docker.list > /dev/null
  ${SUDO} apt-get update
  ${SUDO} apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  ${SUDO} systemctl enable --now docker

  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker installation did not complete successfully." >&2
    exit 1
  fi
}

ensure_docker

docker rm -f node_exporter 2>/dev/null || true
docker run -d \
  --name node_exporter \
  --restart unless-stopped \
  --net host \
  --pid host \
  -v /:/host:ro,rslave \
  "${NODE_EXPORTER_IMAGE}" \
  --path.rootfs=/host \
  --collector.filesystem.mount-points-exclude='^/(sys|proc|dev|host|etc|run/docker/netns|var/lib/docker/.+)($$|/)'

echo "==> Deploying cAdvisor..."
docker rm -f cadvisor 2>/dev/null || true
docker run -d \
  --name cadvisor \
  --restart unless-stopped \
  --privileged \
  -p 8088:8080 \
  -v /:/rootfs:ro \
  -v /var/run:/var/run:ro \
  -v /sys:/sys:ro \
  -v /var/lib/docker/:/var/lib/docker:ro \
  -v /dev/disk/:/dev/disk:ro \
  "${CADVISOR_IMAGE}"

echo "==> Exporter health checks..."
sleep 3
curl -fsS http://127.0.0.1:9100/metrics >/dev/null
curl -fsS http://127.0.0.1:8088/metrics >/dev/null

echo "==> Exporters are running:"
docker ps --filter name=node_exporter --filter name=cadvisor --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
