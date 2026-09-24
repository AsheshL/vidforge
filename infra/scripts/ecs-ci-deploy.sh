#!/usr/bin/env bash
# CI deploy entrypoint (docs/backlog.md's "Pending — CI/CD" spec): runs the
# migration, then deploys all 5 services, tagged with the current commit
# SHA. Deliberately doesn't touch Terraform or its state — see
# ecs-register-revision.sh's header for why — so this needs three things
# passed in as env vars that Terraform would otherwise supply: CLUSTER,
# PRIVATE_SUBNETS (comma-separated), APP_SECURITY_GROUP.
#
# Each service has deployment_circuit_breaker{enable=true, rollback=true}
# (infra/terraform/ecs-*.tf), so a service that fails to reach steady
# state auto-rolls-back to its previous revision — `aws ecs wait
# services-stable` alone would still report success in that case (the
# *rolled-back* deployment reaches steady state), so this script also
# diffs each service's live task-definition ARN against the one it just
# registered and fails loudly on a mismatch instead of reporting green on
# a silent rollback.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

: "${CLUSTER:=vidforge-prod}"
: "${PRIVATE_SUBNETS:?PRIVATE_SUBNETS (comma-separated subnet ids) is required}"
: "${APP_SECURITY_GROUP:?APP_SECURITY_GROUP (security group id) is required}"

SHA=$(git rev-parse HEAD)
REGION=$(aws configure get region || echo "ap-south-1")
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

echo "--- running migration ---"
MIGRATE_ARN=$(infra/scripts/ecs-register-revision.sh "${CLUSTER}-migrate" migrate "${REGISTRY}/vidforge/api-gateway:${SHA}")
TASK_ARN=$(aws ecs run-task \
  --cluster "$CLUSTER" \
  --task-definition "$MIGRATE_ARN" \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$PRIVATE_SUBNETS],securityGroups=[$APP_SECURITY_GROUP],assignPublicIp=DISABLED}" \
  --query 'tasks[0].taskArn' --output text)
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN"
MIGRATE_EXIT=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" --query 'tasks[0].containers[0].exitCode' --output text)
if [[ "$MIGRATE_EXIT" != "0" ]]; then
  echo "migration failed: exit code $MIGRATE_EXIT — check CloudWatch Logs group /ecs/${CLUSTER}/migrate" >&2
  exit 1
fi
echo "--- migration succeeded ---"

declare -A SERVICES=(
  ["${CLUSTER}-web"]="web|${REGISTRY}/vidforge/web:${SHA}"
  ["${CLUSTER}-api-gateway"]="api-gateway|${REGISTRY}/vidforge/api-gateway:${SHA}"
  ["${CLUSTER}-auth-svc"]="auth-svc|${REGISTRY}/vidforge/auth-svc:${SHA}"
  ["${CLUSTER}-video-svc-api"]="video-svc-api|${REGISTRY}/vidforge/video-svc-api:${SHA}"
  ["${CLUSTER}-transcode-worker"]="transcode-worker|${REGISTRY}/vidforge/video-svc-worker:${SHA}"
)

declare -A EXPECTED_ARN
for SERVICE in "${!SERVICES[@]}"; do
  IFS="|" read -r CONTAINER IMAGE <<<"${SERVICES[$SERVICE]}"
  FAMILY="$SERVICE"
  echo "--- deploying $SERVICE ($CONTAINER -> $IMAGE) ---"
  ARN=$(infra/scripts/ecs-register-revision.sh "$FAMILY" "$CONTAINER" "$IMAGE")
  EXPECTED_ARN["$SERVICE"]="$ARN"
  aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --task-definition "$ARN" >/dev/null
done

echo "--- waiting for all services to reach steady state ---"
aws ecs wait services-stable --cluster "$CLUSTER" --services "${!SERVICES[@]}"

echo "--- verifying no service rolled back ---"
FAILED=0
for SERVICE in "${!SERVICES[@]}"; do
  LIVE_ARN=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --query 'services[0].taskDefinition' --output text)
  if [[ "$LIVE_ARN" != "${EXPECTED_ARN[$SERVICE]}" ]]; then
    echo "$SERVICE: circuit breaker rolled back — live revision is $LIVE_ARN, expected ${EXPECTED_ARN[$SERVICE]}" >&2
    FAILED=1
  fi
done

if [[ "$FAILED" != "0" ]]; then
  echo "--- deploy failed: one or more services rolled back ---" >&2
  exit 1
fi

echo "--- deploy succeeded: all services on ${SHA} ---"
