#!/usr/bin/env bash
# Builds and pushes VidForge app images to ECR, tagged with the current
# git commit SHA (plus :latest for convenience — task definitions always
# pin the SHA tag, never :latest).
#
# Usage:
#   infra/scripts/build-and-push.sh              # all 5 images
#   infra/scripts/build-and-push.sh api-gateway   # just one
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Uncommitted changes present — commit or stash before building." >&2
  echo "The SHA tag must mean exactly the commit it names." >&2
  exit 1
fi

SHA=$(git rev-parse HEAD)
REGION=$(aws configure get region || echo "ap-south-1")
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

declare -A DOCKERFILES=(
  [web]="apps/web/Dockerfile"
  [api-gateway]="apps/api-gateway/Dockerfile"
  [auth-svc]="apps/auth-svc/Dockerfile"
  [video-svc-api]="apps/video-svc/Dockerfile"
  [video-svc-worker]="apps/video-svc/Dockerfile"
)
declare -A TARGETS=(
  [video-svc-api]="api"
  [video-svc-worker]="worker"
)
declare -A BUILD_ARGS=(
  # Empty string, not omitted: makes fetch() calls same-origin relative
  # paths through the ALB, avoiding CORS entirely. The Dockerfile's ARG
  # default (http://localhost:4000) only applies when the flag is absent.
  [web]="--build-arg NEXT_PUBLIC_GATEWAY_URL="
)

APPS=(web api-gateway auth-svc video-svc-api video-svc-worker)
if [[ $# -gt 0 ]]; then
  APPS=("$1")
fi

echo "--- ecr login ---"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"

for app in "${APPS[@]}"; do
  dockerfile="${DOCKERFILES[$app]:-}"
  if [[ -z "$dockerfile" ]]; then
    echo "unknown app: $app" >&2
    exit 1
  fi
  repo="vidforge/${app}"
  target="${TARGETS[$app]:-}"
  target_flag=()
  [[ -n "$target" ]] && target_flag=(--target "$target")
  # shellcheck disable=SC2206
  extra_args=(${BUILD_ARGS[$app]:-})

  echo "--- building $app ---"
  # Fargate tasks run linux/amd64 (no runtime_platform override in the task
  # defs); pin the build target explicitly so it doesn't follow the host
  # architecture (arm64 on Apple Silicon), which produced unpullable images.
  docker build --platform linux/amd64 -f "$dockerfile" "${target_flag[@]}" "${extra_args[@]}" \
    -t "${REGISTRY}/${repo}:${SHA}" \
    -t "${REGISTRY}/${repo}:latest" \
    .

  echo "--- pushing $app ---"
  docker push "${REGISTRY}/${repo}:${SHA}"
  docker push "${REGISTRY}/${repo}:latest"
done

echo "--- done — image tag for this build: ${SHA} ---"
echo "Pass it to terraform apply as -var='web_image_tag=${SHA}' etc. (or all five)."
