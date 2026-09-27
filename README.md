# OEE Machine Performance & Loss Summary

Live, read-only machine-performance dashboard for Akij Group plants, hosted on Vercel.

- **Frontend:** `index.html` (self-contained; Chart.js from CDN)
- **Backend:** Vercel serverless functions in `api/` (Node.js)
- **Data:** iBOS DWH (SQL Server) `mes.*Arc` mirror tables, read-only via `mssql`

## Endpoints

| Path | Purpose |
|---|---|
| `GET /api/business-units` | BU dropdown list |
| `GET /api/health` | DB connectivity check |
| `GET /api/oee?bu=&from=&to=&plantId=&machineId=&uom=` | OEE / capacity / yield / NPT / waste machine rows + tiles + charts |
| `GET /api/plan-variance?bu=&from=&to=&plantId=` | Production Plan Variance & Issue Tracking (`mes.tblProductionPlanVarianceIssueArc`) |
| `GET /api/schedule-maintenance?bu=` | Schedule Maintenance close rate (via enterprise-api-gateway) |
| `GET /api/five-s-kaizen?bu=&from=&to=` | 5S score & Kaizen counts (Google Sheets) |

## Environment variables

| Var | Required | Notes |
|---|---|---|
| `MSSQL_SERVER` / `MSSQL_PORT` / `MSSQL_USER` / `MSSQL_PASSWORD` / `MSSQL_DATABASE` | yes | DWH connection (read-only). Defaults exist but should be set in Vercel. |
| `ERP_GATEWAY_TOKEN` | for schedule-maintenance | Bearer token for `enterprise-api-gateway.opsh.io` |
| `ERP_GATEWAY_URL` | no | default `https://enterprise-api-gateway.opsh.io` |

## Deploy

```
npx vercel --prod
```

> The DWH firewall must allow Vercel egress IPs for live data.
