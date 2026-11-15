#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter @workspace/db run migrate --adopt-existing
if [ "${DEMO_MODE:-false}" = "true" ]; then
  pnpm --filter @workspace/api-server run accounts:setup:demo --if-needed
  pnpm --filter @workspace/api-server run demo:base
fi
