#!/usr/bin/env bash
set -euo pipefail

# Usage: ./scripts/deploy_infra.sh <rg> <location> <appname> <storage>
# Example: ./scripts/deploy_infra.sh rg-ai-dev westeurope ai-sql-tools-dev staisqltoolsdev123

# Load .env for local convenience (Azure/CI should pass env or args)
if [ -f ".env" ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

# Resolve inputs: args override env; fallback to env if args omitted
RG="${1:-${AZ_RG:-${RG:-}}}"
LOC="${2:-${AZ_LOCATION:-${LOC:-}}}"
APP="${3:-${AZ_FUNC_APP:-${APP:-}}}"
SA="${4:-${AZ_STORAGE_ACCOUNT:-${SA:-}}}"

if [ -z "${RG:-}" ] || [ -z "${LOC:-}" ] || [ -z "${APP:-}" ] || [ -z "${SA:-}" ]; then
  echo "Usage: ./scripts/deploy_infra.sh <rg> <location> <appname> <storage>" >&2
  echo "Or set AZ_RG, AZ_LOCATION, AZ_FUNC_APP, AZ_STORAGE_ACCOUNT in .env or env." >&2
  exit 1
fi

echo ">> Using RG=$RG LOC=$LOC APP=$APP SA=$SA"

echo ">> Creating resource group"
az group create -n "$RG" -l "$LOC" >/dev/null

echo ">> Creating storage account (GPv2)"
az storage account create -g "$RG" -n "$SA" -l "$LOC" --sku Standard_LRS --kind StorageV2 >/dev/null

echo ">> Creating Function App (Linux, Consumption, Node 20)"
az functionapp create \
  --resource-group "$RG" \
  --consumption-plan-location "$LOC" \
  --runtime node --runtime-version 20 \
  --functions-version 4 \
  --name "$APP" \
  --storage-account "$SA" >/dev/null

echo ">> Enabling system-assigned managed identity"
az functionapp identity assign -g "$RG" -n "$APP" >/dev/null
MI_PRINCIPAL_ID=$(az functionapp identity show -g "$RG" -n "$APP" --query principalId -o tsv)
echo "   MI principalId: $MI_PRINCIPAL_ID"

echo ">> Setting app settings (edit SQL_* before you run or set after)"
az functionapp config appsettings set -g "$RG" -n "$APP" --settings \
  SCM_DO_BUILD_DURING_DEPLOYMENT=true \
  SQL_SERVER="${SQL_SERVER:-REPLACE.database.windows.net}" \
  SQL_DATABASE="${SQL_DATABASE:-REPLACE}" \
  SCHEMA_WHITELIST="${SCHEMA_WHITELIST:-vw%}" \
  ROW_LIMIT_DEFAULT="${ROW_LIMIT_DEFAULT:-200}" \
  TZ="${TZ:-UTC}" \
  NODE_ENV="production" >/dev/null

cat <<EOF

NEXT STEPS (manual, required):
1) In Azure SQL:
   - Create an AAD user for the Function's Managed Identity and grant read-only:
     CREATE USER [$APP] FROM EXTERNAL PROVIDER;
     ALTER ROLE db_datareader ADD MEMBER [$APP];

2) SQL Server Networking:
   - For dev: enable "Allow Azure services and resources to access this server".
   - For prod: consider Private Endpoint.

3) Deploy code: ./scripts/deploy_func.sh $RG $APP
EOF

