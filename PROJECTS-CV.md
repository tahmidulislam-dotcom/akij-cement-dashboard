# Projects & Work Summary (CV Reference)

> Compiled from the work done in this workspace. All projects are live/deployable, built with Node.js, deployed to Vercel, and driven by real production data from Akij Group plants.

---

## 1. Akij Group Multi-Plant Production Control Tower (Deputy COO Dashboard)

**Role:** Build / Backend & Data Engineering
**Dates:** Sep 2026

A **single dashboard that monitors 15+ Akij Group plants** (Cement, Poly Fibre, Agro Feed, Flour, Daal, Ispat, Building Solutions, ARMCL, Rice Mills, Light Engineering) in real time, giving senior management a consolidated view of plant performance.

**Key capabilities:**
- Live **OEE**, Capacity Utilization, NPT (Non-Productive Time), Yield, Planning Achievement, MTBF/MTTR, MRO Downtime, Overtime, Scheduled Maintenance, and Good/Actual Output KPIs across all SBUs.
- **MOH (Manufacturing Overhead) Budget vs Actual** — Today, Month-to-Date, and cumulative charting against daily budget.
- Per-day and per-month **capacity target** logic (monthly/30), per-machine output targets, machine-filtered Good Output.
- **AI report generation** (built-in analyst engine + DeepSeek fallback) over a 1–400 day range — auto-narrates production performance.
- Charting (Chart.js) for OEE trend, NPT, capacity, break-down breakdown, RCA, MTBF, MTTR, MOH, and budget.

**Data & architecture:**
- Real-time data pull from **MSSQL Data Warehouse (DWH)** and **iBOSDD** ERP (tables: MES production/OEE/NPT/RCA/planning, MOH budget, overtime).
- Node.js serverless API backend on **Vercel** (11+ serverless functions): `/api/data`, `/api/live`, `/api/machine-oee`, `/api/moh-budget`, `/api/push-live`, `/api/analyze`, `/api/health`.
- **Live data pipeline:** office-side server pushes to Vercel every 5 minutes → Gist cache → served to the dashboard (with TTL fallback chain: memory → `/tmp` → Gist → DWH).
- **Scheduled rebuilds** via GitHub Actions (06:30 Dhaka) + self-hosted Windows runner; graceful skip when DWH is unreachable.
- Secure config via Vercel encrypted env vars + GitHub Secrets (no passwords committed).

**Stack:** Node.js, Express-style plain HTTP servers, MSSQL (`mssql`), PostgreSQL (`pg`), Chart.js, Vercel Serverless, GitHub Actions, Gist caching, DeepSeek AI.

---

## 2. Akij Resource OPEX Dashboard

**Role:** Full-stack / Backend & Data Engineering
**Dates:** Sep 2026

An **Operating Expense (OPEX) & continuous-improvement dashboard** for the Deputy COO, reporting cost-savings, productivity, and process initiatives.

**Key capabilities:**
- Aggregates and visualizes **target OEE, capacity, cost savings, productivity improvement, and environment impact** tracking.
- **Kaizen / improvement cadence tracking:** Four-Hour Tracking cards, Improvement Cards, Problem-Solving Cards, Process Standardization.
- **QCP audit** (QCP Audit, QCP Specs) and **5S audit** scoring (ACCL).
- Daily meeting form/target management, plus a **task tracker** with updates (relates to daily management routines).
- **Reliability module** (MTBF / MTTR) computed from the MSSQL DWH MES data.
- **AI analysis** (DeepSeek) and **reporting via Gmail** (OAuth) to recipients.

**Data & architecture:**
- **PostgreSQL (Azure)** as the primary OPEX source + **MSSQL DWH** for reliability/OEE.
- Node.js server (`opex-server.js`) exposing `/api/data`, `/api/dwh`, `/api/reliability`, `/api/analyze`, `/api/emails`, `/api/send`.
- Whitelisted-table access model (allow-list of ~17 OPEX/MES tables).
- Deployed to Vercel (`vercel-liard-eight-31.vercel.app`), linked from the main dashboard header.

**Stack:** Node.js, PostgreSQL (Azure), MSSQL, Chart.js, DeepSeek AI, Gmail OAuth, Vercel.

---

## 3. Automated Escalation Alert & Email Reporting Engine

**Role:** Backend / Automation
**Dates:** Sep 2026

A **threshold-based alert engine** that continuously monitors production, maintenance, MOH cost, and performance across SBUs and automatically escalates to the right people by email.

