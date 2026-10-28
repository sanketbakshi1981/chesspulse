# Low-cost Azure Container Apps deployment

The app runs on **Container Apps Consumption, 0–1 replicas**, with **PostgreSQL
Flexible Server B1ms**, 32 GiB storage, private VNet connectivity, verified TLS,
seven-day backups and no high availability. Azure supplies HTTPS and WebSockets.
The image is private in a Basic Azure Container Registry. Local development still
uses SQLite. This deployment starts with an empty database; it does not migrate
local accounts or games.

There is no App Service plan, VM, Redis, SignalR service, dedicated workload
profile, NAT gateway, private endpoint, Log Analytics workspace, budget resource,
email notification or spending cap. Budget monitoring is managed separately by
the subscription owner.

## Idle scaling and game safety

HTTP requests wake the app. A tiny Azure Storage queue also acts as a KEDA activity
signal: while authenticated sockets are connected **or games are still active**,
the app renews a marker every 30 seconds. This keeps clocks, presence and
matchmaking running without relying on WebSocket upgrades being counted as new
HTTP requests. After the last player disconnects and no games remain, the marker
is removed and the app can scale to zero after the five-minute cooldown.

The marker expires after two minutes if the process crashes. It contains only the
word `active`, never identities, game records or quest data. Managed identity
authorizes queue access; storage account keys are disabled. The application uses
the documented Container Apps local managed-identity REST endpoint to obtain a
cached storage token, avoiding interactive login libraries in the runtime image.

The first request after idle has a cold start. PostgreSQL, registry storage and
DNS remain billable when app replicas are zero. A signed-in open tab counts as
usage and keeps the app awake. Do not configure external frequent health polling
if you want it to sleep. Platform health probes are internal.

**Run one process and at most one active revision.** PostgreSQL's advisory lock
rejects another app process because presence and queues are in memory. Do not
scale above one replica or point a staging app at the same database. Deployments
deliberately deactivate the previous revision before starting the replacement;
schedule them between matches. Clocks continue through downtime.

## Cost and US-region choice

Run a live read-only estimate, optionally supplying active hours per month:

```bash
node infra/estimate-cost.mjs centralus       # idle baseline
node infra/estimate-cost.mjs centralus 100   # 100 active replica hours
node infra/estimate-cost.mjs centralus 730   # continuously active
```

Central US public USD rates checked October 28, 2026:

| Resource | Monthly estimate |
| --- | ---: |
| PostgreSQL B1ms, 730 hours | $14.02 |
| PostgreSQL storage, 32 GiB | $4.16 |
| Basic registry, approximately 730 hours | $5.07 |
| **Idle baseline, before extras** | **$23.25** |
| ACA 0.25 vCPU / 0.5 GiB, per active hour before grants | $0.027 |

Private DNS, queue operations/storage, requests, excess backups, image storage
beyond the registry allowance, egress and taxes are additional. Consumption
grants can reduce compute charges, but are shared across the subscription and
must not be assumed available. At 730 active hours, the estimate before grants
is about $42.96 plus extras; with full monthly compute grants it is about $37.56
plus extras. The **US$40 target is not a hard cap**.

