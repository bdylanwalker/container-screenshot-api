// infra/shared/main.bicep
//
// Shared infrastructure for ALL container app deployments.
// Deploy this once via bootstrap.sh, then re-run to add new app file shares.
//
// Provisions:
//   - Azure Container Registry
//   - Storage Account + one File Share per app (via appFileShares param)
//   - Log Analytics Workspace
//   - Container Apps Environment
//   - CA env storage mounts (one per app share)
//
// Does NOT provision (handled by bootstrap.sh):
//   - Resource group   (must exist before deployment group create)
//   - Service principal (requires Azure AD Graph API, outside ARM scope)

// ── Parameters ────────────────────────────────────────────────────────────────

@description('Azure region for all shared resources.')
param location string = resourceGroup().location

@description('Globally unique ACR name — alphanumeric, 5–50 chars.')
param acrName string = 'rccontainerapps'

@description('Globally unique storage account name — lowercase alphanumeric, 3–24 chars.')
param storageAccountName string = 'rccontainerappsstr'

@description('Name of the shared Container Apps Environment.')
param caEnvName string = 'cae-shared'

@description('Name of the Log Analytics workspace.')
param logAnalyticsName string = 'law-container-apps'

@description('''
  App names to create file shares for. Each entry creates:
    - Azure File Share:       <appName>           (5 GB)
    - CA env storage mount:   <appName>-storage
  Add new names and redeploy — existing shares are untouched.
''')
param appFileShares array = [
  'screenshot-svc'
]

@description('Log retention in days.')
param logRetentionDays int = 30

var tags = {
  purpose: 'container-apps'
  'managed-by': 'bicep'
}

// ── Container Registry ────────────────────────────────────────────────────────

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: acrName
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Enabled'
    zoneRedundancy: 'Disabled'
  }
}

// ── Storage Account ───────────────────────────────────────────────────────────

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: storageAccountName
  location: location
  tags: tags
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    accessTier: 'Hot'
  }
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-01-01' = {
  parent: storageAccount
  name: 'default'
}

resource fileShares 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-01-01' = [
  for appName in appFileShares: {
    parent: fileService
    name: appName
    properties: {
      shareQuota: 5
      enabledProtocols: 'SMB'
    }
  }
]

// ── Log Analytics ─────────────────────────────────────────────────────────────

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: logAnalyticsName
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: logRetentionDays
  }
}

// ── Container Apps Environment ────────────────────────────────────────────────

resource caEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: caEnvName
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

resource caEnvStorageMounts 'Microsoft.App/managedEnvironments/storages@2024-03-01' = [
  for appName in appFileShares: {
    parent: caEnv
    name: '${appName}-storage'
    properties: {
      azureFile: {
        accountName: storageAccount.name
        accountKey: storageAccount.listKeys().keys[0].value
        shareName: appName
        accessMode: 'ReadWrite'
      }
    }
  }
]

// ── Outputs ───────────────────────────────────────────────────────────────────

output acrLoginServer string = acr.properties.loginServer
output acrResourceId string = acr.id
output caEnvName string = caEnv.name
output storageAccountName string = storageAccount.name
output fileSharesProvisioned array = appFileShares
