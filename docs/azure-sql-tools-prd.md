# PRD — Azure Functions "SQL Tools" (for Copilot Studio via Connectory)

**Owner:** Adam  
**Status:** Ready to build  
**Goal:** Let users ask questions in Teams/Copilot ("how many users signed up yesterday?"). Copilot Studio calls Connectory → Function App, which executes two tools:

- `sql_schema` — returns a whitelisted schema map (tables/views, columns, joins).
- `sql_query` — executes read‑only, parameterized T‑SQL and returns results (aggregates or small rowsets).

**Why:** Keep SQL access server‑side with strict guardrails while allowing Copilot Studio (via Connectory) to reason/generate queries.

## Scope

### In scope
- One Azure Function App (Node.js 20) with two HTTP endpoints (easy to test) that Connectory can call from Copilot Studio.
- Managed Identity (no secrets) to connect to Azure SQL.
- Hard safety rails: SELECT‑only, auto‑limit, parameterization.
- `.env` and `local.settings.json` for local dev.
- `scripts/deploy_infra.sh` (Azure CLI) to create RG/Storage/Function App + identity + app settings.
- `scripts/deploy_func.sh` to zip‑deploy the code.
- Readme notes + admin reminders (DB user, firewall, etc.).
- Query logging for audit trail
- Common query templates in schema response

### Out of scope
- Writes/DDL (INSERT/UPDATE/DELETE, DROP, ALTER, …).
- Private endpoints (can be added later).
- Vectorization or RAG.

## Key decisions

- **Language:** Node.js with mssql (no ODBC driver hassles).
- **Auth to SQL:** System‑assigned Managed Identity (MI) → AAD token → SQL `db_datareader` only.
- **Network:** For dev, allow "Allow Azure services…" on SQL Server. For prod, use private endpoints.
- **Tables exposed:** Use views (prefix with `vw`) as the allow‑list. The schema tool only emits those.
- **Time zone:** Treat relative dates (e.g., "yesterday") as UTC unless user specifies otherwise.

## Acceptance criteria

- GET `/api/sql-schema` returns JSON describing whitelisted views and columns.
- POST `/api/sql-query` accepts JSON and returns JSON with columns, rows, row_count, and sql_used.
- The code rejects non‑SELECT SQL, injects a `TOP(@row_limit)` if missing, and parameterizes values.
- Function App runs with MI; no connection strings or passwords anywhere.
- Deploy scripts work end‑to‑end from a clean subscription/resource group.
- Query execution is logged with metrics for monitoring

## Repo Layout

```
/sql-tools-func/
  package.json
  host.json
  .funcignore
  local.settings.json        # local only; do not commit secrets
  .env.example               # template for local env
  src/
    app.js                   # registers functions
    lib/
      db.js                  # MI auth + connect helpers
      sqlSafety.js           # validation, limit injection, param parsing
      schemaHelpers.js       # schema descriptions and query templates
    functions/
      sqlSchema.js           # GET/POST /api/sql-schema
      sqlQuery.js            # POST /api/sql-query
  scripts/
    deploy_infra.sh
    deploy_func.sh
  README.md
```

## Environment Variables

Create `.env` for local dev (Cursor should also produce `local.settings.json` with same values):

```bash
# .env (copy to local.settings.json Values)
SQL_SERVER=<your-sql-server>.database.windows.net
SQL_DATABASE=<your-db>
SQL_CONNECTION_STRING=  # Optional: for local dev only
SCHEMA_WHITELIST=vw%    # only expose views matching this
ROW_LIMIT_DEFAULT=200
TZ=UTC
NODE_ENV=development     # Set to 'production' in Azure
```

## Pre-deployment Checklist

☑️ Turn ON System‑Assigned MI on the Function App.  
☑️ In Azure SQL (database), create an AAD user for that MI and grant `db_datareader`:

```sql
CREATE USER [<func-app-mi-name>] FROM EXTERNAL PROVIDER;
ALTER ROLE db_datareader ADD MEMBER [<func-app-mi-name>];
```

☑️ SQL Server → Networking → enable "Allow Azure services and resources…" (for dev).  
☑️ Expose only views you're OK to query (prefix `vw`), not raw tables with PII.

## Implementation Details

