#!/usr/bin/env bash
# Bootstraps Prometheus + Grafana on the public EC2 (Jenkins host).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MONITORING_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${MONITORING_DIR}"

echo "==> Installing host exporters on public EC2..."
bash "${SCRIPT_DIR}/install-exporters.sh"

echo "==> Starting Prometheus + Grafana stack..."
docker compose pull
docker compose up -d

echo "==> Waiting for monitoring services..."
for i in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:9090/-/ready >/dev/null 2>&1 && curl -fsS http://127.0.0.1:3001/api/health >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

echo "==> Prometheus targets:"
curl -fsS http://127.0.0.1:9090/api/v1/targets | python3 - <<'PY' || true
import json, sys
data = json.load(sys.stdin)
for target in data.get("data", {}).get("activeTargets", []):
    health = target.get("health")
    labels = target.get("labels", {})
    print(f"  - {labels.get('job')} ({labels.get('instance', 'n/a')}): {health}")
PY

echo "==> Monitoring stack is up."
echo "    Prometheus: http://127.0.0.1:9090"
echo "    Grafana:    http://127.0.0.1:3001  (or via nginx /grafana/)"
