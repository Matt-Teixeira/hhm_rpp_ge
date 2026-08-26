#!/usr/bin/env bash
# Build for hhm_rpp_ge: deps + the SHARED image. Fleet paradigm
# (data_acquisition/docs/migration_CLAUDE.md Part 1). Unlike its siblings,
# THIS repo owns the shared hhm_rpp image (philips and siemens consume it and
# build nothing), so this script:
#
#   1. Creates ./utils/logger/logs as the CALLING user. The gosu entrypoint is
#      baked into the image and does NO log-dir repair, so if Docker creates
#      the missing bind source it is root-owned and the first run dies EACCES
#      inside createWriteStream — before any logging exists to say why.
#   2. npm install at the project root, inside a throwaway node:lts container
#      as the calling host user, so node_modules lands IN-TREE with ownership
#      matching the host (the shared node_mod_cache mount is retired — each
#      copy owns its deps).
#   3. Builds hhm_rpp:${IMAGE_TAG} via compose (docker/Dockerfile). Dev trees
#      set IMAGE_TAG=<username>; the release copy's .env says IMAGE_TAG=svc
#      (#RELEASE: override), so a release build produces hhm_rpp:svc.
#      build-release.sh additionally re-points the `staging` alias for
#      un-migrated philips — that retag deliberately lives THERE, not here:
#      a dev build must never move what philips runs.
set -euo pipefail
cd "$(dirname "$0")"

# Read one key from .env WITHOUT sourcing it (values may contain characters
# bash would expand; compose reads .env itself — we only need one key).
env_val() {
    grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- \
        | sed -e 's/[[:space:]]\+#.*$//' -e 's/[[:space:]]*$//' | tr -d "'\""
}

IMAGE_TAG="$(env_val IMAGE_TAG)"
: "${IMAGE_TAG:?IMAGE_TAG is not set — add it to .env (your username in a dev tree; svc in the release copy)}"

echo "==> ensure ./utils/logger/logs exists (owned by $(id -un), not created root by Docker)"
mkdir -p ./utils/logger/logs

echo "==> npm install (in-tree, as $(id -un))"
docker run --rm \
  -v "$(pwd)":/workspace -w /workspace \
  --user "$(id -u):$(id -g)" \
  -e NPM_CONFIG_CACHE=/tmp/.npm \
  node:lts npm install

echo "==> docker compose build app_tools  (hhm_rpp:${IMAGE_TAG})"
docker compose build app_tools

echo "==> done: deps in-tree; image hhm_rpp:${IMAGE_TAG} built"
