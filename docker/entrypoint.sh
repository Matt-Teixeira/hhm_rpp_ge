#!/bin/bash
set -e

# Default to svc if RUN_USER not specified
RUN_USER="${RUN_USER:-svc}"

# Dynamically set HOME based on user
export HOME="/home/$RUN_USER"

# Execute command as the specified user
exec gosu "$RUN_USER" "$@"
