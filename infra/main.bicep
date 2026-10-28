targetScope = 'resourceGroup'

@description('Azure region. Confirm regional prices and SKU availability before deploying.')
param location string = resourceGroup().location

@minLength(3)
@maxLength(20)
@description('Lowercase letters, digits and hyphens; names receive a globally unique suffix.')
param namePrefix string = 'chessquest'

@secure()
@minLength(16)
param databasePassword string

@description('An immutable image tag already pushed to the registry by publish.sh --build-only.')
param imageTag string

var suffix = uniqueString(resourceGroup().id)
var appName = '${namePrefix}-${suffix}'
var databaseName = 'chessquest'
var databaseUser = 'chessquestadmin'
var identityId = resourceId('Microsoft.ManagedIdentity/userAssignedIdentities', '${namePrefix}-runtime')
var tags = {
  application: 'chessquest'
  environment: 'mvp'
}

module runtime 'registry.bicep' = {
  name: 'runtime'
  params: {
    location: location
    namePrefix: namePrefix
  }
}

resource network 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: '${namePrefix}-network'
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: ['10.42.0.0/16']
    }
    subnets: [
      {
        name: 'app'
        properties: {
          addressPrefix: '10.42.0.0/26'
          delegations: [
            {
              name: 'container-apps'
              properties: { serviceName: 'Microsoft.App/environments' }
            }
          ]
        }
      }
      {
        name: 'database'
        properties: {
          addressPrefix: '10.42.1.0/27'
          delegations: [
            {
              name: 'postgresql'
              properties: { serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers' }
            }
          ]
        }
      }
    ]
  }
}

resource dns 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: '${namePrefix}.postgres.database.azure.com'
  location: 'global'
  tags: tags
}

resource dnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: dns
  name: 'database-network'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: network.id }
  }
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: '${namePrefix}-pg-${suffix}'
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
    network: {
      delegatedSubnetResourceId: '${network.id}/subnets/database'
      privateDnsZoneArmResourceId: dns.id
      publicNetworkAccess: 'Disabled'
    }
  }
  dependsOn: [dnsLink]
}

resource appDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: database
  name: databaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

resource activityStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'cqactivity${suffix}'
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    supportsHttpsTrafficOnly: true
  }
}

resource queueService 'Microsoft.Storage/storageAccounts/queueServices@2023-05-01' existing = {
  parent: activityStorage
  name: 'default'
}

resource activityQueue 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = {
  parent: queueService
  name: 'activity'
}

resource queueAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(activityStorage.id, identityId, 'QueueContributor')
  scope: activityStorage
  properties: {
    principalId: runtime.outputs.identityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '974c5e8b-45b9-4653-ba55-5f855dd0fb88')
  }
}

resource environment 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: '${namePrefix}-environment'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: { destination: 'azure-monitor' }
    vnetConfiguration: {
      infrastructureSubnetId: '${network.id}/subnets/app'
      internal: false
    }
    workloadProfiles: [
      { name: 'Consumption', workloadProfileType: 'Consumption' }
    ]
  }
}

resource app 'Microsoft.App/containerApps@2025-01-01' = {
  name: appName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identityId}': {} }
  }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      secrets: [{ name: 'database-password', value: databasePassword }]
      registries: [
        { server: runtime.outputs.loginServer, identity: identityId }
      ]
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
        traffic: [{ latestRevision: true, weight: 100 }]
      }
    }
    template: {
      terminationGracePeriodSeconds: 30
      containers: [
        {
          name: 'chessquest'
          image: '${runtime.outputs.loginServer}/chessquest:${imageTag}'
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'PORT', value: '3000' }
            { name: 'APP_ORIGIN', value: 'https://${appName}.${environment.properties.defaultDomain}' }
            { name: 'PGHOST', value: database.properties.fullyQualifiedDomainName }
            { name: 'PGPORT', value: '5432' }
            { name: 'PGDATABASE', value: databaseName }
            { name: 'PGUSER', value: databaseUser }
            { name: 'PGPASSWORD', secretRef: 'database-password' }
            { name: 'PGSSLMODE', value: 'verify-full' }
            { name: 'AZURE_CLIENT_ID', value: runtime.outputs.identityClientId }
            { name: 'ACTIVITY_QUEUE_URL', value: '${activityStorage.properties.primaryEndpoints.queue}activity' }
          ]
          probes: [
            {
              type: 'Startup'
              httpGet: { path: '/healthz', port: 3000, scheme: 'HTTP' }
              periodSeconds: 5
              timeoutSeconds: 3
              failureThreshold: 60
            }
            {
              type: 'Readiness'
              httpGet: { path: '/healthz', port: 3000, scheme: 'HTTP' }
              periodSeconds: 10
              timeoutSeconds: 3
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 1
        cooldownPeriod: 300
        pollingInterval: 30
        rules: [
          { name: 'http', http: { metadata: { concurrentRequests: '1' } } }
          {
            name: 'activity'
            custom: {
              type: 'azure-queue'
              identity: identityId
              metadata: {
                accountName: activityStorage.name
                queueName: activityQueue.name
                queueLength: '1'
                activationQueueLength: '0'
              }
            }
          }
        ]
      }
    }
  }
  dependsOn: [appDatabase, queueAccess]
}

output appName string = app.name
output appUrl string = 'https://${app.properties.configuration.ingress.fqdn}'
output postgresHost string = database.properties.fullyQualifiedDomainName
output registryName string = runtime.outputs.registryName
