// infra/shared/main.bicepparam
// Edit this file to change names or add new app file shares, then redeploy.

using './main.bicep'

param location = 'eastus'

// ACR: globally unique, alphanumeric only, 5–50 chars
// Check: az acr check-name --name <candidate>
param acrName = 'rccontainerapps'

// Storage: globally unique, lowercase alphanumeric, 3–24 chars
// Check: az storage account check-name --name <candidate>
param storageAccountName = 'rccontainerappsstr'

param caEnvName = 'cae-shared'
param logAnalyticsName = 'law-container-apps'

// Add a new app name here and redeploy to provision its file share + CA env mount.
// Existing entries are never modified or deleted on redeploy.
param appFileShares = [
  'screenshot-svc'
  // 'my-next-app'
]

param logRetentionDays = 30
