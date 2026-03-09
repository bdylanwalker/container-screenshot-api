#!/usr/bin/env bash
# =============================================================================
# infra/shared/bootstrap.sh
#
# One-time bootstrap. Handles the two things Bicep cannot:
#   1. Resource group creation  (must exist before deployment group create)
#   2. Service principal        (requires Azure AD Graph API, not ARM)
#
# Then invokes main.bicep for everything else.
# Safe to re-run — all steps are idempotent.
#
# Usage:
#   az login
#   az account set --subscription "<your-subscription-id>"
#   chmod +x infra/shared/bootstrap.sh
#   ./infra/shared/bootstrap.sh
# =============================================================================

set -euo pipefail

LOCATION="eastus"
RG="rg-container-apps"
SP_NAME="sp-container-apps-deploy"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BICEP_FILE="${SCRIPT_DIR}/main.bicep"
PARAM_FILE="${SCRIPT_DIR}/main.bicepparam"

GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${CYAN}▶${NC} $*"; }
success() { echo -e "${GREEN}✓${NC} $*"; }
warn()    { echo -e "${YELLOW}!${NC} $*"; }

SUBSCRIPTION_ID="$(az account show --query id -o tsv)"

echo ""
echo "  Subscription : $SUBSCRIPTION_ID"
echo "  Location     : $LOCATION"
echo "  Resource Group: $RG"
echo ""

# ── Step 1: Resource group ────────────────────────────────────────────────────
info "Step 1/3  Resource group: $RG"
az group create \
  --name "$RG" \
  --location "$LOCATION" \
  --tags purpose=container-apps managed-by=bicep \
  --output none
success "Resource group ready"

# ── Step 2: Bicep deployment ──────────────────────────────────────────────────
info "Step 2/3  Deploying shared infrastructure (main.bicep)..."
DEPLOY_OUTPUT="$(az deployment group create \
  --resource-group "$RG" \
  --template-file "$BICEP_FILE" \
  --parameters "$PARAM_FILE" \
  --output json)"

ACR_RESOURCE_ID="$(echo "$DEPLOY_OUTPUT" | python3 -c \
  "import sys,json; print(json.load(sys.stdin)['properties']['outputs']['acrResourceId']['value'])")"
ACR_LOGIN_SERVER="$(echo "$DEPLOY_OUTPUT" | python3 -c \
  "import sys,json; print(json.load(sys.stdin)['properties']['outputs']['acrLoginServer']['value'])")"
CA_ENV_NAME="$(echo "$DEPLOY_OUTPUT" | python3 -c \
  "import sys,json; print(json.load(sys.stdin)['properties']['outputs']['caEnvName']['value'])")"
STORAGE_ACCOUNT_NAME="$(echo "$DEPLOY_OUTPUT" | python3 -c \
  "import sys,json; print(json.load(sys.stdin)['properties']['outputs']['storageAccountName']['value'])")"
ACR_NAME="${ACR_LOGIN_SERVER%.azurecr.io}"

success "Shared infrastructure deployed"

# ── Step 3: Service principal ─────────────────────────────────────────────────
info "Step 3/3  Service principal: $SP_NAME"

RG_SCOPE="/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RG}"
EXISTING_SP="$(az ad sp list --display-name "$SP_NAME" --query '[0].appId' -o tsv 2>/dev/null || true)"

if [[ -n "$EXISTING_SP" && "$EXISTING_SP" != "None" ]]; then
  warn "Service principal '$SP_NAME' already exists ($EXISTING_SP) — skipping creation."
  warn "To rotate credentials: az ad sp delete --id $EXISTING_SP  then re-run."
  SP_APP_ID="$EXISTING_SP"
  SP_JSON=""
else
  SP_JSON="$(az ad sp create-for-rbac \
    --name "$SP_NAME" \
    --role Contributor \
    --scopes "$RG_SCOPE" \
    --sdk-auth \
    --output json)"
  SP_APP_ID="$(echo "$SP_JSON" | python3 -c \
    "import sys,json; print(json.load(sys.stdin)['clientId'])")"
  success "Service principal created: $SP_APP_ID"
fi

# AcrPush — idempotent
az role assignment create \
  --assignee "$SP_APP_ID" \
  --role AcrPush \
  --scope "$ACR_RESOURCE_ID" \
  --output none 2>/dev/null || true
success "AcrPush assigned on $ACR_LOGIN_SERVER"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════"
echo "  Bootstrap complete"
echo "════════════════════════════════════════════════════"
echo "  Resource Group   : $RG"
echo "  ACR              : $ACR_LOGIN_SERVER"
echo "  Storage Account  : $STORAGE_ACCOUNT_NAME"
echo "  CA Environment   : $CA_ENV_NAME"
echo "  Service Principal: $SP_NAME ($SP_APP_ID)"
echo ""

if [[ -n "$SP_JSON" ]]; then
  echo "════════════════════════════════════════════════════"
  echo "  ⚠  Save these credentials NOW — shown only once"
  echo "════════════════════════════════════════════════════"
  echo "$SP_JSON" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f'  clientId:       {d[\"clientId\"]}')
print(f'  clientSecret:   {d[\"clientSecret\"]}')
print(f'  tenantId:       {d[\"tenantId\"]}')
print(f'  subscriptionId: {d[\"subscriptionId\"]}')
"
  echo ""
fi

echo "════════════════════════════════════════════════════"
echo "  ADO one-time setup"
echo "════════════════════════════════════════════════════"
echo "  1. Pipelines › Library › Variable Groups"
echo "     Create group: container-apps-shared"
echo "     Variables:"
echo "       AZURE_RESOURCE_GROUP  = $RG"
echo "       ACR_NAME              = $ACR_NAME"
echo "       CA_ENV_NAME           = $CA_ENV_NAME"
echo "       STORAGE_ACCOUNT_NAME  = $STORAGE_ACCOUNT_NAME"
echo ""
echo "  2. Project Settings › Service connections › New"
echo "     Type: Azure Resource Manager"
echo "     Auth: Service Principal (manual)"
echo "     Name: azure-service-connection"
echo "     Paste clientId / clientSecret / tenantId from above."
echo ""
echo "  3. Link 'container-apps-shared' variable group"
echo "     to each app pipeline."
echo "════════════════════════════════════════════════════"
echo ""
echo "  To add a new app later:"
echo "    1. Add name to appFileShares in main.bicepparam"
echo "    2. az deployment group create \\"
echo "         --resource-group $RG \\"
echo "         --template-file infra/shared/main.bicep \\"
echo "         --parameters infra/shared/main.bicepparam"
echo ""
