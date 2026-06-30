FROM node:lts

# Build-time arguments
ARG DOCKER_GID
ARG UID_0
ARG UID_1
ARG UID_2

SHELL ["/bin/bash", "-c"]

# Tooling
# Reduced vs data_acquisition: this app only reads/parses ACQ files that are
# already on a (read-only) bind mount and talks to Postgres/Redis. It never
# does its own SFTP/rsync acquisition, so lftp/rsync/sshpass/mdbtools/expect
# are dropped. Only ca-certificates (TLS to PG/Redis) and gosu (entrypoint
# user-drop) are needed.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      gosu \
 && rm -rf /var/lib/apt/lists/*

# Create docker group
RUN groupadd -g ${DOCKER_GID} docker

# Create users
RUN useradd -u ${UID_0} -g docker -m -d /home/svc -s /bin/bash svc
RUN useradd -u ${UID_1} -g docker -m -d /home/jonathan-pope -s /bin/bash jonathan-pope
RUN useradd -u ${UID_2} -g docker -m -d /home/matt-teixeira -s /bin/bash matt-teixeira

# ----------------------------------------------------------
# TO ADD ANOTHER USER:
# 1) Add ARG UID_X at the top
# 2) Add: RUN useradd -u ${UID_X} -g docker -m -d /home/newuser -s /bin/bash newuser
# 3) Pass --build-arg UID_X=$(id -u newuser) in build command
# ----------------------------------------------------------

# Cooperative umask for all shells
RUN printf 'umask ${UMASK:-0002}\n' > /etc/profile.d/umask.sh \
  && chmod 644 /etc/profile.d/umask.sh \
  && printf '\n# cooperative umask for all users\numask ${UMASK:-0002}\n' >> /etc/bash.bashrc

ENV BASH_ENV=/etc/profile.d/umask.sh

# Baked-in entrypoint (gosu-drop to RUN_USER); no host-mounted /opt/resources needed.
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bash"]
