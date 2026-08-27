#!/usr/bin/env bash
# Preflight for hhm_rpp_ge — validates the environment the NEXT run will
# actually use. Fleet paradigm (data_acquisition/docs/migration_CLAUDE.md);
# adapted from the pilot. A clean run reports ZERO warnings: treat a
# persistent warning as a bug in the check itself, or it trains people to
# ignore output.
#
# Exit codes: 0 = pass (or warnings only), 1 = critical errors found.
set -u
cd "$(dirname "$0")"

ERRORS=0; WARNINGS=0; OKS=0
ok()    { echo "  OK    $*"; OKS=$((OKS+1)); }
warn()  { echo "  WARN  $*"; WARNINGS=$((WARNINGS+1)); }
error() { echo "  ERROR $*"; ERRORS=$((ERRORS+1)); }
info()  { echo "        $*"; }
section(){ echo; echo "== $* =="; }

# Read KEY= from .env, stripping dotenv-style inline comments, quotes and
# trailing whitespace (a trailing "  # note" must never become part of a
# password). Never `source` the .env.
env_val() {
    grep "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- \
        | sed -e 's/[[:space:]]\+#.*$//' -e 's/[[:space:]]*$//' | tr -d "'\""
}

# ---------------------------------------------------------------- 1. host dirs
section "Host directories"
LOG_DIR="$(env_val LOG_DIR)"; LOG_DIR="${LOG_DIR:-./utils/logger/logs}"
if [ -d "$LOG_DIR" ] && [ -w "$LOG_DIR" ]; then
    ok "LOG_DIR $LOG_DIR writable ($(stat -c '%U:%G %a' "$LOG_DIR"))"
elif [ -d "$LOG_DIR" ]; then
    error "LOG_DIR $LOG_DIR exists but is not writable by $(id -un) ($(stat -c '%U:%G %a' "$LOG_DIR"))"
