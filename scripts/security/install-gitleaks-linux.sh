#!/usr/bin/env bash
# Install only the reviewed Linux x64 Gitleaks archive, after checking its bytes.
set -euo pipefail
if [ "$#" -ne 1 ] || [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ]; then
  echo 'Use one destination argument on Linux x86_64.' >&2
  exit 2
fi
destination=$1
if [ -e "$destination" ]; then
  echo 'The tool destination must be new.' >&2
  exit 2
fi
temporary=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/weidu-gitleaks.XXXXXX")
trap 'rm -rf "$temporary"' EXIT
archive="$temporary/gitleaks.tar.gz"
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2   --connect-timeout 15 --max-time 120   https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz   --output "$archive"
printf '%s  %s\n' 551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb "$archive" | sha256sum --check --status
# Extract only after the exact archive digest has passed.
tar -xzf "$archive" -C "$temporary" gitleaks
mkdir "$destination"
cp "$temporary/gitleaks" "$destination/gitleaks"
chmod 700 "$destination/gitleaks"
echo 'Verified Gitleaks 8.30.1 installed.'