### package.json
```json
{
  "name": "sql-tools-func",
  "version": "1.0.0",
  "type": "module",
  "engines": { "node": ">=20" },
  "dependencies": {
    "@azure/functions": "^4.6.0",
    "@azure/identity": "^4.2.0",
    "mssql": "^10.0.1",
    "dotenv": "^16.4.5"
  },
  "scripts": {
    "start": "func start",
    "test:schema": "curl -s http://localhost:7071/api/sql-schema | jq",
    "test:query": "curl -s -X POST http://localhost:7071/api/sql-query -H 'Content-Type: application/json' -d '{\"sql\":\"SELECT TOP(5) * FROM vwUsers\"}' | jq"
  }
}
```

### host.json
```json
{
  "version": "2.0",
  "extensionBundle": { 
    "id": "Microsoft.Azure.Functions.ExtensionBundle", 
    "version": "[4.*, 5.0.0)" 
  }
}
```

### local.settings.json
```json
{
  "IsEncrypted": false,
  "Values": {
    "AzureWebJobsStorage": "UseDevelopmentStorage=true",
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "SQL_SERVER": "REPLACE.database.windows.net",
    "SQL_DATABASE": "REPLACE",
    "SQL_CONNECTION_STRING": "",
    "SCHEMA_WHITELIST": "vw%",
    "ROW_LIMIT_DEFAULT": "200",
    "TZ": "UTC",
    "NODE_ENV": "development"
  }
}
```

### Core Helpers

#### src/lib/db.js
```javascript
import sql from 'mssql';
import { DefaultAzureCredential } from '@azure/identity';

const server   = process.env.SQL_SERVER;    // <server>.database.windows.net
const database = process.env.SQL_DATABASE;

let poolPromise;

/** Get a pooled AAD-token connection to Azure SQL using Managed Identity. */
export async function getPool() {
  if (poolPromise) return poolPromise;

  // Local dev with connection string (optional)
  if (process.env.SQL_CONNECTION_STRING && process.env.NODE_ENV === 'development') {
    poolPromise = sql.connect(process.env.SQL_CONNECTION_STRING);
    return poolPromise;
  }

  // Production with Managed Identity
  const credential = new DefaultAzureCredential();
  const token = (await credential.getToken('https://database.windows.net/.default')).token;

  const config = {
    server,
    database,
    options: { encrypt: true, enableArithAbort: true },
    authentication: {
      type: 'azure-active-directory-access-token',
      options: { token }
    },
    pool: { max: 5, min: 0, idleTimeoutMillis: 30000 }
  };

  poolPromise = new sql.ConnectionPool(config).connect().catch(err => {
    poolPromise = undefined;
    throw err;
  });
  return poolPromise;
}

/** Runs a parameterized query with a params object like {p1: 123}. */
export async function runQuery(query, params = {}) {
  const pool = await getPool();
  const request = pool.request();
  // Bind parameters (infer basic types)
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined) continue;
    const t = typeof v;
    if (t === 'number' && Number.isInteger(v)) request.input(k, sql.Int, v);
    else if (t === 'number') request.input(k, sql.Float, v);
    else if (v instanceof Date) request.input(k, sql.DateTime2, v);
    else if (t === 'boolean') request.input(k, sql.Bit, v);
    else request.input(k, sql.NVarChar(sql.MAX), String(v));
  }
  const result = await request.query(query);
  return result;
}
```

#### src/lib/sqlSafety.js
```javascript
/** Validate that the SQL is SELECT-only and safe-ish. Throw on violation. */
export function validateSelectOnly(sql) {
  const s = sql.trim();
  if (!/^select\s/i.test(s)) throw new Error('Only SELECT statements are allowed.');
  // basic keyword & comment blocks ban
  const banned = /\b(delete|insert|update|merge|alter|drop|create|grant|revoke|truncate|exec|execute|xp_|sp_)\b|;|--|\/\*/i;
  if (banned.test(s)) throw new Error('Prohibited keywords or comment markers found.');
  return s;
}

/** Inject TOP(n) after SELECT if not already present. */
export function injectTopLimit(sql, n) {
  const hasTop = /\bselect\s+top\s*\(/i.test(sql);
  if (hasTop) return sql;
  return sql.replace(/^(\s*select\s+)/i, `$1TOP(${n}) `);
}

/** Convert named params style :p1 to @p1 (tedious/mssql named binder). */
export function toTediousNamedParams(sql) {
  return sql.replace(/:([A-Za-z_]\w*)/g, '@$1');
}
```

