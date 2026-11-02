targetScope = 'resourceGroup'

@description('Azure region. Confirm regional prices and SKU availability before deploying.')
param location string = resourceGroup().location

@minLength(3)
@maxLength(20)
@description('Lowercase letters, digits and hyphens; names receive a globally unique suffix.')
param namePrefix string = 'chessquest'

@description('Canonical HTTPS origin after custom-domain binding and certificate setup. Empty uses the Azure hostname.')
param appOrigin string = ''

@description('Optional hostname to redirect to appOrigin, for example www.questoc.com.')
param appRedirectHost string = ''

@secure()
@minLength(16)
param databasePassword string

var suffix = uniqueString(resourceGroup().id)
var databaseName = 'chessquest'
var databaseUser = 'chessquestadmin'
var tags = {
  application: 'chessquest'
  environment: 'mvp'
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: '${namePrefix}-pg-public-${suffix}'
  location: location
  tags: tags
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    version: '16'
    administratorLogin: databaseUser
    administratorLoginPassword: databasePassword
    storage: {
      storageSizeGB: 32
      autoGrow: 'Disabled'
      type: 'Premium_LRS'
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: { mode: 'Disabled' }
    network: { publicNetworkAccess: 'Enabled' }
  }
}

resource appDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: database
  name: databaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

resource requireTls 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: database
  name: 'require_secure_transport'
  properties: {
    value: 'on'
    source: 'user-override'
  }
}

resource plan 'Microsoft.Web/serverfarms@2024-11-01' = {
  name: '${namePrefix}-plan'
  location: location
  tags: tags
  kind: 'linux'
  sku: {
    name: 'B1'
    tier: 'Basic'
    capacity: 1
  }
  properties: {
    reserved: true
  }
}

resource app 'Microsoft.Web/sites@2024-11-01' = {
  name: '${namePrefix}-web-${suffix}'
  location: location
  tags: tags
  kind: 'app,linux'
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    clientAffinityEnabled: false
    siteConfig: {
      linuxFxVersion: 'NODE|24-lts'
      appCommandLine: 'node src/server.js'
      alwaysOn: true
      webSocketsEnabled: true
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      scmMinTlsVersion: '1.2'
    }
  }
}

resource appSettings 'Microsoft.Web/sites/config@2024-11-01' = {
  parent: app
  name: 'appsettings'
  properties: {
    NODE_ENV: 'production'
    APP_ORIGIN: empty(appOrigin) ? 'https://${app.properties.defaultHostName}' : appOrigin
    APP_REDIRECT_HOST: appRedirectHost
    PGHOST: database.properties.fullyQualifiedDomainName
    PGPORT: '5432'
    PGDATABASE: databaseName
    PGUSER: databaseUser
    PGPASSWORD: databasePassword
    PGSSLMODE: 'verify-full'
    WEBSITE_RUN_FROM_PACKAGE: '1'
    SCM_DO_BUILD_DURING_DEPLOYMENT: 'false'
  }
  dependsOn: [appDatabase, requireTls]
}

// The module can expand outbound addresses after App Service has been provisioned.
module databaseAccess 'database-access.bicep' = {
  name: 'app-database-access'
  params: {
    serverName: database.name
    outboundAddresses: split(app.properties.possibleOutboundIpAddresses, ',')
  }
}

resource scmBasicAuth 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-11-01' = {
  parent: app
  name: 'scm'
  properties: { allow: false }
}

resource ftpBasicAuth 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-11-01' = {
  parent: app
  name: 'ftp'
  properties: { allow: false }
}

output appName string = app.name
output planName string = plan.name
output appUrl string = 'https://${app.properties.defaultHostName}'
output postgresHost string = database.properties.fullyQualifiedDomainName
output postgresName string = database.name