else
    # UNLIKE THE PILOT this cannot self-heal at run time: the gosu entrypoint
    # is baked into ge's shared image and does no log-dir repair, so a missing
    # bind source would be created root-owned by Docker and the run dies
    # EACCES. build.sh creates the dev dir; the release dir is host-prepped.
    case "$LOG_DIR" in
        /opt/run-logs/*) error "LOG_DIR $LOG_DIR does not exist — create it svc:docker 2775 before the first release run" ;;
        *) error "LOG_DIR $LOG_DIR does not exist — run: bash build.sh (the baked entrypoint cannot repair a root-owned bind source)" ;;
    esac
fi

DATA_STORE_DEV="$(env_val DATA_STORE_DEV)"
if [ -n "$DATA_STORE_DEV" ] && [ -d "$DATA_STORE_DEV" ]; then
    ok "DATA_STORE_DEV $DATA_STORE_DEV exists ($(find "$DATA_STORE_DEV" -maxdepth 1 -type d -name 'SME*' 2>/dev/null | wc -l) SME* dirs)"
else
    error "DATA_STORE_DEV missing or not a directory: '${DATA_STORE_DEV:-<unset>}'"
fi

PG_SSL_PATH="$(env_val PG_SSL_PATH)"
if [ -n "$PG_SSL_PATH" ] && [ -r "$PG_SSL_PATH" ]; then
    ok "PG_SSL_PATH readable: $PG_SSL_PATH"
else
    error "PG_SSL_PATH not readable: '${PG_SSL_PATH:-<unset>}'"
fi

# ------------------------------------------------------------------- 2. docker
section "Docker"
if docker ps >/dev/null 2>&1; then ok "docker daemon reachable"; else error "docker daemon not reachable as $(id -un)"; fi
if id -nG | grep -qw docker; then ok "$(id -un) is in the docker group"; else error "$(id -un) not in docker group"; fi
if docker compose version >/dev/null 2>&1; then ok "docker compose available"; else error "docker compose not available"; fi

# THIS repo OWNS the shared image (philips + siemens consume it as-is).
IMAGE_TAG="$(env_val IMAGE_TAG)"
if [ -z "$IMAGE_TAG" ]; then
    error ".env: IMAGE_TAG empty — compose cannot resolve hhm_rpp:\${IMAGE_TAG}"
elif docker image inspect "hhm_rpp:${IMAGE_TAG}" >/dev/null 2>&1; then
    ok "shared image hhm_rpp:${IMAGE_TAG} present (built by this repo)"
else
    error "image hhm_rpp:${IMAGE_TAG} missing — run: bash build.sh"
fi

# ----------------------------------------------------------------- 3. networks
section "Networks"
for net in pg_net redis-admin_redis_net; do
    if docker network inspect "$net" >/dev/null 2>&1; then ok "network $net exists"; else error "network $net missing"; fi
done

# --------------------------------------------------------------------- 4. .env
section ".env"
if [ ! -f .env ]; then
    error ".env missing — copy .env.example and fill it in"
else
    # DOCKER_GID/UID_* are REQUIRED here (unlike philips/siemens): this repo
    # builds the shared image and compose interpolates them as build args.
    REQUIRED="APP_NAME USER_ID LOGGER_MODE LOG_DIR IMAGE_TAG DATA_STORE_DEV PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PG_SSLMODE PG_SSL_PATH REDIS_HOST REDIS_PORT REDIS_PW DOCKER_GID UID_0 UID_1 UID_2"
    for key in $REQUIRED; do
        v="$(env_val "$key")"
        if [ -z "$v" ]; then
            error ".env: $key is empty or missing"
        else
            case "$key" in
                *PW*|*PASSWORD*|*TOKEN*|*KEY*|*SECRET*) ok ".env: $key set (masked)" ;;
                *) ok ".env: $key=$v" ;;
            esac
        fi
    done
    LOGGER_MODE="$(env_val LOGGER_MODE)"
    case "$LOGGER_MODE" in
        log|log_and_console) : ;;
        *) error ".env: LOGGER_MODE must be 'log' or 'log_and_console' (got '$LOGGER_MODE')" ;;
    esac
    for retired in LOGGER RUN_ENV RUN_USER DATA_STORE_STAGING TUNNEL_RESET_APP DEV_HHM_FILES STAGING_HHM_FILES PROD_HHM_FILES VNS3_IP VNS3_PW PG_HOST PG_PORT PG_DB PG_USER PG_PW; do
        grep -q "^$retired=" .env && warn ".env: retired key $retired still present — remove it (see .env.example)"
    done
fi

# ---------------------------------------------------------------- 5. app files
section "Application files"
for f in index.js package.json docker-compose.yaml build.sh build-release.sh CLAUDE.md docker/Dockerfile docker/entrypoint.sh .dockerignore; do
    if [ -f "$f" ]; then ok "$f present"; else error "$f missing"; fi
done
for d in utils/db utils/logger acquisition jobs parse persist processing read redis tooling; do
    if [ -d "$d" ]; then ok "$d/ present"; else error "$d/ missing"; fi
done
if [ -e utils/.git ]; then error "utils/.git exists — utils must be app-owned, not a nested repo"; else ok "utils/ is app-owned (no nested .git)"; fi

# --------------------------------------------------------------------- 6. deps
section "Dependencies"
if [ -d node_modules ] && [ -n "$(ls -A node_modules 2>/dev/null)" ]; then
    ok "root node_modules present ($(ls node_modules | wc -l) entries, $(stat -c '%U:%G' node_modules))"
else
    error "root node_modules missing or empty — run: bash build.sh"
fi
[ -d utils/node_modules ] && warn "utils/node_modules exists — it shadows the root install; remove it"

# ------------------------------------------------- 7. external services (AUTH)
section "External services (authenticated checks)"
REDIS_HOST="$(env_val REDIS_HOST)"; REDIS_PW="$(env_val REDIS_PW)"
if [ -z "$REDIS_HOST" ]; then
    error "REDIS_HOST empty — cannot check Redis"
elif ! docker ps --format '{{.Names}}' | grep -qx "$REDIS_HOST"; then
    error "Redis container '$REDIS_HOST' is not running"
else
    # Container presence proves nothing about auth. PING with the .env
    # credential; env var so the password never appears in process args here.
    PING_OUT=$(docker exec -e RPW="$REDIS_PW" "$REDIS_HOST" \
        sh -c 'redis-cli ${RPW:+-a "$RPW"} --no-auth-warning PING' 2>&1)
    if [ "$PING_OUT" = "PONG" ]; then
        ok "Redis auth OK (PING -> PONG)"
    elif echo "$PING_OUT" | grep -q "NOAUTH\|WRONGPASS\|invalid password"; then
        error "Redis rejected REDIS_PW from .env: $PING_OUT"
        info "Fix: sudo cat /opt/resources/secrets/redis_auth.conf and update REDIS_PW"
    else
        error "Redis PING failed: $PING_OUT"
    fi
fi

# The Postgres auth test MUST run from a sibling container on pg_net, never
# via `docker exec <pg_container> psql`: pg_hba trusts local and loopback, so
# an exec'd psql succeeds with a deliberately WRONG password. A rotated PG_PW
# once hid for three weeks behind exactly that. This mirrors how the app
# connects (utils/db/pg-pool.js): PG_SSLMODE from .env, CA from PG_SSL_PATH.
PGHOST_V="$(env_val PGHOST)"; PGPORT_V="$(env_val PGPORT)"; PGUSER_V="$(env_val PGUSER)"
PGPASSWORD_V="$(env_val PGPASSWORD)"; PGDATABASE_V="$(env_val PGDATABASE)"
PG_SSLMODE_V="$(env_val PG_SSLMODE)"; PG_SSLMODE_V="${PG_SSLMODE_V:-require}"
if [ -z "$PGPASSWORD_V" ]; then
    error "PGPASSWORD empty in .env — cannot verify PostgreSQL authentication"
elif [ ! -r "$PG_SSL_PATH" ]; then
    error "PG_SSL_PATH not readable — skipping PostgreSQL check"
elif ! docker image inspect postgres:16 >/dev/null 2>&1; then
    # An unverified check must never look like a passing one.
    warn "postgres:16 image absent — PostgreSQL auth NOT verified"
    info "Fix: docker pull postgres:16   (needed only for this check)"
else
    PG_OUT=$(docker run --rm --network pg_net \
        -e PGPASSWORD="$PGPASSWORD_V" -e PGSSLMODE="$PG_SSLMODE_V" -e PGSSLROOTCERT=/ssl.crt \
        -e PGCONNECT_TIMEOUT=10 \
        -v "$PG_SSL_PATH":/ssl.crt:ro postgres:16 \
        psql -h "$PGHOST_V" -p "$PGPORT_V" -U "$PGUSER_V" -d "$PGDATABASE_V" \
             -tAc "SELECT 'ok'" 2>&1)
    if [ "$(echo "$PG_OUT" | tail -1 | tr -d '[:space:]')" = "ok" ]; then
        ok "PostgreSQL auth OK (sibling-container SSL connection as $PGUSER_V)"
    elif echo "$PG_OUT" | grep -qi "password authentication failed\|no password supplied"; then
        error "PostgreSQL rejected PGPASSWORD from .env — likely a rotated credential"
        info "Fix: check /opt/resources/secrets/ with its owner; update BOTH copies' .env"
    elif echo "$PG_OUT" | grep -qi "certificate\|SSL"; then
        error "PostgreSQL SSL failure: $(echo "$PG_OUT" | head -2)"
    else
        error "PostgreSQL check failed: $(echo "$PG_OUT" | head -2)"
    fi
fi

# ----------------------------------------------- release currency (fleet-wide)
# FLEET-FINDINGS §4.1: two sessions shipped a release believing it contained
# work that existed only in the dev tree. Currency is a continuous property —
# check it on every preflight, from either copy.
section "Release currency"
if [ -d .git ]; then
    REL_DIR="/opt/apps/$(basename "$(pwd)")"
    REL_SHA="$(grep '^RELEASE_SHA=' "$REL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "'\"[:space:]")"
    HEAD_SHA="$(git rev-parse HEAD 2>/dev/null)"
    if [ -z "$HEAD_SHA" ]; then
        warn "cannot read git HEAD here — release currency not checked"
    elif [ -z "$REL_SHA" ]; then
        warn "no RELEASE_SHA at $REL_DIR/.env — release copy missing or never released"
    elif [ "$(git rev-parse --quiet --verify "$REL_SHA^{commit}" 2>/dev/null)" = "$HEAD_SHA" ]; then
        ok "release copy is current (RELEASE_SHA=$REL_SHA = HEAD)"
        [ -n "$(git status --porcelain 2>/dev/null)" ] && info "note: this tree has uncommitted changes — they are in NO release"
    else
        BEHIND="$(git rev-list --count "$REL_SHA..HEAD" 2>/dev/null)"
        if [ -n "$BEHIND" ] && [ "$BEHIND" -gt 0 ] 2>/dev/null; then
            warn "release copy is $BEHIND commit(s) behind HEAD (RELEASE_SHA=$REL_SHA) — /opt/apps runs OLD code until build-release.sh"
        else
            warn "deployed RELEASE_SHA=$REL_SHA is not an ancestor of HEAD (rebase? branch switch?) — verify what /opt/apps is running"
        fi
    fi
else
    REL_SHA="$(env_val RELEASE_SHA)"
    if [ -n "$REL_SHA" ]; then
        ok "release copy stamped RELEASE_SHA=$REL_SHA"
    else
        error "no RELEASE_SHA in this .env — this copy was not produced by build-release.sh"
    fi
fi

# ------------------------------------------------------------------ 8. summary
section "Summary"
echo "  $OKS ok, $WARNINGS warnings, $ERRORS errors"
if [ "$ERRORS" -gt 0 ]; then
    echo "  RESULT: FAIL"
    exit 1
fi
[ "$WARNINGS" -gt 0 ] && echo "  RESULT: PASS (with warnings — a clean run should report zero)"
[ "$WARNINGS" -eq 0 ] && echo "  RESULT: PASS"
exit 0
