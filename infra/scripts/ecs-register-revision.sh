#!/usr/bin/env bash
# Registers a new ECS task-definition revision that's identical to the
# current one except for a single container's image, and prints the new
# revision's ARN. Reads the current definition via `aws ecs
# describe-task-definition` rather than Terraform, deliberately — this
# repo's Terraform state is local-only (docs/backlog.md's "Terraform
# remote state" item), so CI has no way to read or apply it. The
# corresponding aws_ecs_service resources have
# lifecycle.ignore_changes = [task_definition] so a later `terraform
# apply` from a workstation doesn't roll a revision registered here back
# to an older image tag.
#
# Usage: ecs-register-revision.sh <family> <container-name> <new-image-uri>
# Prints the new task definition ARN on stdout; all other output goes to
# stderr, so `ARN=$(ecs-register-revision.sh ...)` is safe to use as-is.
set -euo pipefail

FAMILY=$1
CONTAINER=$2
IMAGE=$3

CURRENT=$(aws ecs describe-task-definition --task-definition "$FAMILY" --query 'taskDefinition')

NEW_DEF=$(echo "$CURRENT" | jq --arg container "$CONTAINER" --arg image "$IMAGE" '
  .containerDefinitions = (.containerDefinitions | map(if .name == $container then .image = $image else . end)) |
  {family, taskRoleArn, executionRoleArn, networkMode, containerDefinitions, requiresCompatibilities, cpu, memory}
  | with_entries(select(.value != null))
')

aws ecs register-task-definition --cli-input-json "$NEW_DEF" --query 'taskDefinition.taskDefinitionArn' --output text
