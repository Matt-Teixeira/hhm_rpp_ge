### 1. Clone Required Repositories
```bash
# GE RPP APP
git clone git@github.com:Matt-Teixeira/hhm_rpp_ge.git
# Switch to docker branch
git switch -c DEV_docker --track origin/DEV_docker

# Shared utilities repo
git clone git@github.com:AvanteHS-RTT/utils.git
# Switch to docker branch
git switch -c DEV_docker --track origin/DEV_docker


docker build -f docker/Dockerfile \
  --build-arg DOCKER_GID=$(getent group docker | cut -d: -f3) \
  --build-arg UID_0=$(id -u svc) \
  --build-arg UID_1=$(id -u jonathan-pope) \
  --build-arg UID_2=$(id -u matt-teixeira) \
  -t hhm_rpp:staging .

```

## Run a job

Use the runtime image through the `app` service:

```sh
docker compose run --rm app bash -lc "npm run ge_ct"
```

RUN ON FIRST DEPLOY TO NUKE AND UPDATE node_moduels CACHE: fresh install before running the job

```sh
docker compose run --rm app bash -lc "npm ci --omit=dev && npm run ge_ct"
```