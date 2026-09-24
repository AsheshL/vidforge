#!/usr/bin/env bash
# Creates (or reuses) a narrowly-scoped IAM user for SES sending, mints an
# access key, converts it to an SMTP password via AWS's documented SigV4
# derivation, and writes the resulting SMTP_URL straight into Secrets
# Manager. Deliberately NOT a Terraform resource: an IAM access key is a
# long-lived credential, and this repo has no remote state backend yet
# (docs/backlog.md), so it never touches local tfstate.
#
# Safe to re-run: an existing access key on the IAM user is deleted first,
# so this always ends with exactly one live key and one matching secret.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)/infra/terraform"

REGION=$(terraform output -raw 2>/dev/null aws_region || aws configure get region || echo "ap-south-1")
IAM_USER="vidforge-prod-ses-smtp"
SECRET_ARN=$(terraform output -raw smtp_url_secret_arn)
DOMAIN=$(terraform output -raw app_url | sed 's#https://##')
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
IDENTITY_ARN="arn:aws:ses:${REGION}:${ACCOUNT_ID}:identity/${DOMAIN}"

echo "--- ensuring IAM user ${IAM_USER} exists ---"
if ! aws iam get-user --user-name "$IAM_USER" >/dev/null 2>&1; then
  aws iam create-user --user-name "$IAM_USER" >/dev/null
fi

aws iam put-user-policy \
  --user-name "$IAM_USER" \
  --policy-name "ses-send-${DOMAIN}" \
  --policy-document "$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["ses:SendRawEmail", "ses:SendEmail"],
    "Resource": "${IDENTITY_ARN}"
  }]
}
EOF
)"

echo "--- rotating access key ---"
EXISTING_KEYS=$(aws iam list-access-keys --user-name "$IAM_USER" --query 'AccessKeyMetadata[].AccessKeyId' --output text)
for key in $EXISTING_KEYS; do
  aws iam delete-access-key --user-name "$IAM_USER" --access-key-id "$key"
done

CREDS=$(aws iam create-access-key --user-name "$IAM_USER" --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text)
ACCESS_KEY_ID=$(echo "$CREDS" | cut -f1)
SECRET_ACCESS_KEY=$(echo "$CREDS" | cut -f2)

echo "--- deriving SMTP password (AWS SigV4 conversion) ---"
SMTP_PASSWORD=$(python3 - "$SECRET_ACCESS_KEY" "$REGION" <<'PYEOF'
import hashlib
import hmac
import base64
import sys

secret_access_key, region = sys.argv[1], sys.argv[2]
DATE, SERVICE, MESSAGE, TERMINAL, VERSION = "11111111", "ses", "SendRawEmail", "aws4_request", 0x04

def sign(key, msg):
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()

sig = ("AWS4" + secret_access_key).encode("utf-8")
for part in (DATE, region, SERVICE, TERMINAL, MESSAGE):
    sig = sign(sig, part)

print(base64.b64encode(bytes([VERSION]) + sig).decode("utf-8"))
PYEOF
)

# IAM propagation lag: a key that works for SendRawEmail a second later
# can 403 immediately after creation, so this is expected, not a bug.
echo "--- waiting for IAM key propagation ---"
sleep 10

# Both the access key id and the derived password go through url-quote:
# the password is base64, which routinely contains "/" and "+" — left
# unencoded, that "/" gets read as ending the userinfo section, silently
# corrupting the username/password new URL() (mailer.ts) parses out.
ENCODED_ACCESS_KEY_ID=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$ACCESS_KEY_ID")
ENCODED_SMTP_PASSWORD=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$SMTP_PASSWORD")
SMTP_URL="smtps://${ENCODED_ACCESS_KEY_ID}:${ENCODED_SMTP_PASSWORD}@email-smtp.${REGION}.amazonaws.com:465"
aws secretsmanager put-secret-value --secret-id "$SECRET_ARN" --secret-string "$SMTP_URL" >/dev/null

echo "--- forcing auth-svc to pick up the new secret ---"
CLUSTER=$(terraform output -raw ecs_cluster_name)
aws ecs update-service --cluster "$CLUSTER" --service "${CLUSTER}-auth-svc" --force-new-deployment >/dev/null

echo "--- done. SMTP_URL written to ${SECRET_ARN}. auth-svc redeploying. ---"
