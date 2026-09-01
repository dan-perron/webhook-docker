#!/bin/bash
#
# Standalone build + (re)start of the meeting-scheduler container on `signs`.
#
# NOTE: the recommended path is to run this as a service in the webhook-docker
# compose stack (see README "Deploy"), which puts it on the same network as the
# `mongodb` container automatically. This script is the standalone alternative:
# it attaches the container to that existing compose network so it can reach
# mongo by hostname.
#
# Env:
#   MONGO_USERNAME / MONGO_PASSWORD  mongo root creds (same as webhook-docker .env)
#   MONGODB_CONNSTRING               optional; overrides the derived connstring
#   MONGODB_DATABASE                 database name (default: scheduler)
#   DOCKER_NETWORK                   compose network (default: webhook-docker_default)
#   BASE_PATH                        sub-path served behind Apache (default: /meet)
#
set -e

IMAGE="dan-perron/meeting-scheduler"
NAME="meeting-scheduler"
PORT=3002
NETWORK="${DOCKER_NETWORK:-webhook-docker_default}"
BASE_PATH="${BASE_PATH:-/meet}"

# Reach mongo on the compose network as hostname `mongodb`, same as webhook-server.
CONNSTRING="${MONGODB_CONNSTRING:-mongodb://${MONGO_USERNAME}:${MONGO_PASSWORD}@mongodb/?authSource=admin}"

docker build -t "$IMAGE" .
docker stop "$NAME" || true
docker rm "$NAME" || true
docker run \
  --name "$NAME" \
  --network "$NETWORK" \
  --restart unless-stopped \
  -p "$PORT:$PORT" \
  -e "MONGODB_CONNSTRING=$CONNSTRING" \
  -e "MONGODB_DATABASE=${MONGODB_DATABASE:-scheduler}" \
  -e "BASE_PATH=$BASE_PATH" \
  -d "$IMAGE"

sleep 3
echo "Deployed. Health check:"
curl -fsS "http://localhost:$PORT$BASE_PATH/healthz" && echo
