#!/usr/bin/env bash
# Runs the one-off DB migration task on ECS and waits for it to finish.
# Run this before every deploy that includes a new migration.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)/infra/terraform"

CLUSTER=$(terraform output -raw ecs_cluster_name)
SUBNETS=$(terraform output -json private_subnet_ids | jq -r 'join(",")')
SG=$(terraform output -raw app_security_group_id)
TASK_DEF=$(terraform output -raw migration_task_definition_arn)

echo "--- starting migration task ---"
TASK_ARN=$(aws ecs run-task \
  --cluster "$CLUSTER" \
  --task-definition "$TASK_DEF" \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SG],assignPublicIp=DISABLED}" \
  --query 'tasks[0].taskArn' --output text)

echo "task: $TASK_ARN"
echo "--- waiting for it to stop ---"
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN"

EXIT_CODE=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
  --query 'tasks[0].containers[0].exitCode' --output text)

if [[ "$EXIT_CODE" != "0" ]]; then
  echo "migration failed: exit code $EXIT_CODE — check CloudWatch Logs group /ecs/${CLUSTER}/migrate" >&2
  exit 1
fi
echo "--- migration succeeded ---"
