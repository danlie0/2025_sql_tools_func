#!/usr/bin/env bash
set -euo pipefail

# Usage: ./scripts/deploy_func.sh <rg> <appname>

# Load .env if present
if [ -f ".env" ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

# Resolve inputs: args override env; fallback to env
RG="${1:-${AZ_RG:-${RG:-}}}"
APP="${2:-${AZ_FUNC_APP:-${APP:-}}}"

if [ -z "${RG:-}" ] || [ -z "${APP:-}" ]; then
  echo "Usage: ./scripts/deploy_func.sh <rg> <appname>" >&2
  echo "Or set AZ_RG and AZ_FUNC_APP in .env or env." >&2
  exit 1
fi

echo ">> Using RG=$RG APP=$APP"

echo ">> Installing deps (production)"
npm ci --omit=dev

echo ">> Creating deployment package"
ZIP=package.zip
rm -f "$ZIP"
zip -r "$ZIP" . -x "*.git*" "node_modules/*" ".vscode/*" "package-lock.json" "*.env" >/dev/null

echo ">> Zip deploy (remote build by Oryx)"
az functionapp deployment source config-zip -g "$RG" -n "$APP" --src "$ZIP" >/dev/null

echo ">> Getting function key"
KEY=$(az functionapp function keys list -g "$RG" -n "$APP" --function-name "sql-schema" --query "default" -o tsv 2>/dev/null || echo "<FUNCTION_KEY>")

echo ">> Done. Test endpoints:"
echo "GET  https://$APP.azurewebsites.net/api/sql-schema?code=$KEY"
echo "POST https://$APP.azurewebsites.net/api/sql-query?code=$KEY"

