# Simple Azure deployment: App Service + PostgreSQL

The production architecture is:

```text
Browser -- HTTPS / WebSockets --> Linux App Service B1 (one Node 24 process)
                                         |
                                  PostgreSQL over verified TLS
                                         |
                              PostgreSQL Flexible Server B1ms
                              (public endpoint, IP firewall)
```

An App Service plan supplies the web app's compute. There is no Container Apps
environment, container registry, Docker build, runtime managed identity, activity
queue, storage account, VNet or private DNS zone. GitHub deployment optionally uses
a passwordless OIDC identity; it is not a runtime dependency.

Local development still uses SQLite. Azure starts with a **new empty PostgreSQL
database**; existing accounts and games are not migrated.

## Cost and operating constraints

Central US public USD list prices checked October 29, 2026:

| Resource | Monthly estimate |
| --- | ---: |
| Linux App Service B1, 730 hours | $13.14 |
| PostgreSQL B1ms, 730 hours | $14.02 |
| PostgreSQL storage, 32 GiB | $4.16 |
| **Baseline, whether idle or active** | **$31.32** |

Run `node infra/estimate-cost.mjs centralus` to refresh the estimate using the
[Azure Retail Prices API](https://prices.azure.com/api/retail/prices).
Excess backups, optional monitoring, outbound bandwidth and taxes are additional.
This is not a quote or spending cap. A calendar month may exceed 730 hours.
Stopping the web app does **not** stop App Service plan charges. Both old and new
infrastructure charge during migration overlap.

Always On keeps the game maintenance loop alive without a queue or cold-start
mechanism. The plan has **one instance**, and the startup command is
`node src/server.js`, not a multi-worker process manager. Presence, matchmaking and
challenges remain in memory; the PostgreSQL advisory lock rejects another owner.
Do not scale out, use deployment slots with this database, or share it with another
running app. Deploy between matches: publishing stops the app, replaces its ZIP
package, starts it and checks database-backed `/healthz`. Clocks continue through
downtime; reconnection restores persisted game state.

The database has 32 GiB storage, seven-day backups, no high availability and
disabled autogrow. Monitor storage, memory and B1ms CPU credits. Confirm live SKU
capacity before provisioning; an earlier East US 2 B1ms deployment was unavailable.
B1 has no deployment slots or automatic scale-out.

## Public database, not unrestricted database

PostgreSQL has a public endpoint, but the
[firewall module](database-access.bicep) permits only the web app's reported
**possible outbound IPs**. There is no `0.0.0.0` "allow all Azure services" rule
and no internet-wide allow rule. These IPs can be shared with other Azure apps;
database credentials and TLS remain essential. `require_secure_transport=on`
and `PGSSLMODE=verify-full` enforce encrypted, certificate-verified connections.

Changing the App Service plan/tier or recreating the app can change its outbound
IPs. Re-run the infrastructure deployment and verify the actual firewall before
publishing after such a change. Incremental deployments add current IP rules but
do not remove old ones: review `az postgres flexible-server firewall-rule list`
and deliberately delete obsolete `app-<ip>` rules.

No developer IP is allowed by default. For direct administration, temporarily
allow only your current public IP, use verified TLS and remove the rule afterward.
The deployment uses the provisioning administrator as the initial database user.
Restrict app configuration access, create a least-privilege runtime database role
and rotate credentials before a wider launch. Passwords must never be committed,
pasted into chat, passed literally on the command line or written to logs.

## Provision a new deployment

Requires Azure CLI, Bicep, Node **24**, npm, zip and curl. Docker is needed only
for optional local PostgreSQL tests, not deployment. Install Azure CLI using the
[official instructions](https://learn.microsoft.com/cli/azure/install-azure-cli)
if missing. These commands create billable resources; review costs first.

```bash
az login --use-device-code
az account list --query '[].{Name:name,Subscription:id,Default:isDefault}' -o table
export AZURE_SUBSCRIPTION_ID="<your-subscription-id>"
az account set --subscription "$AZURE_SUBSCRIPTION_ID"
export AZURE_LOCATION=centralus
export AZURE_RESOURCE_GROUP=chessquest-appservice-centralus

az bicep install
az provider register --namespace Microsoft.Web --wait
az provider register --namespace Microsoft.DBforPostgreSQL --wait
az postgres flexible-server list-skus --location "$AZURE_LOCATION" -o table
az webapp list-runtimes --os linux -o tsv
# Confirm NODE:24-lts is offered, and Linux Basic B1 is available in this region.
az appservice list-locations --sku B1 --linux-workers-enabled -o table
# Regional availability does not guarantee this subscription has B1 quota.
az rest --method get \
  --url "https://management.azure.com/subscriptions/$AZURE_SUBSCRIPTION_ID/providers/Microsoft.Web/locations/$AZURE_LOCATION/usages?api-version=2024-11-01" \
  --query "value[?name.value=='B1' || name.value=='*'].{Quota:name.localizedValue,Used:currentValue,Limit:limit}" \
  -o table
node infra/estimate-cost.mjs "$AZURE_LOCATION"

npm ci
npm test
az bicep build --file infra/main.bicep --stdout > /dev/null
az bicep build --file infra/github-actions.bicep --stdout > /dev/null

az group create --name "$AZURE_RESOURCE_GROUP" --location "$AZURE_LOCATION"
az deployment group what-if --resource-group "$AZURE_RESOURCE_GROUP" \
  --template-file infra/main.bicep
az deployment group create --name chessquest \
  --resource-group "$AZURE_RESOURCE_GROUP" --template-file infra/main.bicep
```

The CLI prompts for the secure `databasePassword` parameter. Generate at least
16 characters with a password manager and keep it securely. Use the same password
for preview and deployment. The template outputs no secrets.

If preview reports `SubscriptionIsOverQuotaForSku`, request a B1 limit of at
least one in that region, or choose another region with available quota. Update
both `AZURE_LOCATION` and `AZURE_RESOURCE_GROUP` and repeat the availability,
pricing and preview checks before provisioning. Do not select a more expensive
tier merely to bypass quota.

Use the **new** resource group above, not the existing ACA resource group. The
new PostgreSQL name includes `pg-public` because changing an existing privately
networked server's networking is not this migration's strategy. The app initially
has no code; publish only after infrastructure and firewall provisioning succeed:

```bash
export AZURE_WEBAPP_NAME="$(az deployment group show --name chessquest \
  --resource-group "$AZURE_RESOURCE_GROUP" --query properties.outputs.appName.value -o tsv)"
export AZURE_PLAN_NAME="$(az deployment group show --name chessquest \
  --resource-group "$AZURE_RESOURCE_GROUP" --query properties.outputs.planName.value -o tsv)"
export AZURE_POSTGRES_NAME="$(az deployment group show --name chessquest \
  --resource-group "$AZURE_RESOURCE_GROUP" --query properties.outputs.postgresName.value -o tsv)"
az postgres flexible-server firewall-rule list --resource-group "$AZURE_RESOURCE_GROUP" \
  --server-name "$AZURE_POSTGRES_NAME" -o table
bash infra/publish.sh
```

The publisher stages only `src`, `public`, package manifests and lockfile-installed
production dependencies. It does not upload local databases, `.env`, Git history,
tests or infrastructure. It packages with Node 24 to match the server runtime.
App Service mounts the ZIP read-only (`WEBSITE_RUN_FROM_PACKAGE=1`); the app uses
PostgreSQL, not SQLite in that package. Platform-provided `PORT` is honored.
No server-side build or registry is required. HTTPS and WebSockets are enabled,
FTP and SCM basic authentication are disabled, and Azure CLI authenticates using
your Azure identity.

For later updates, run `bash infra/publish.sh` with the same two Azure environment
variables. If deployment fails after stopping the app, the script returns an
error, not success. Inspect deployment logs and retry with corrected code or a
known-good checkout. If only startup/health fails, the app may already be running
but unhealthy; diagnose it before declaring recovery. Do not start a second app
against the same database to work around a failed deployment.

Adding a custom domain requires TLS setup and setting `APP_ORIGIN` to that exact
HTTPS origin. The template resets it to the default App Service hostname on
infrastructure redeployment.

## Automatic deployment from GitHub

The [workflow](../.github/workflows/azure.yml) tests pull requests and pushes to
`main`. Successful `main` runs deploy a production ZIP using Azure OIDC.
Deployments are serialized and never cancel an in-progress deployment.
Infrastructure changes still require explicit Bicep preview/deployment.

Create the deployment identity once with an account that can create role
assignments (register `Microsoft.ManagedIdentity` first if necessary):

```bash
az provider register --namespace Microsoft.ManagedIdentity --wait
az deployment group create --name github-actions \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --template-file infra/github-actions.bicep \
  --parameters appName="$AZURE_WEBAPP_NAME" planName="$AZURE_PLAN_NAME" \
  --query properties.outputs
```

In GitHub **Settings > Environments**, create `production`, allow only the `main`
branch to deploy and add these environment **variables**, not secrets:

| Variable | Value |
| --- | --- |
| `AZURE_CLIENT_ID` | `clientId` output from the identity deployment |
| `AZURE_TENANT_ID` | `tenantId` output |
| `AZURE_SUBSCRIPTION_ID` | `subscriptionId` output |
| `AZURE_RESOURCE_GROUP` | `chessquest-appservice-centralus` |
| `AZURE_WEBAPP_NAME` | New web app name |

The current production App Service is `chessquest-web-72ydyurqniopa` in
`chessquest-appservice-westus2`, with plan `chessquest-plan`. Use these values
when configuring the existing deployment, rather than the Central US examples
for new infrastructure. After replacing the old Container Apps configuration,
remove the unused `AZURE_CONTAINER_APP_NAME` and `AZURE_REGISTRY_NAME` variables.

For this repository, GitHub includes immutable owner/repository IDs in its OIDC
subject. When deploying the identity template, also pass
`--parameters githubSubject='repo:sanketbakshi1981@213671551/chesspulse@1434837256:environment:production'`.
Azure must match the subject exactly; the name-only default will fail login.

The identity has **Website Contributor scoped to this web app only** and **Reader
on its plan** so the publisher can check the single-instance constraint. It has
no subscription-wide Contributor or access to provision PostgreSQL. The workflow
does not receive a database password, publishing password or Azure client secret.
Protect `main`, review workflow changes and restrict the environment's branches:
anyone allowed to deploy code can exercise that code's database permissions.
All source and deployment changes must be committed before GitHub can deploy them.
CI tests use a disposable PostgreSQL service, never production.

## Custom domain: questoc.com

The Azure DNS zone `questoc.com` is in `chessquest-appservice-westus2`.
Registration remains at Namecheap, with Custom DNS nameservers:

```text
ns1-01.azure-dns.com
ns2-01.azure-dns.net
ns3-01.azure-dns.org
ns4-01.azure-dns.info
```

The apex A record points to App Service's inbound IP `20.115.232.33`;
`www` is a CNAME to `chessquest-web-72ydyurqniopa.azurewebsites.net`.
Keep the `asuid` and `asuid.www` TXT ownership records. Both names require
App Service hostname bindings and separate free managed certificates with
SNI bindings. DNS records alone do not enable HTTPS or HTTP redirects.
Azure DNS has ongoing zone/query charges. Namecheap email forwarding is not
used and was not migrated; configure an email provider before using domain email.

After both certificate bindings are ready, set `APP_ORIGIN=https://questoc.com`
and `APP_REDIRECT_HOST=www.questoc.com`. Deploy the server with redirect support
before enabling that setting. The alias returns a permanent 308 redirect to the
canonical HTTPS origin, preserving the path/query. Only the canonical origin is
allowed for browser API and Socket.IO requests. The Azure hostname remains
available for deployment health checks, but is no longer the browser app origin.
Users must sign in again on the new domain; cookies do not transfer between hosts.

For subsequent infrastructure deployments, pass
`--parameters appOrigin=https://questoc.com appRedirectHost=www.questoc.com`
to both what-if and deployment commands, or the template defaults will restore
the Azure origin and disable the redirect. These parameters do not provision DNS
or certificates. Recheck the inbound IP after recreating/moving the app, and
keep DNS pointed directly at App Service for managed certificate renewal.

## Verify and retire the old ACA deployment

1. Verify the new site's `/healthz`, HTTPS, secure cookies and public-origin checks.
2. Use two browser profiles to register, pair, play, guess and inspect recap.
3. Disconnect/reconnect and confirm board, clocks and private quests converge.
4. Run the smoke test below. It creates two accounts and a short game:

   ```bash
   node infra/smoke-test.mjs "https://your-app.azurewebsites.net" --connection-check
   ```

5. Restart the web app and confirm a browser session, game/history and ratings
   persist. This verifies PostgreSQL durability; there is no scale-to-zero test.
6. Point GitHub's production variables (and any custom domain) at the new app.
   Remove obsolete `AZURE_REGISTRY_NAME` and `AZURE_CONTAINER_APP_NAME` variables.
7. Only after these checks pass, inspect the old resource group in Azure. Confirm
   it contains only obsolete Chess Quest resources and no shared dependencies.
   Remove the old ACA app/environment, PostgreSQL, registry, queue/storage, VNet,
   private DNS and identities/role assignments, or delete the old group through
   the portal after confirming its exact contents. No old data is being retained.
   Check for abandoned resources from earlier regional deployment attempts too.
8. Verify Cost Management no longer shows ongoing usage from the retired
   resources. Deploying this template in incremental mode never removes them.

Runtime logs are available through App Service's **Log stream**; enable filesystem
application logging temporarily for troubleshooting. No paid monitoring workspace
is provisioned. Do not log passwords, tokens or private quest payloads.
Validate PostgreSQL point-in-time restore before relying on valuable production
data; a restore creates another billable server. This MVP is not highly available.

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
npx playwright install chromium
TEST_POSTGRES=1 npm run test:e2e
docker rm -f chessquest-pg-test
unset PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD PGSSLMODE
```

`PGSSLMODE=disable` is rejected in production. Cloud PostgreSQL connections verify
the server certificate and hostname; never disable verification to bypass a
connection error.
