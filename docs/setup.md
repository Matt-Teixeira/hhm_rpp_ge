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