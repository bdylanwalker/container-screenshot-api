// infra/screenshot-svc/main.bicep
//
// App-level resources for screenshot-svc.
// References shared infrastructure — does NOT create RG, ACR, storage, or CA env.
// Shared infra is managed by infra/shared/main.bicep.

// ── Parameters ────────────────────────────────────────────────────────────────

@description('Container image tag — injected by pipeline as Build.BuildId')
param imageTag string

@description('API bearer token for the /screenshot endpoint')
@secure()
param apiKey string

@description('Name of the shared ACR (without .azurecr.io)')
param acrName string = 'rccontainerapps'

@description('Name of the shared Container Apps Environment')
param caEnvName string = 'cae-shared'

@description('Name of the shared storage account')
param storageAccountName string = 'rccontainerappsstr'

@description('Azure region — must match the shared environment region')
param location string = resourceGroup().location

// ── Locals ────────────────────────────────────────────────────────────────────

var appName = 'screenshot-svc'
var acrLoginServer = '${acrName}.azurecr.io'

// ── Existing shared resources ─────────────────────────────────────────────────

resource caEnv 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: caEnvName
}

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' existing = {
  name: storageAccountName
}

// ── Container App ─────────────────────────────────────────────────────────────

resource containerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  properties: {
    environmentId: caEnv.id
    configuration: {
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
      }
      registries: [
        {
          server: acrLoginServer
          identity: 'system'
        }
      ]
      secrets: [
        {
          name: 'api-key'
          value: apiKey
        }
        {
          name: 'storage-key'
          value: storageAccount.listKeys().keys[0].value
        }
      ]
    }
    template: {
      volumes: [
        {
          name: 'app-storage'
          storageType: 'AzureFile'
          storageName: '${appName}-storage'  // registered on CA env by infra/shared
        }
      ]
      containers: [
        {
          name: appName
          image: '${acrLoginServer}/${appName}:${imageTag}'
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
          env: [
            { name: 'API_KEY',  secretRef: 'api-key' }
            { name: 'PORT',     value: '3000' }
            { name: 'NODE_ENV', value: 'production' }
            { name: 'DATA_DIR', value: '/mnt/data' }
          ]
          volumeMounts: [
            {
              volumeName: 'app-storage'
              mountPath: '/mnt/data'
            }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: { path: '/health', port: 3000 }
              initialDelaySeconds: 10
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: { path: '/health', port: 3000 }
              initialDelaySeconds: 5
              periodSeconds: 10
            }
          ]
        }
      ]
      scale: {
        minReplicas: 0    // scale to zero when idle
        maxReplicas: 3
        rules: [
          {
            name: 'http-scaling'
            http: {
              metadata: {
                concurrentRequests: '5'
              }
            }
          }
        ]
      }
    }
  }
}

// ── Outputs ───────────────────────────────────────────────────────────────────

output containerAppFqdn string = containerApp.properties.configuration.ingress.fqdn
output containerAppName string = containerApp.name
