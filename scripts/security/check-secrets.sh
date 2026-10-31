#!/usr/bin/env bash
# Accept a separately verified Gitleaks executable. Never print findings or raw logs.
set -euo pipefail
if [ "$#" -ne 1 ] || [ ! -x "$1" ]; then
  echo 'Provide the path to the verified Gitleaks 8.30.1 executable.' >&2
  exit 2
fi
scanner=$1
version=$("$scanner" version 2>/dev/null)
if [ "$version" != 8.30.1 ]; then
  echo 'The reviewed scanner version is required.' >&2
  exit 2
fi
if [ "$(git rev-parse --is-shallow-repository)" != false ]; then
  echo 'Fetch the complete repository history before scanning.' >&2
  exit 2
fi
temporary=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/weidu-secret-check.XXXXXX")
chmod 700 "$temporary"
trap 'rm -rf "$temporary"' EXIT
history_status=0
directory_status=0
env -u GITLEAKS_CONFIG -u GITLEAKS_CONFIG_TOML "$scanner" git --log-opts=--all --redact=100 --no-banner --exit-code=10 --max-archive-depth=2 --ignore-gitleaks-allow --timeout=120 --log-level=error . >"$temporary/history.log" 2>&1 || history_status=$?
env -u GITLEAKS_CONFIG -u GITLEAKS_CONFIG_TOML "$scanner" dir --redact=100 --no-banner --exit-code=10 --max-archive-depth=2 --ignore-gitleaks-allow --timeout=120 --log-level=error . >"$temporary/directory.log" 2>&1 || directory_status=$?
if { [ "$history_status" -ne 0 ] && [ "$history_status" -ne 10 ]; } || { [ "$directory_status" -ne 0 ] && [ "$directory_status" -ne 10 ]; }; then
  echo 'The secret check could not finish. Raw logs were withheld and removed.' >&2
  exit 2
fi
if [ "$history_status" -eq 10 ] || [ "$directory_status" -eq 10 ]; then
  echo 'Potential secrets were detected. Review privately; no findings or reports were published.' >&2
  exit 1
fi
echo 'Secret checks passed for fetched Git history and current directory. No reports retained.'
