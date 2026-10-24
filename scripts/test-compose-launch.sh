#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project_name="accesshold-compose-launch-test"
compose=(docker compose --project-name "$project_name" --file "$repo_root/docker-compose.yml")

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker CLI is required to run the Compose launch test." >&2
  exit 127
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 is required to run the launch test." >&2
  exit 127
fi

cleanup() {
  "${compose[@]}" down --volumes --remove-orphans || true
}
trap cleanup EXIT

"${compose[@]}" up --build --detach --wait --wait-timeout 180

node --input-type=module <<'NODE'
const checks = [
  ["API", "http://127.0.0.1:3000/health", "TEST PROVIDER"],
  ["dashboard", "http://127.0.0.1:5173/accesshold/", "AccessHold"],
];
for (const [name, url, expected] of checks) {
  const response = await fetch(url);
  const body = await response.text();
  if (!response.ok || !body.includes(expected)) {
    throw new Error(`${name}_launch_check_failed:${response.status}`);
  }
  console.info(`${name}: ${response.status}`);
}
NODE

schema_table="$("${compose[@]}" exec -T postgres psql -U accesshold -d accesshold -Atc 'SELECT to_regclass('\''public.accesshold_contract_versions'\'')')"
if [[ "$schema_table" != "accesshold_contract_versions" ]]; then
  echo "PostgreSQL migration did not create accesshold_contract_versions." >&2
  exit 1
fi
printf 'PostgreSQL migration: %s\n' "$schema_table"
