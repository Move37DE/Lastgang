# Azure Container Apps Deployment

Anleitung fuer das Deployment des Lastgang-Analyzers auf Azure Container Apps.

## Voraussetzungen

- Azure-Subscription
- Azure CLI installiert: `az --version`
- Docker Desktop laeuft lokal
- `az login` einmal ausgefuehrt

## Variablen setzen

```powershell
$RG = "rg-lastgang-analyzer"
$LOCATION = "westeurope"
$ACR = "acrlastganganalyzer$(Get-Random -Maximum 9999)"
$APP = "lastgang-analyzer"
$ENV = "cae-lastgang-analyzer"
$IMAGE = "lastgang-analyzer:latest"
```

## 1. Resource Group + Container Registry

```powershell
az group create --name $RG --location $LOCATION

az acr create --resource-group $RG --name $ACR --sku Basic --admin-enabled true

# Login
az acr login --name $ACR
```

## 2. Image bauen und in Registry pushen

```powershell
# Lokal bauen (im Projekt-Root):
docker build -t $ACR.azurecr.io/$IMAGE .

# Push
docker push $ACR.azurecr.io/$IMAGE
```

Alternative: Build direkt in Azure (kein lokales Docker noetig):
```powershell
az acr build --registry $ACR --image $IMAGE .
```

## 3. Container Apps Environment + App

```powershell
# Environment (einmalig)
az containerapp env create `
  --name $ENV `
  --resource-group $RG `
  --location $LOCATION

# Credentials fuer ACR
$ACR_USER = az acr credential show -n $ACR --query username -o tsv
$ACR_PWD = az acr credential show -n $ACR --query passwords[0].value -o tsv

# App deployen
az containerapp create `
  --name $APP `
  --resource-group $RG `
  --environment $ENV `
  --image "$ACR.azurecr.io/$IMAGE" `
  --target-port 3002 `
  --ingress external `
  --registry-server "$ACR.azurecr.io" `
  --registry-username $ACR_USER `
  --registry-password $ACR_PWD `
  --min-replicas 0 `
  --max-replicas 3 `
  --cpu 0.5 `
  --memory 1Gi `
  --env-vars NODE_ENV=production PORT=3002 MAX_UPLOAD_MB=25
```

`min-replicas 0` heisst: bei Inaktivitaet skaliert die App auf null Container — kosten nur Speicher in der Registry.

## 4. URL abrufen

```powershell
az containerapp show -n $APP -g $RG --query properties.configuration.ingress.fqdn -o tsv
```

→ Aufrufen im Browser, App ist erreichbar.

## 5. Update deployen

Nach Code-Aenderung:
```powershell
az acr build --registry $ACR --image $IMAGE .
az containerapp update -n $APP -g $RG --image "$ACR.azurecr.io/$IMAGE"
```

## 6. (Optional) Persistente Reports via Azure Files

Reports liegen aktuell im Container-Filesystem und gehen beim Restart verloren. Fuer Phase 2:

```powershell
# Storage Account + File Share
az storage account create -n stlastganganalyzer -g $RG --sku Standard_LRS
$STORAGE_KEY = az storage account keys list -g $RG -n stlastganganalyzer --query [0].value -o tsv
az storage share create --account-name stlastganganalyzer --account-key $STORAGE_KEY -n reports

# Volume Mount der Container App auf /data
# (Vollstaendige Konfiguration via YAML — siehe Azure Docs "Container Apps storage mounts")
```

## 7. Authentifizierung (Phase 2)

Fuer produktiven Einsatz: Azure Container Apps unterstuetzt **Built-in Authentication** mit Microsoft Entra ID (frueher Azure AD). Setup:

```powershell
az containerapp auth microsoft update `
  --name $APP `
  --resource-group $RG `
  --client-id <APP_REGISTRATION_CLIENT_ID> `
  --tenant-id <TENANT_ID>
```

## 8. Kosten-Schaetzung

- Container Apps Consumption: ~0.000024 USD/vCPU-Sekunde + 0.000003 USD/GiB-Sekunde
- Beispielrechnung: 100 Pruefungen/Monat à 5 Sekunden Laufzeit auf 0.5 vCPU / 1 GiB:
  - vCPU: 100 × 5 × 0.5 × 0.000024 = 0.006 USD
  - Memory: 100 × 5 × 1 × 0.000003 = 0.0015 USD
  - **Gesamt: < 0.01 USD/Monat** — pra ktisch kostenlos bei moderater Nutzung
- Container Registry Basic: ~5 USD/Monat
- Storage Account: ~1 USD/Monat (falls genutzt)

**Realistisch ~6 USD/Monat fuer eine produktive Single-Tenant-App.**

## Troubleshooting

- Logs anzeigen: `az containerapp logs show -n $APP -g $RG --follow`
- Revision auflisten: `az containerapp revision list -n $APP -g $RG -o table`
- Beim ersten Aufruf (cold start) dauert die Antwort ca. 5-10 Sekunden (Container start-up).