#### src/lib/schemaHelpers.js
```javascript
/** Get table descriptions for AI context */
export function getTableDescription(tableName) {
  const descriptions = {
    'vwUsers': 'User accounts with registration dates and basic info',
    'vwOrders': 'Customer orders with amounts and statuses',
    'vwProducts': 'Product catalog with pricing and categories',
    // Add your actual table descriptions
  };
  return descriptions[tableName] || '';
}

/** Get column descriptions for better AI understanding */
export function getColumnDescription(tableName, columnName) {
  const descriptions = {
    'vwUsers': {
      'UserId': 'Unique identifier for each user',
      'CreatedAt': 'UTC timestamp when user registered',
      'Country': 'User country code (ISO 2-letter)',
      'IsActive': 'Whether user account is active'
    },
    // Add more tables and columns
  };
  return descriptions[tableName]?.[columnName] || '';
}

/** Get common query templates */
export function getCommonQueryTemplates() {
  return [
    { 
      description: "Count all users", 
      template: "SELECT COUNT(*) as total FROM vwUsers" 
    },
    { 
      description: "Users by date", 
      template: "SELECT COUNT(*) as count, CAST(CreatedAt as DATE) as date FROM vwUsers WHERE CreatedAt >= :start_date GROUP BY CAST(CreatedAt as DATE)" 
    },
    {
      description: "Top N by group",
      template: "SELECT TOP(:limit) GroupColumn, COUNT(*) as count FROM vwTable GROUP BY GroupColumn ORDER BY count DESC"
    }
  ];
}

/** Get sample joins for common relationships */
export function getSampleJoins(tableName, fks) {
  if (!fks || fks.length === 0) return [];
  
  return fks.slice(0, 2).map(fk => ({
    description: `Join ${tableName} with ${fk.ref_table}`,
    template: `SELECT t1.*, t2.* FROM ${tableName} t1 INNER JOIN ${fk.ref_table} t2 ON t1.${fk.column} = t2.${fk.ref_column}`
  }));
}
```

### HTTP Functions

