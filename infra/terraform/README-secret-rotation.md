# Rotating JWT_SECRET / CONTEXT_SIGNING_SECRET

`JWT_SECRET` and `CONTEXT_SIGNING_SECRET` are generated once by Terraform
(`secrets.tf`) into Secrets Manager. Neither can simply be replaced in
place: a new value doesn't reach every ECS task at the same instant, so any
service still running the old task definition would immediately start
rejecting session tokens / `RequestContext` signatures produced by services
that already redeployed (or vice versa).

Both secrets support a rollout-safe rotation instead. Each has a matching
`*-previous` secret in Secrets Manager (`aws_secretsmanager_secret.jwt_secret_previous`,
`aws_secretsmanager_secret.context_signing_secret_previous`), wired into the
same ECS task definitions as `JWT_SECRET_PREVIOUS` /
`CONTEXT_SIGNING_SECRET_PREVIOUS`. The verifiers
(`packages/svc-auth/src/index.ts`'s `verifyContext`,
`apps/auth-svc/src/jwt.ts`'s `verifyJwt`) try the current secret first and
fall back to the previous one if set; signing (`signContext`, `signToken`)
always uses only the current secret. The `*-previous` secrets start as an
empty string, which the verifiers treat as "no previous secret configured."

Terraform does not generate or manage the actual previous/current values
during a rotation — that's a manual, out-of-band procedure (the
`*_secret_previous` secret versions have `ignore_changes = [secret_string]`
specifically so a routine `terraform apply` doesn't stomp on whatever value
a human puts there).

## Rotation procedure

Repeat this once per secret (`jwt-secret` or `context-signing-secret`); the
example below is for `context-signing-secret` — substitute the other name
and its corresponding env vars to rotate `jwt-secret` instead.

1. **Copy the current value into the `-previous` slot.**

   ```sh
   PREFIX=<name_prefix>   # e.g. vidforge-prod, matches local.name_prefix
   CURRENT=$(aws secretsmanager get-secret-value \
     --secret-id "${PREFIX}/context-signing-secret" \
     --query SecretString --output text)
   aws secretsmanager put-secret-value \
     --secret-id "${PREFIX}/context-signing-secret-previous" \
     --secret-string "$CURRENT"
   ```

2. **Generate and set a new current value.**

   ```sh
   NEW=$(openssl rand -base64 36)
   aws secretsmanager put-secret-value \
     --secret-id "${PREFIX}/context-signing-secret" \
     --secret-string "$NEW"
   ```

   (Alternatively, `terraform apply -replace=random_password.context_signing_secret`
   to let Terraform generate and write the new value, then re-run the
   `get-secret-value` step above first if you want the exact prior value
   captured before it's replaced.)

3. **Redeploy every service that consumes the secret** so all tasks pick up
   the new current value and start accepting both old and new signatures:
   - `context-signing-secret`: auth-svc, api-gateway, video-svc-api,
     transcode-worker.
   - `jwt-secret`: auth-svc only.

   Use the existing ECS deploy path (`infra/scripts/ecs-register-revision.sh`
   / `ecs-ci-deploy.sh`) to force a new task definition revision and roll it
   out — the ECS `secrets` block re-resolves the ARN's current value on
   every new task launch, so this step is required even though the secret's
   ARN itself hasn't changed.

4. **After the rollout window has fully elapsed**, clear the `-previous`
   slot so it stops being a valid fallback:

   ```sh
   aws secretsmanager put-secret-value \
     --secret-id "${PREFIX}/context-signing-secret-previous" \
     --secret-string ""
   ```

   The rollout window is bounded by how long a signature/token produced
   before step 2 can still be presented for verification:
   - `RequestContext` signatures expire after 5 minutes
     (`MAX_AGE_MS` in `packages/svc-auth/src/index.ts`), so it's safe to
     clear `context-signing-secret-previous` shortly after step 3 finishes
     rolling out everywhere.
   - Session tokens (`JWT_SECRET`) live for up to 8 hours
     (`TOKEN_TTL_HOURS` in `apps/auth-svc/src/jwt.ts`), so
     `jwt-secret-previous` should stay populated for at least that long
     after rotating, or users holding old tokens will be logged out early.
