targetScope = 'resourceGroup'

@description('GitHub owner/repository allowed to deploy.')
param repository string = 'sanketbakshi1981/chesspulse'

@description('GitHub environment; restrict its deployment branches to main in GitHub settings.')
param githubEnvironment string = 'production'

@description('Exact GitHub OIDC subject. Override when GitHub includes immutable owner/repository IDs.')
param githubSubject string = 'repo:${repository}:environment:${githubEnvironment}'

param appName string
param planName string = 'chessquest-plan'
param location string = resourceGroup().location

resource app 'Microsoft.Web/sites@2024-11-01' existing = {
  name: appName
}

resource plan 'Microsoft.Web/serverfarms@2024-11-01' existing = {
  name: planName
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'chessquest-github-deploy'
  location: location
  tags: { application: 'chessquest', environment: 'mvp' }
}

resource federation 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: identity
  name: 'github-production'
  properties: {
    issuer: 'https://token.actions.githubusercontent.com'
    subject: githubSubject
    audiences: ['api://AzureADTokenExchange']
  }
}

resource deploy 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(app.id, identity.id, 'WebsiteContributor')
  scope: app
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'de139f84-1756-47ae-9be6-808fbbe84772')
  }
}

resource readPlan 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(plan.id, identity.id, 'Reader')
  scope: plan
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'acdd72a7-3385-48ef-bd42-f606fba81ae7')
  }
}

output clientId string = identity.properties.clientId
output tenantId string = tenant().tenantId
output subscriptionId string = subscription().subscriptionId
output resourceGroupName string = resourceGroup().name
