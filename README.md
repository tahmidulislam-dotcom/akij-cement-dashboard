# OEE Machine Performance & Loss Summary

Live, read-only machine-performance dashboard for Akij Group plants, hosted on Vercel.

- **Frontend:** `index.html` (self-contained; Chart.js from CDN)
- **Backend:** Vercel serverless functions in `api/` (Node.js)
- **Data:** iBOS ERP via the **enterprise-api-gateway** MCP (`execute_readonly_query` → iBOSDDD, read-only)

## Endpoints

| Path | Purpose |
|---|---|
| `GET /api/business-units` | BU dropdown list |
| `GET /api/health` | Gateway connectivity check |
| `GET /api/oee?bu=&from=&to=&plantId=&machineId=&uom=` | OEE / capacity / yield / NPT / waste machine rows + tiles + charts |
| `GET /api/plan-variance?bu=&from=&to=&plantId=` | Production Plan Variance & Issue Tracking (`mes.tblProductionPlanVarianceIssue`) |
| `GET /api/schedule-maintenance?bu=` | Schedule Maintenance close rate (registered asset API) |
| `GET /api/five-s-kaizen?bu=&from=&to=` | 5S score & Kaizen counts (Google Sheets) |

## Why the gateway?

A direct MSSQL connection to the DWH is firewalled from Vercel's egress IPs. The
`enterprise-api-gateway` is on the public internet and reaches the ERP database, so all
SQL is executed through its `execute_readonly_query` tool.

> The gateway only permits statements that begin with `SELECT` (no CTEs / `WITH`), so
> aggregation is written as a subquery in `FROM`.

## Environment variables

| Var | Required | Notes |
|---|---|---|
| `ERP_GATEWAY_TOKEN` | yes | Bearer token for `enterprise-api-gateway.opsh.io` |
| `ERP_GATEWAY_URL` | no | default `https://enterprise-api-gateway.opsh.io` |

## Deploy

```
npx vercel --prod
```
