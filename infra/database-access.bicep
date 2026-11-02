targetScope = 'resourceGroup'

param serverName string

@minLength(1)
@description('All possible outbound IPs reported by the single App Service app.')
param outboundAddresses array

resource database 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' existing = {
  name: serverName
}

resource appFirewall 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = [for address in outboundAddresses: {
  parent: database
  name: 'app-${replace(address, '.', '-')}'
  properties: {
    startIpAddress: address
    endIpAddress: address
  }
}]