The estimate uses the [Azure Retail Prices API](https://prices.azure.com/api/retail/prices);
verify actual charges in [Azure Cost Management](https://portal.azure.com/).
Do not enable dedicated profiles, planned maintenance or private endpoints
without repricing: these can introduce fixed environment charges.

**Central US is the selected region.** The previous East US 2 deployment failed
to provision B1ms with `SkuNotAvailable`. Central US advertises B1ms without a
reported restriction, but SKU listings do not guarantee live capacity. Confirm
the actual deployment result and reprice any fallback region.
Monitor B1ms CPU credits, memory and storage. Autogrow is disabled to prevent
unplanned growth; increase storage deliberately before it fills.

## Authenticate and verify availability

Requires Azure CLI with Container Apps support and Bicep, Node 24, Docker with
a running daemon, and curl. Do not paste credentials into chat or commit them.
The deploying identity needs resource creation and role-assignment permission.

If `az` is missing, install it using the
[official Azure CLI installation instructions](https://learn.microsoft.com/cli/azure/install-azure-cli).
Run the following in a terminal in this repository. Complete device-code sign-in
in your own browser; do not send the code, passwords or tokens through chat.
Choose your own subscription from the account list, not an example subscription.

```bash
az login --use-device-code
az account list --query '[].{Name:name,Subscription:id,Default:isDefault}' -o table
export AZURE_SUBSCRIPTION_ID="<your-subscription-id>"
az account set --subscription "$AZURE_SUBSCRIPTION_ID"
az account show --query '{Name:name,Subscription:id}' -o table

az extension add --name containerapp --upgrade
az bicep install
export AZURE_LOCATION=centralus
export AZURE_RESOURCE_GROUP=chessquest-mvp-centralus

node --version
docker info
az bicep build --file infra/main.bicep --stdout > /dev/null
az postgres flexible-server list-skus --location "$AZURE_LOCATION" -o table
az containerapp env workload-profile list-supported --location "$AZURE_LOCATION" -o table
node infra/estimate-cost.mjs "$AZURE_LOCATION" 730
```

If you see `SubscriptionNotFound`, no subscriptions, a denied role assignment,
or a region/SKU restriction, resolve it before provisioning. Template compilation
does not check subscription permissions, quotas, live capacity or image startup.
The deployment uses a private registry, so your deploying identity also needs
permission to push images.

Register the required providers if they are not already registered. Registration
itself does not create billable resources:

```bash
for provider in Microsoft.App Microsoft.ContainerRegistry Microsoft.Network \
  Microsoft.DBforPostgreSQL Microsoft.ManagedIdentity Microsoft.Storage; do
  az provider register --namespace "$provider" --wait --output none
done
```

Before creating resources, confirm the live estimate and configure cost alerts
in Azure Cost Management if desired. Alerts do not stop spending. At continuous
activity, this configuration can exceed a US$40/month target even without extras.
Re-run the cost estimate and availability checks before choosing another region.

## First deployment

The templates default to the resource group's location. For a regional replacement,
use a new resource group in the selected region; existing regional resources cannot
be moved by changing `location`. Keep the old deployment until the replacement
passes live verification, then deliberately remove only the obsolete deployment.
Both deployments may incur charges during that overlap.

These are real provisioning commands. The approved monthly cost is usage-based,
and resources start charging as they are created.

```bash
npm ci
npm test
npx playwright install chromium      # once per local browser test environment
npm run test:e2e

az group create --name "$AZURE_RESOURCE_GROUP" --location "$AZURE_LOCATION"
az deployment group create --name registry \
  --resource-group "$AZURE_RESOURCE_GROUP" --template-file infra/registry.bicep
export AZURE_REGISTRY_NAME="$(az deployment group show --name registry \
  --resource-group "$AZURE_RESOURCE_GROUP" --query properties.outputs.registryName.value -o tsv)"

export IMAGE_TAG="$(date -u +%Y%m%d%H%M%S)"
bash infra/publish.sh --build-only

az deployment group what-if --resource-group "$AZURE_RESOURCE_GROUP" \
  --template-file infra/main.bicep --parameters imageTag="$IMAGE_TAG"
az deployment group create --name chessquest \
  --resource-group "$AZURE_RESOURCE_GROUP" --template-file infra/main.bicep \
  --parameters imageTag="$IMAGE_TAG"
```

The CLI prompts for the secure `databasePassword` parameter. Generate at least
16 characters with a password manager and keep it securely; never put it literally
on the command line or in shell history. Use the same password for preview and
deployment. The template outputs no secrets. Database credentials initially use
the provisioning administrator: restrict configuration access, and provision a
least-privilege runtime role and rotate credentials before a wider launch.
The database has no public endpoint; do not expose it for development access.

The registry bootstrap is separate so the actual image exists before the
container app starts. Managed identity pulls the image; registry admin access
is disabled. The Docker context allowlist excludes local data, tests, Git history
and deployment configuration. Production dependencies come from the lockfile.

Get the app name and URL:

```bash
export AZURE_CONTAINER_APP_NAME="$(az deployment group show --name chessquest \
  --resource-group "$AZURE_RESOURCE_GROUP" --query properties.outputs.appName.value -o tsv)"
az deployment group show --name chessquest --resource-group "$AZURE_RESOURCE_GROUP" \
  --query properties.outputs.appUrl.value -o tsv
```

## Publish updates

```bash
bash infra/publish.sh
```

### Automatic deployment from GitHub

[The GitHub Actions workflow](../.github/workflows/azure.yml) tests pull requests
and pushes to `main`. After a successful `main` run, it builds the checked-in
source, pushes an image tagged with the commit SHA/run/attempt, and deploys to the
existing Central US app. Manual runs are permitted only on `main`. Production
deployments are serialized and never cancel an in-progress deployment.

This is push-based continuous deployment, not a Kubernetes reconciliation
controller. It updates application images only; Bicep infrastructure changes
still require an explicit preview and deployment. The workflow never receives a
database password, registry password or Azure client secret.

Create the dedicated passwordless deployment identity once as an Azure owner:

```bash
az deployment group create --name github-actions \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --template-file infra/github-actions.bicep \
  --parameters registryName="$AZURE_REGISTRY_NAME" appName="$AZURE_CONTAINER_APP_NAME" \
  --query properties.outputs
```

In GitHub **Settings > Environments**, create `production`, allow only the `main`
branch to deploy (selected deployment branches), and leave required reviewers
disabled for automatic releases. Add these environment **variables**, not secrets:

| Variable | Value |
| --- | --- |
| `AZURE_CLIENT_ID` | `clientId` output from the identity deployment |
| `AZURE_TENANT_ID` | `tenantId` output |
| `AZURE_SUBSCRIPTION_ID` | `subscriptionId` output |
| `AZURE_RESOURCE_GROUP` | `chessquest-mvp-centralus` |
| `AZURE_REGISTRY_NAME` | Central US registry name |
| `AZURE_CONTAINER_APP_NAME` | Central US app name |

The identity trusts only this repository's `production` environment. It has
`AcrPush` on the one registry, `Container Apps Contributor` on the one app and
its environment (including read/join permission, not environment configuration
write permission), and `Managed Identity Operator` on the app's runtime identity
so updates can retain that identity. It has no subscription-wide Contributor/Owner.
Environment branch restrictions are required to prevent another branch from
requesting the same environment identity. Protect `main` and review workflow
changes before merging. Anyone able to deploy can run code with the app's runtime
permissions; OIDC removes long-lived credentials, not that trust boundary.

Before the first run, ensure GitHub Actions is enabled and all application,
lockfile, Docker and infrastructure files are committed. Uncommitted workspace
changes are not available to the runner. Configure the `test` job as a required
branch status check if desired. CI runs unit tests and PostgreSQL/browser tests
against a disposable service database, never production.

The script builds/pushes a uniquely tagged image, temporarily switches to multiple
revision management solely to deactivate all old revisions, deploys the new
image, restores single-revision mode, and verifies database-backed `/healthz`.
There are deliberately no overlapping database owners. If updating fails after
deactivation, inspect the error and reactivate the previous known-good revision
before restoring single-revision mode. Do not treat a failed publish as success.
Retain only a few known-good image tags to avoid registry storage overages.

Adding a custom domain requires TLS setup and setting `APP_ORIGIN` to that exact
HTTPS origin. The template uses the default ACA hostname and resets this setting
on infrastructure redeployment.

## Verify the live deployment

1. Use two browser profiles to register users, queue/challenge and play.
2. Verify secure cookies, private quests, guesses, recap and independent ratings.
3. Disconnect/reconnect and confirm board and clocks converge.
4. Verify active sockets/games maintain a queue signal and a replica.
5. Close all tabs and finish or let games expire. Wait through marker expiry and
   cooldown; confirm `az containerapp replica list` returns no replicas.
6. Visit again, verify the cold start and persistent identity/history.

With the Azure environment variables set, this automated check creates two hidden
smoke-test accounts and a short game, then verifies zero replicas and cold-start
session/history persistence without periodically waking the app:

```bash
node infra/smoke-test.mjs "https://your-app-hostname" --idle-check
```

Runtime stderr logs are available through `az containerapp logs show`; no
persistent logging workspace is provisioned. Do not log passwords, tokens,
identity headers or private quest payloads. Validate PostgreSQL point-in-time
restore before relying on valuable production data; restoring creates a billable
server. This MVP configuration is not highly available.

## Local PostgreSQL tests

Use a disposable local database ending in `_test`. Tests truncate its application
tables; never use the cloud database.

```bash
docker run --name chessquest-pg-test \
  -e POSTGRES_PASSWORD=local-test-password -e POSTGRES_DB=chessquest_test \
  -p 127.0.0.1:54329:5432 -d postgres:16-alpine
docker exec chessquest-pg-test pg_isready -U postgres
export PGHOST=127.0.0.1 PGPORT=54329 PGDATABASE=chessquest_test PGUSER=postgres
export PGPASSWORD=local-test-password PGSSLMODE=disable
npm run test:postgres
TEST_POSTGRES=1 npm run test:e2e
docker rm -f chessquest-pg-test
unset PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD PGSSLMODE
```

`PGSSLMODE=disable` is rejected in production. Cloud PostgreSQL connections verify
the certificate and hostname. Connection loss is logged and terminates the app
instead of continuing without authoritative storage.

To retire the deployment, first retain any required data export and confirm the
resource group contains only these resources. Then deliberately delete that
resource group in Azure. This irreversibly removes the database, backups,
registry, app and networking. Scaling the app to zero does not delete these
resources or end their charges.