#### src/functions/sqlSchema.js
```javascript
import { app } from '@azure/functions';
import { getPool } from '../lib/db.js';
import { getTableDescription, getColumnDescription, getCommonQueryTemplates, getSampleJoins } from '../lib/schemaHelpers.js';

const WHITELIST = process.env.SCHEMA_WHITELIST || 'vw%';

app.http('sql-schema', {
  methods: ['GET','POST'],
  authLevel: 'function',
  route: 'sql-schema',
  handler: async (req, ctx) => {
    try {
      let filter = null;
      if (req.method === 'POST') {
        const body = await req.json().catch(() => ({}));
        filter = Array.isArray(body?.tables) && body.tables.length ? body.tables : null;
      }

      const pool = await getPool();
      let views;
      if (filter) {
        const list = filter.map((_, i) => `@n${i}`).join(',');
        const r = await pool.request().query(
          `SELECT TABLE_SCHEMA, TABLE_NAME
             FROM INFORMATION_SCHEMA.VIEWS
            WHERE TABLE_NAME IN (${list})`.replace(/@n(\d+)/g, (_, i) => `'${filter[i]}'`)
        );
        views = r.recordset;
      } else {
        const r = await pool.request().query(
          `SELECT TABLE_SCHEMA, TABLE_NAME
             FROM INFORMATION_SCHEMA.VIEWS
            WHERE TABLE_NAME LIKE '${WHITELIST}'`
        );
        views = r.recordset;
      }
      const names = views.map(v => v.TABLE_NAME);
      if (!names.length) {
        return { 
          status: 200, 
          jsonBody: { 
            tables: [], 
            common_queries: getCommonQueryTemplates(),
            generated_at_utc: new Date().toISOString(), 
            notes: `Views matching ${WHITELIST}` 
          } 
        };
      }

      const inList = names.map(n => `'${n}'`).join(',');
      const columns = await pool.request().query(
        `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE, CHARACTER_MAXIMUM_LENGTH, ORDINAL_POSITION
           FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_NAME IN (${inList})
          ORDER BY TABLE_NAME, ORDINAL_POSITION`
      );

      const pkRows = await pool.request().query(
        `SELECT t.name AS table_name, c.name AS column_name
           FROM sys.indexes i
           JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id
           JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id
           JOIN sys.tables t ON t.object_id=i.object_id
          WHERE i.is_primary_key=1 AND t.name IN (${inList})`
      );

      const fkRows = await pool.request().query(
        `SELECT tp.name AS parent_table, cp.name AS parent_col, tr.name AS ref_table, cr.name AS ref_col
           FROM sys.foreign_keys fk
           JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id=fk.object_id
           JOIN sys.tables tp ON tp.object_id=fkc.parent_object_id
           JOIN sys.columns cp ON cp.object_id=fkc.parent_object_id AND cp.column_id=fkc.parent_column_id
           JOIN sys.tables tr ON tr.object_id=fkc.referenced_object_id
           JOIN sys.columns cr ON cr.object_id=fkc.referenced_object_id AND cr.column_id=fkc.referenced_column_id
          WHERE tp.name IN (${inList}) AND tr.name IN (${inList})`
      );

      const pkMap = {};
      pkRows.recordset.forEach(r => { (pkMap[r.table_name] ??= new Set()).add(r.column_name); });

      const fkMap = {};
      fkRows.recordset.forEach(r => {
        (fkMap[r.parent_table] ??= []).push({ column: r.parent_col, ref_table: r.ref_table, ref_column: r.ref_col });
      });

      const colMap = {};
      columns.recordset.forEach(r => {
        (colMap[r.TABLE_NAME] ??= []).push({
          name: r.COLUMN_NAME,
          type: r.DATA_TYPE,
          nullable: r.IS_NULLABLE === 'YES',
          ...(r.CHARACTER_MAXIMUM_LENGTH ? { max_len: r.CHARACTER_MAXIMUM_LENGTH } : {})
        });
      });

      const tables = names.map(n => ({
        name: n,
        description: getTableDescription(n),
        columns: (colMap[n] || []).map(c => ({ 
          ...c, 
          pk: pkMap[n]?.has(c.name) || false,
          description: getColumnDescription(n, c.name)
        })),
        fks: fkMap[n] || [],
        sample_joins: getSampleJoins(n, fkMap[n])
      }));

      return { 
        status: 200, 
        jsonBody: { 
          tables, 
          common_queries: getCommonQueryTemplates(),
          generated_at_utc: new Date().toISOString(), 
          notes: `Views matching ${WHITELIST}` 
        } 
      };
    } catch (err) {
      ctx.error(err);
      return { status: 500, jsonBody: { error: err.message || String(err) } };
    }
  }
});
```

#### src/functions/sqlQuery.js
```javascript
import { app } from '@azure/functions';
import { runQuery } from '../lib/db.js';
import { validateSelectOnly, injectTopLimit, toTediousNamedParams } from '../lib/sqlSafety.js';

const ROW_LIMIT_DEFAULT = parseInt(process.env.ROW_LIMIT_DEFAULT || '200', 10);

app.http('sql-query', {
  methods: ['POST'],
  authLevel: 'function',
  route: 'sql-query',
  handler: async (req, ctx) => {
    const startTime = Date.now();
    try {
      const body = await req.json();
      let { sql, params, row_limit } = body || {};
      if (!sql || typeof sql !== 'string') {
        return { status: 400, jsonBody: { error: 'Body.sql (string) is required.' } };
      }
      params = params || {};
      const limit = Math.max(1, Math.min(parseInt(row_limit || ROW_LIMIT_DEFAULT, 10), 5000));

      sql = validateSelectOnly(sql);
      sql = injectTopLimit(sql, limit);
      sql = toTediousNamedParams(sql); // turn :p1 into @p1

      const result = await runQuery(sql, params);
      const columns = result.recordset.columns ? Object.keys(result.recordset.columns) : (result.recordset[0] ? Object.keys(result.recordset[0]) : []);
      const rows = result.recordset.map(r => columns.map(c => r[c]));

      // Log for audit (truncate SQL for security)
      ctx.log('SQL Query Executed', {
        sql: sql.substring(0, 200),
        row_count: rows.length,
        execution_time_ms: Date.now() - startTime,
        user: req.headers['x-ms-client-principal-name'] || 'anonymous',
        source: req.headers['user-agent']?.includes('Connectory') ? 'Copilot Studio via Connectory' : 'Direct'
      });

      return {
        status: 200,
        jsonBody: {
          columns,
          rows,
          row_count: rows.length,
          sql_used: sql,
          execution_time_ms: Date.now() - startTime,
          notes: rows.length >= limit ? `Truncated to TOP(${limit}).` : undefined
        }
      };
    } catch (err) {
      ctx.error(err);
      ctx.log('SQL Query Error', {
        error: err.message,
        execution_time_ms: Date.now() - startTime
      });
      return { status: 500, jsonBody: { error: err.message || String(err) } };
    }
  }
});
```

