# SQL Tools Function App

Node.js Azure Functions app exposing two endpoints for safe, parameterized read-only SQL access for agents.

## Endpoints
- GET/POST `/api/sql-schema` — returns allowed views, columns, PKs/FKs, sample joins, and common query templates
- POST `/api/sql-query` — validates SELECT-only T-SQL, injects TOP limit, binds params, returns rows

## Local Setup
1. Install Azure Functions Core Tools and Azure CLI.
2. From this folder:
   ```bash
   npm install
   func start
   ```
3. In another terminal, test:
   ```bash
   npm run test:schema
   npm run test:query
   ```

Configure `local.settings.json` values for your SQL if needed. For dev, you can set `SQL_CONNECTION_STRING` and `NODE_ENV=development`.

## Env/App Settings
- `SQL_SERVER` — `<server>.database.windows.net`
- `SQL_DATABASE` — database name
- `SCHEMA_WHITELIST` — pattern for views to expose (e.g., `vw%`)
- `ROW_LIMIT_DEFAULT` — default row cap (e.g., 200)
- `TZ` — `UTC`
- `NODE_ENV` — `development` locally, `production` in Azure

## Deploy Infra (Azure)
```bash
./scripts/deploy_infra.sh <rg> <location> <appname> <storage>
```
Then in Azure SQL (database):
```sql
CREATE USER [<func-app-name>] FROM EXTERNAL PROVIDER;
ALTER ROLE db_datareader ADD MEMBER [<func-app-name>];
```
Enable "Allow Azure services…" for dev, or use Private Endpoints for prod.

## Deploy Code
```bash
./scripts/deploy_func.sh <rg> <appname>
```
The script prints test URLs with function key.

## Notes
- Only SELECT is allowed; banned keywords/comments are filtered.
- TOP(n) is injected if missing; default `ROW_LIMIT_DEFAULT`, max 5000.
- Params use `:name` in SQL and are bound as `@name` to mssql.
- Queries are logged with execution time and row counts.