**Key capabilities:**
- Per-SBU **threshold config** (yield target, capacity target, plan achievement, max waste %, MOH variance %, schedule deviation %).
- **Monthly OEE target tables** loaded per SBU (ACCL, APFIL, AIL, AEFML, MRML, AAFL, FAL).
- **3-tier escalation:** plant head (1st) → HOB/CEO (2nd) → Deputy COO (3rd+ escalation), with per-SBU daily reset counters.
- **Daily 22:00 Dhaka cron** that evaluates metrics and sends **professional branded KPI dashboard email reports** (with real KPI figures, target-vs-actual, OEE, waste, MOH).
- **Send Test Mail** (all SBUs or a single SBU) for verification.
- **Stop/Resume controls** for the alert job (`alertsEnabled` flag, Vercel env kill-switch, serverless toggle API) so automation can be paused safely from the dashboard.

**Stack:** Node.js, Vercel Cron, Gmail OAuth (SMTP via Gmail API), serverless functions, JSON config-driven.

---

## 4. MCP Server & Custom Tool Integration

**Role:** Backend / Integration
**Dates:** Sep 2026

Exposed the dashboard's data layer as a **Model Context Protocol (MCP)** endpoint so users/AI agents can query live plant, OEE, capacity, MOH, and output data on demand.

**Key capabilities:**
- **Streamable HTTP MCP transport** (`/api/mcp`) published as a **shareable remote MCP** (`https://akij-cement-dashboard.vercel.app/api/mcp`).
- Resources: `dashboard://summary`, `dashboard://live`, `dashboard://plant`, `dashboard://machine-oee`, `dashboard://moh`.
- JSON-RPC `initialize / resources/list / tools/call` implemented; configured via `mcpfy.json` for easy sharing.
- Connected to structured **schema information** (across Asset, Procurement, Finance, Import, WMS, MES, OMS, TMS, RTM and more) to build accurate, safe read-only queries.

**Stack:** Node.js, MCP (Streamable HTTP), JSON-RPC, Vercel Serverless.

---

## 5. Data/Query Tooling (Support & Enablement)

**Role:** Data Engineering / Support
**Dates:** Sep 2026

- Built **safe READ-ONLY query tooling** wrapped around MSSQL (iBOSDD ERP), PeopleDesk HR, and project-tracker databases (best-practice `WITH (NOLOCK)`, allow-listed schemas, result caps).
- Domain-specific lookup tools covering **Assets, Procurement (PR/PO), Finance/GL, Import (LC/shipments/insurance), WMS/Inventory (MRR), Partners, Items, MES (production orders/shop floor), OMS (sales/quotes/outlets/routes), TMS (vehicles/gate pass), VAT/Tax, Farmer, RTM**.
- HR integration tools for **PeopleDesk employees (profile 360), live attendance punches, leave balances, salary/payroll breakdowns**, and company policies.
- Engineering-resource reporting across the **project tracker** (developer workload matrix, sprint analytics, bug/issue analysis, task details).

---

## Skills Showcase

- **Languages:** JavaScript / Node.js, SQL (MSSQL, PostgreSQL), HTML/CSS.
- **Frameworks & Platforms:** Vercel Serverless, GitHub Actions, Chart.js, MCP, DeepSeek AI, Gmail OAuth.
- **Databases:** Microsoft SQL Server (ERP/DWH), PostgreSQL (Azure), caching (Gist/Redis-like TTL patterns).
- **Data Engineering:** ETL-style data pipelines, scheduled jobs (cron/GitHub Actions), live pushing, safe read-only querying, schema-aware access layers.
- **Automation:** thresholds/escalation, email reporting, kill-switches, monitoring.
- **Integration:** REST APIs, JSON-RPC, OAuth, model-context-protocol servers, 3rd-party AI.

---

## Highlights for a CV

- Built **real-time executive dashboards for 15+ manufacturing plants**, mixing live ERP (MES/OEE/NPT/MOH) data with AI-generated narratives.
- Designed a **production-grade data pipeline** (office → Vercel → Gist → dashboard) for near-real-time monitoring.
- Automated **multi-tier escalation emailing** with branded KPI reports — daily, self-serve, and controllable.
- Exposed enterprise data as a **shareable MCP (AI-tool) endpoint** — modern integration skill.
- Wrote secure, **read-only data-access layers** and broad domain tooling across a large ERP ecosystem.
