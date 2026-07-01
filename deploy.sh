#!/usr/bin/env bash
# Deploy loop-marketing to Vercel production.
# Always runs from THIS script's directory, so it never depends on the
# caller's cwd (a stray cwd once made `vercel deploy` try to upload ~/Desktop).
set -euo pipefail

cd "$(dirname "$0")"

# Safety check: refuse to deploy unless we're in the linked project dir.
if [ ! -f .vercel/project.json ] || ! grep -q '"projectName":"loop-marketing"' .vercel/project.json; then
  echo "ERROR: $(pwd) is not the linked loop-marketing project. Aborting." >&2
  exit 1
fi

echo "Deploying from: $(pwd)"

# Keep local-only junk out of CLI uploads.
printf '.claude\n.DS_Store\n.git\n' > .vercelignore
trap 'rm -f .vercelignore' EXIT

vercel deploy --prod --yes --scope impact-loop1
