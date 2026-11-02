#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 0 ]]; then
  echo "Usage: bash infra/publish.sh (uses AZURE_RESOURCE_GROUP and AZURE_WEBAPP_NAME)" >&2
  exit 1
fi
: "${AZURE_RESOURCE_GROUP:?Set AZURE_RESOURCE_GROUP to the existing resource group}"
: "${AZURE_WEBAPP_NAME:?Set AZURE_WEBAPP_NAME to the deployed App Service name}"

cd "$(dirname "$0")/.."
for tool in az node npm zip curl; do
  command -v "$tool" >/dev/null || { echo "Required tool is missing: $tool" >&2; exit 1; }
done
node -e 'if (Number(process.versions.node.split(".")[0]) !== 24) throw new Error("Package with Node 24 to match App Service.")'

work="$(mktemp -d)"
stopped=false
cleanup() {
  local status=$?
  rm -rf -- "$work"
  if [[ $status -ne 0 && "$stopped" == true ]]; then
    echo "Deployment failed after stopping the app. It has NOT been verified healthy." >&2
    echo "Inspect deployment logs, then retry this script or restore a known-good package." >&2
  fi
}
trap cleanup EXIT

mkdir "$work/app"
cp package.json package-lock.json "$work/app/"
cp -R src public "$work/app/"
npm ci --omit=dev --prefix "$work/app"
(cd "$work/app" && zip -q -r "$work/app.zip" .)

plan="$(az webapp show --resource-group "$AZURE_RESOURCE_GROUP" --name "$AZURE_WEBAPP_NAME" \
  --query serverFarmId -o tsv)"
capacity="$(az appservice plan show --ids "$plan" --query sku.capacity -o tsv)"
if [[ "$capacity" != 1 ]]; then
  echo "Refusing deployment: the App Service plan must have exactly one instance." >&2
  exit 1
fi
host="$(az webapp show --resource-group "$AZURE_RESOURCE_GROUP" --name "$AZURE_WEBAPP_NAME" \
  --query defaultHostName -o tsv)"
if [[ -z "$host" || "$host" == "null" ]]; then
  echo "App Service did not return a hostname." >&2
  exit 1
fi

echo "Stopping the app before package replacement; schedule deployments between matches."
az webapp stop --name "$AZURE_WEBAPP_NAME" --resource-group "$AZURE_RESOURCE_GROUP" --output none
stopped=true
az webapp deploy --name "$AZURE_WEBAPP_NAME" --resource-group "$AZURE_RESOURCE_GROUP" \
  --src-path "$work/app.zip" --type zip --restart false --track-status false \
  --async false --output none
az webapp start --name "$AZURE_WEBAPP_NAME" --resource-group "$AZURE_RESOURCE_GROUP" --output none
curl --fail --show-error --silent --retry 30 --retry-delay 10 --retry-all-errors \
  --max-time 30 "https://${host}/healthz"
stopped=false
printf '\nDeployment healthy: https://%s\n' "$host"
