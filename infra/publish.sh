#!/usr/bin/env bash
set -euo pipefail

: "${AZURE_RESOURCE_GROUP:?Set AZURE_RESOURCE_GROUP to the existing resource group}"
: "${AZURE_REGISTRY_NAME:?Set AZURE_REGISTRY_NAME to the deployed registry name}"
if [[ "${1:-}" != "--build-only" ]]; then
  : "${AZURE_CONTAINER_APP_NAME:?Set AZURE_CONTAINER_APP_NAME to the deployed container app name}"
fi

cd "$(dirname "$0")/.."
tag="${IMAGE_TAG:-$(date -u +%Y%m%d%H%M%S)}"
login_server="$(az acr show --name "$AZURE_REGISTRY_NAME" --query loginServer -o tsv)"
image="${login_server}/chessquest:${tag}"
docker build --tag "$image" .

docker_config="$(mktemp -d)"
trap 'rm -f -- "$docker_config/config.json"; rmdir -- "$docker_config"' EXIT
token="$(az acr login --name "$AZURE_REGISTRY_NAME" --expose-token --query accessToken -o tsv)"
printf '%s' "$token" | docker --config "$docker_config" login "$login_server" \
  --username 00000000-0000-0000-0000-000000000000 --password-stdin
unset token
docker --config "$docker_config" push "$image"

if [[ "${1:-}" == "--build-only" ]]; then
  printf 'Image ready: %s\n' "$image"
  exit 0
fi

echo "Deactivating old revisions before deployment; active game clocks continue."
# Single-revision rolling replacement would briefly start two database owners.
az containerapp revision set-mode --name "$AZURE_CONTAINER_APP_NAME" \
  --resource-group "$AZURE_RESOURCE_GROUP" --mode multiple --output none
revisions="$(az containerapp revision list --name "$AZURE_CONTAINER_APP_NAME" \
  --resource-group "$AZURE_RESOURCE_GROUP" --query '[?properties.active].name' -o tsv)"
while IFS= read -r revision; do
  if [[ -n "$revision" ]]; then
    az containerapp revision deactivate --name "$AZURE_CONTAINER_APP_NAME" \
      --resource-group "$AZURE_RESOURCE_GROUP" --revision "$revision" --output none
  fi
done <<< "$revisions"
az containerapp update --name "$AZURE_CONTAINER_APP_NAME" --resource-group "$AZURE_RESOURCE_GROUP" \
  --image "$image" --output none
az containerapp revision set-mode --name "$AZURE_CONTAINER_APP_NAME" \
  --resource-group "$AZURE_RESOURCE_GROUP" --mode single --output none
host="$(az containerapp show --resource-group "$AZURE_RESOURCE_GROUP" --name "$AZURE_CONTAINER_APP_NAME" \
  --query properties.configuration.ingress.fqdn -o tsv)"
curl --fail --show-error --silent --retry 30 --retry-delay 10 --retry-all-errors \
  --max-time 30 "https://${host}/healthz"
printf '\nDeployment healthy: https://%s\n' "$host"
