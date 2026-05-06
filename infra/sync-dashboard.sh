#!/usr/bin/env bash
# Regenerate the auto-provisioning dashboard from the canonical import-format
# dashboard. Run this whenever you edit infra/grafana-dashboard.json so the
# bundled Grafana picks up the same changes.
#
# Transforms:
#   - drop __inputs / __requires (only used at import time)
#   - replace ${DS_INFLUXDB} placeholder with the literal datasource uid
#     that infra/grafana/provisioning/datasources/influxdb.yml defines.
#
# Usage:
#   ./infra/sync-dashboard.sh
set -euo pipefail

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${INFRA_DIR}/.." && pwd)"
SOURCE="${INFRA_DIR}/grafana-dashboard.json"
TARGET="${INFRA_DIR}/grafana/dashboards/anvil.json"
HELM_TARGET="${PROJECT_ROOT}/deploy/helm/anvil/files/anvil.json"
DATASOURCE_UID="influxdb-k6"

if [[ ! -f "${SOURCE}" ]]; then
  echo "error: source dashboard not found: ${SOURCE}" >&2
  exit 1
fi

mkdir -p "$(dirname "${TARGET}")"

python3 - "${SOURCE}" "${TARGET}" "${DATASOURCE_UID}" <<'PY'
import json, sys

src, dst, ds_uid = sys.argv[1], sys.argv[2], sys.argv[3]
with open(src) as f:
    d = json.load(f)
d.pop("__inputs", None)
d.pop("__requires", None)
text = json.dumps(d, indent=2).replace("${DS_INFLUXDB}", ds_uid)
with open(dst, "w") as f:
    f.write(text + "\n")
PY

# Sanity-check the result
if grep -q "DS_INFLUXDB" "${TARGET}"; then
  echo "error: ${TARGET} still contains DS_INFLUXDB placeholder" >&2
  exit 1
fi

count=$(grep -c "${DATASOURCE_UID}" "${TARGET}")
lines=$(wc -l < "${TARGET}")
echo "wrote ${TARGET} (${lines} lines, ${count} datasource refs to '${DATASOURCE_UID}')"

# Mirror to the Helm chart so `helm install` ships the same dashboard.
if [[ -d "$(dirname "${HELM_TARGET}")" ]]; then
  cp "${TARGET}" "${HELM_TARGET}"
  echo "mirrored to ${HELM_TARGET}"
fi
