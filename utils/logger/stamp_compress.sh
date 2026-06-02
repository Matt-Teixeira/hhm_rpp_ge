#!/bin/bash

set -e  # EXIT IMMEDIATELY IF ANY COMMAND EXITS WITH A NON-ZERO STATUS
set -u  # TREAT UNSET VARIABLES AS AN ERROR WHEN SUBSTITUTING

# CLI ARGS
app_name="$1"
run_env="$2"

# COMMON PATH USED IN MANY PLACES -> EX. /home/staging/mmb-rpp/utils/logger
base_path="/home/$run_env/$app_name/utils/logger"

# GET CURRENT DATE, YYYY-MM-DD
# date=$(date +%F)
date=$(date -d "1 day ago" +%F)

# CREATE DIR
mkdir "$base_path/$date"

# COPY LOGFILES INTO DIR
cp "$base_path/${app_name}-log.${run_env}."* "$base_path/$date"

# COMPRESS DIR
gzip -r "$base_path/$date"

# REMOVE ORIGINAL FILES
rm "$base_path/${app_name}-log.${run_env}."*