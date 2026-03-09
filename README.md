# Container Apps Monorepo

Shared Azure infrastructure + individual container app deployments.

## Structure

```
infra/
  shared/                         # Shared Azure infrastructure (deploy once)
    main.bicep                    # ACR, storage, CA environment, Log Analytics
    main.bicepparam               # Names and app file share list — edit here
    bootstrap.sh                  # One-time: resource group + service principal
    azure-pipelines.yml           # Redeploys shared infra on infra/shared/** changes

  screenshot-svc/                 # App-level Bicep (one folder per app)
    main.bicep                    # Container App referencing shared resources

apps/
  screenshot-svc/                 # App source code
    src/
      server.ts
    Dockerfile
    openapi.json
    package.json
    tsconfig.json
    azure-pipelines.yml           # Build image + deploy app on apps/screenshot-svc/** changes
```

## First-time setup

```bash
az login
az account set --subscription "<your-subscription-id>"
chmod +x infra/shared/bootstrap.sh
./infra/shared/bootstrap.sh
```

Follow the printed instructions to create the ADO variable group and service connection.

## Adding a new app

1. Add the app name to `appFileShares` in `infra/shared/main.bicepparam`
2. Redeploy shared infra (push the change — the shared pipeline picks it up)
3. Create `infra/<app-name>/main.bicep` referencing shared resources
4. Create `apps/<app-name>/` with source, Dockerfile, and `azure-pipelines.yml`
5. Register both pipelines in ADO and link the `container-apps-shared` variable group

## ADO variable group: container-apps-shared

| Variable | Value |
|---|---|
| `AZURE_RESOURCE_GROUP` | `rg-container-apps` |
| `ACR_NAME` | `rccontainerapps` |
| `CA_ENV_NAME` | `cae-shared` |
| `STORAGE_ACCOUNT_NAME` | `rccontainerappsstr` |

## ADO pipelines

| Pipeline | File | Triggers on |
|---|---|---|
| Shared Infra | `infra/shared/azure-pipelines.yml` | `infra/shared/**` |
| screenshot-svc | `apps/screenshot-svc/azure-pipelines.yml` | `apps/screenshot-svc/**` or `infra/screenshot-svc/**` |
