### SQL Tools Function API — Usage

This Azure Functions app exposes two HTTP endpoints for safe, read‑only access to Azure SQL.

- Base URL (local): `http://localhost:7071`
- Base URL (prod): `https://<your-func-app>.azurewebsites.net`
- All responses are JSON.

### Authentication
- Local development: no key required by default.
- Azure: include the function key header `x-functions-key: <key>`.

### Endpoints
- `GET /api/sql-schema` — Discover allowed objects and query templates.
- `POST /api/sql-schema` — Same as GET, with optional filters/body.
- `POST /api/sql-query` — Execute parameterized SELECT queries with enforced row limits.

---

### GET /api/sql-schema
Returns a summary of whitelisted views and optionally allow‑listed tables, with columns, PKs/FKs, sample joins, and common query templates.

Optional header:
- `x-schema-object-types: views|tables|both` (defaults from server setting)

Example (local):
```bash
curl -s http://localhost:7071/api/sql-schema | jq
```

### POST /api/sql-schema
Same as GET, with extra options via JSON body.

Body (all fields optional):
```json
{
  "object_types": "views|tables|both",
  "tables": ["schema.table", "schema.other_table"]
}
```

Notes:
- Views are returned if their names match `SCHEMA_WHITELIST` (e.g., `vw%`).
- Tables are returned only if in the allow‑list: either server `OBJECT_ALLOWLIST` or this request body `tables`.

Response shape (abbrev):
```json
{
  "tables": [
    {
      "name": "SalesLT.Customer",
      "description": "...",
      "columns": [ { "name": "CustomerID", "type": "int", "pk": true, "nullable": false } ],
      "fks": [ { "column": "...", "ref_table": "...", "ref_column": "..." } ],
      "sample_joins": [ { "description": "...", "template": "SELECT ... JOIN ..." } ]
    }
  ],
  "common_queries": [ { "description": "Row count for a table", "template": "SELECT COUNT(*) AS total FROM <schema.table>" } ],
  "generated_at_utc": "2025-08-27T00:00:00.000Z",
  "notes": "Mode=both; views LIKE vw%; tables from allow-list"
}
```

---

### POST /api/sql-query
Execute a safe, parameterized SELECT. The server validates and, if needed, injects a `TOP(n)` limit. Named params use `:name` syntax in your SQL and are bound as SQL Server parameters.

Body:
```json
{
  "sql": "SELECT * FROM SalesLT.Customer WHERE CustomerID = :id",
  "params": { "id": 42 },
  "row_limit": 200
}
```

Important rules enforced server‑side:
- Only `SELECT` statements are allowed; all other DDL/DML and comment markers are rejected.
- Banned tokens include: `delete|insert|update|merge|alter|drop|create|grant|revoke|truncate|exec|execute|xp_|sp_`, semicolons `;`, line/block comments `-- /* */`.
- If your SQL lacks `TOP`, the server injects `TOP(n)` right after `SELECT` using `row_limit` (default from env, max 5000).
- `:name` placeholders are converted to `@name` and bound with types inferred from values.

Example (local):
```bash
curl -s -X POST \
  http://localhost:7071/api/sql-query \
  -H 'Content-Type: application/json' \
  -d '{
        "sql":"SELECT * FROM SalesLT.Customer WHERE CustomerID = :id",
        "params": { "id": 1 },
        "row_limit": 100
      }' | jq
```

Example (Azure):
```bash
curl -s -X POST \
  https://<your-func-app>.azurewebsites.net/api/sql-query \
  -H 'x-functions-key: <key>' \
  -H 'Content-Type: application/json' \
  -d '{"sql":"SELECT TOP(:n) * FROM SalesLT.Customer ORDER BY CustomerID","params":{"n":10}}'
```

Response shape:
```json
{
  "columns": ["CustomerID", "FirstName", "LastName"],
  "rows": [ { "CustomerID": 1, "FirstName": "A", "LastName": "B" } ],
  "row_count": 1,
  "sql_used": "SELECT TOP(10) ...",
  "execution_time_ms": 12,
  "notes": "Truncated to TOP(100)."
}
```

Errors:
- `400` if `sql` is missing or not a string.
- `500` with `{ "error": "..." }` for validation or execution failures (e.g., banned keywords).

---

### Parameter Binding Details
- Use `:name` placeholders in your SQL; provide values in `params`.
- Types are inferred: integer → `Int`, float → `Float`, `Date` → `DateTime2`, boolean → `Bit`, others → `NVarChar(max)`.
- Example with multiple params:
```json
{
  "sql": "SELECT * FROM SalesLT.SalesOrderHeader WHERE CustomerID = :id AND TotalDue >= :minTotal",
  "params": { "id": 29485, "minTotal": 100.0 }
}
```

### Object Discovery Behavior (`/api/sql-schema`)
- Views: returned when `TABLE_NAME LIKE SCHEMA_WHITELIST` (e.g., `vw%`).
- Tables: returned only if whitelisted via `OBJECT_ALLOWLIST` (env) or the POST `tables` body list.
- You can force views/tables/both via header `x-schema-object-types` or POST `object_types`.

---

### Environment Settings
Configure via Azure App Settings or `local.settings.json`.

- `SQL_SERVER`: `<server>.database.windows.net`
- `SQL_DATABASE`: Database name
- `SQL_CONNECTION_STRING`: Optional for local dev when `NODE_ENV=development`
- `SCHEMA_WHITELIST`: View name pattern (e.g., `vw%`)
- `SCHEMA_OBJECT_TYPES`: `views|tables|both` (default: `both`)
- `OBJECT_ALLOWLIST`: Comma‑separated `schema.table` list for tables
- `ROW_LIMIT_DEFAULT`: Default row cap (e.g., `200`; max enforced is `5000`)
- `TZ`: `UTC`
- `NODE_ENV`: `development` locally, `production` in Azure

Connection/auth:
- In Azure, a Managed Identity token is used to connect to SQL.
- Grant the function app identity `db_datareader` in the target database.

---

### Local Development Quickstart
```bash
npm install
func start

# In another terminal
npm run test:schema
npm run test:query
```

---

### Tips & Constraints
- Prefer fully schema‑qualified names (e.g., `SalesLT.Customer`).
- If you include your own `TOP(...)`, the server will not inject another.
- When `row_count` equals your effective limit, a `notes` field indicates truncation.
- SQL is logged with truncation (first 200 chars), along with row count and timing.

---

### OpenAPI
An OpenAPI (Swagger 2.0) document is included at `openapi.yaml` describing requests and responses.