#### src/app.js
```javascript
// Ensures env is loaded locally; Azure ignores .env and uses App Settings.
import 'dotenv/config';
import './functions/sqlSchema.js';
import './functions/sqlQuery.js';
```

## Deployment Scripts

### scripts/deploy_infra.sh
```bash
#!/usr/bin/env bash
set -euo pipefail

# Usage: ./scripts/deploy_infra.sh <rg> <location> <appname> <storage>
# Example: ./scripts/deploy_infra.sh rg-ai-dev westeurope ai-sql-tools-dev staisqltoolsdev123

RG=${1:?rg}; LOC=${2:?location}; APP=${3:?func app name}; SA=${4:?storage account name}

echo ">> Creating resource group"
az group create -n "$RG" -l "$LOC" >/dev/null

echo ">> Creating storage account (GPv2)"
az storage account create -g "$RG" -n "$SA" -l "$LOC" --sku Standard_LRS --kind StorageV2 >/dev/null

echo ">> Creating Function App (Linux, Consumption, Node 20)"
az functionapp create \
  --resource-group "$RG" \
  --consumption-plan-location "$LOC" \
  --runtime node --runtime-version 20 \
  --functions-version 4 \
  --name "$APP" \
  --storage-account "$SA" >/dev/null

echo ">> Enabling system-assigned managed identity"
az functionapp identity assign -g "$RG" -n "$APP" >/dev/null
MI_PRINCIPAL_ID=$(az functionapp identity show -g "$RG" -n "$APP" --query principalId -o tsv)
echo "   MI principalId: $MI_PRINCIPAL_ID"

echo ">> Setting app settings (edit SQL_* before you run or set after)"
az functionapp config appsettings set -g "$RG" -n "$APP" --settings \
  SCM_DO_BUILD_DURING_DEPLOYMENT=true \
  SQL_SERVER="${SQL_SERVER:-REPLACE.database.windows.net}" \
  SQL_DATABASE="${SQL_DATABASE:-REPLACE}" \
  SCHEMA_WHITELIST="${SCHEMA_WHITELIST:-vw%}" \
  ROW_LIMIT_DEFAULT="${ROW_LIMIT_DEFAULT:-200}" \
  TZ="${TZ:-UTC}" \
  NODE_ENV="production" >/dev/null

cat <<EOF

NEXT STEPS (manual, required):
1) In Azure SQL:
   - Create an AAD user for the Function's Managed Identity and grant read-only:
     CREATE USER [$APP] FROM EXTERNAL PROVIDER;
     ALTER ROLE db_datareader ADD MEMBER [$APP];

2) SQL Server Networking:
   - For dev: enable "Allow Azure services and resources to access this server".
   - For prod: consider Private Endpoint.

3) Deploy code: ./scripts/deploy_func.sh $RG $APP
EOF
```

### scripts/deploy_func.sh
```bash
#!/usr/bin/env bash
set -euo pipefail

# Usage: ./scripts/deploy_func.sh <rg> <appname>
RG=${1:?rg}; APP=${2:?func app name}

echo ">> Installing deps (production)"
npm ci --omit=dev

echo ">> Creating deployment package"
ZIP=package.zip
rm -f "$ZIP"
zip -r "$ZIP" . -x "*.git*" "node_modules/*" ".vscode/*" "package-lock.json" "*.env" >/dev/null

echo ">> Zip deploy (remote build by Oryx)"
az functionapp deployment source config-zip -g "$RG" -n "$APP" --src "$ZIP" >/dev/null

echo ">> Getting function key"
KEY=$(az functionapp function keys list -g "$RG" -n "$APP" --function-name "sql-schema" --query "default" -o tsv 2>/dev/null || echo "<FUNCTION_KEY>")

echo ">> Done. Test endpoints:"
echo "GET  https://$APP.azurewebsites.net/api/sql-schema?code=$KEY"
echo "POST https://$APP.azurewebsites.net/api/sql-query?code=$KEY"
```

## Testing

### Local Testing
```bash
# Terminal 1
npm install
func start

# Terminal 2
curl http://localhost:7071/api/sql-schema | jq

curl -X POST http://localhost:7071/api/sql-query \
  -H "Content-Type: application/json" \
  -d '{"sql":"SELECT TOP(5) UserId, CreatedAt FROM vwUsers ORDER BY CreatedAt DESC"}' | jq

curl -X POST http://localhost:7071/api/sql-query \
  -H "Content-Type: application/json" \
  -d '{"sql":"SELECT COUNT(*) as total FROM vwUsers WHERE CreatedAt >= :start_date", "params":{"start_date":"2024-01-01"}}' | jq
```

## Copilot Studio Integration

### Architecture Flow
```
User Question → Copilot Studio → Connectory → Function App → Azure SQL
                                    ↓
User Answer ← Copilot Studio ← Connectory ← Function Response
```

**Connectory** acts as the middleware layer that:
- Receives requests from Copilot Studio
- Handles authentication and routing to Function App endpoints  
- Transforms responses back to Copilot Studio format
- Manages function keys and endpoint URLs for the Function App

### Connectory Configuration
For Connectory to call the Function App endpoints, configure:
- **Function App URL**: `https://<app-name>.azurewebsites.net`
- **Schema Endpoint**: `/api/sql-schema`
- **Query Endpoint**: `/api/sql-query`  
- **Authentication**: Function key (from deployment script output)

### System Instructions for Copilot Studio
```
When users ask data questions:
1. First call sql_schema (via Connectory) to understand available tables and get query templates
2. Generate SQL using only the tables/columns returned
3. Use parameterized queries with :param syntax for any user-provided values
4. Call sql_query (via Connectory) with the generated SQL
5. Format results in a user-friendly way

Guidelines:
- Always use parameterized queries for safety
- Prefer aggregations over large result sets
- Default to UTC for date calculations unless specified
- Use the common_queries templates when applicable
- Explain what data you're retrieving before showing results
```

### Few-Shot Examples for Copilot
```
User: "How many users signed up yesterday?"
SQL: SELECT COUNT(*) as count FROM vwUsers WHERE CAST(CreatedAt as DATE) = CAST(DATEADD(day, -1, GETUTCDATE()) as DATE)

User: "Show me top 5 countries by users"
SQL: SELECT TOP(5) Country, COUNT(*) as user_count FROM vwUsers GROUP BY Country ORDER BY user_count DESC

User: "Total revenue this month"
SQL: SELECT SUM(Amount) as total_revenue FROM vwOrders WHERE CreatedAt >= DATEADD(month, DATEDIFF(month, 0, GETUTCDATE()), 0)

User: "Users who signed up after January 2024"
SQL: SELECT COUNT(*) as count FROM vwUsers WHERE CreatedAt >= :start_date
Params: {"start_date": "2024-01-01"}
```

## Security Reminders

- ✅ Create the DB reader (AAD user) for the Function App's Managed Identity
- ✅ Whitelist only views you're comfortable exposing (prefix `vw`)
- ✅ No secrets in code; everything from App Settings / MI
- ✅ Log carefully: redact parameter values if they may contain PII  
- ✅ Keep limits: default TOP(200), max 5000; don't stream megabytes to Copilot Studio
- ✅ Function keys managed securely in Connectory configuration
- ✅ Monitor requests: should see user context from Copilot Studio in headers
- ✅ Regular security audits of exposed views and query patterns

## Definition of Done

- [ ] Infra script runs cleanly and prints MI principalId + next steps
- [ ] Code deploy script publishes and endpoints return correct JSON
- [ ] `sql_schema` returns expected views from the sample DB
- [ ] `sql_query` rejects non‑SELECT and executes parameterized SELECTs
- [ ] Query logging works and shows in Application Insights
- [ ] Copilot Studio → Connectory → Function App path answers:
  - "How many users do we have in total?"
  - "How many signed up yesterday?"
  - "Top 5 countries by users"
  - "What's our revenue trend this week?"
- [ ] Error handling returns appropriate messages
- [ ] Performance: queries complete in <2 seconds for typical workloads