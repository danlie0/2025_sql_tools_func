# SQL Tools Function API — Usage Guide 📊

This Azure Functions app provides **safe, read-only access** to Azure SQL databases through two HTTP endpoints.

## 🌐 Production URL
**Base URL**: `https://2025-sql-tools-func.azurewebsites.net`

All responses are in JSON format.

## 🔐 Authentication
**Required**: Include the function key header in all requests:
```
x-functions-key: <your-function-key>
```

## 📋 Available Endpoints

### 1. **GET** `/api/sql-schema` 
**Purpose**: Discover database structure, tables, views, columns, and relationships

**Headers** (optional):
- `x-schema-object-types`: `views` | `tables` | `both` (default: `both`)

**Response**: Database schema information including:
- Tables and views with columns, data types, and constraints
- Primary keys and foreign key relationships  
- Sample join queries
- Common query templates

---

### 2. **POST** `/api/sql-query`
**Purpose**: Execute safe, parameterized SELECT queries

**Body**:
```json
{
  "sql": "SELECT * FROM SalesLT.Customer WHERE CustomerID = :id",
  "params": { "id": 42 },
  "row_limit": 200
}
```

**Parameters**:
- `sql` (required): Your SELECT query using `:name` placeholders
- `params` (optional): Values for the placeholders
- `row_limit` (optional): Maximum rows to return (default: 200, max: 5000)

---

## 🚀 Quick Examples

### Get Database Schema
```bash
curl -s -X GET \
  https://2025-sql-tools-func.azurewebsites.net/api/sql-schema \
  -H 'x-functions-key: <your-key>' | jq
```

### Execute a Query
```bash
curl -s -X POST \
  https://2025-sql-tools-func.azurewebsites.net/api/sql-query \
  -H 'x-functions-key: <your-key>' \
  -H 'Content-Type: application/json' \
  -d '{
    "sql": "SELECT TOP(10) * FROM SalesLT.Customer ORDER BY CustomerID",
    "row_limit": 10
  }' | jq
```

### Query with Parameters
```bash
curl -s -X POST \
  https://2025-sql-tools-func.azurewebsites.net/api/sql-query \
  -H 'x-functions-key: <your-key>' \
  -H 'Content-Type: application/json' \
  -d '{
    "sql": "SELECT * FROM SalesLT.Customer WHERE CustomerID = :id AND TotalDue >= :minTotal",
    "params": { "id": 29485, "minTotal": 100.0 },
    "row_limit": 100
  }' | jq
```

---

## 🛡️ Security Features

### SQL Injection Protection
- **Only SELECT statements allowed** - all other SQL commands are blocked
- **Parameterized queries** - use `:name` placeholders for safe value binding
- **Banned keywords**: `delete`, `insert`, `update`, `merge`, `alter`, `drop`, `create`, `grant`, `revoke`, `truncate`, `exec`, `execute`, `xp_`, `sp_`
- **No comments**: `--` and `/* */` are blocked
- **No semicolons**: `;` is blocked

### Row Limits
- **Default limit**: 200 rows
- **Maximum limit**: 5,000 rows
- **Automatic TOP injection**: If your query doesn't include `TOP()`, the system automatically adds `TOP(limit)`

---

## 📊 Response Formats

### Schema Response (`/api/sql-schema`)
```json
{
  "tables": [
    {
      "name": "SalesLT.Customer",
      "description": "Customer information table",
      "columns": [
        {
          "name": "CustomerID",
          "type": "int",
          "pk": true,
          "nullable": false
        }
      ],
      "fks": [
        {
          "column": "CustomerTypeID",
          "ref_table": "SalesLT.CustomerType",
          "ref_column": "CustomerTypeID"
        }
      ],
      "sample_joins": [
        {
          "description": "Join Customer with CustomerType",
          "template": "SELECT t1.*, t2.* FROM SalesLT.Customer t1 INNER JOIN SalesLT.CustomerType t2 ON t1.CustomerTypeID = t2.CustomerTypeID"
        }
      ]
    }
  ],
  "common_queries": [
    {
      "description": "Row count for a table",
      "template": "SELECT COUNT(*) AS total FROM <schema.table>"
    }
  ],
  "generated_at_utc": "2025-08-27T00:00:00.000Z",
  "notes": "Mode=both; views LIKE vw%; tables from allow-list"
}
```

### Query Response (`/api/sql-query`)
```json
{
  "columns": ["CustomerID", "FirstName", "LastName"],
  "rows": [
    {
      "CustomerID": 1,
      "FirstName": "John",
      "LastName": "Doe"
    }
  ],
  "row_count": 1,
  "sql_used": "SELECT TOP(100) * FROM SalesLT.Customer WHERE CustomerID = @id",
  "execution_time_ms": 45,
  "notes": "Truncated to TOP(100)."
}
```

---

## 🔧 Configuration

The system uses these environment variables (configured in Azure App Settings):

| Setting | Description | Default |
|---------|-------------|---------|
| `SCHEMA_WHITELIST` | View name pattern (e.g., `vw%`) | `vw%` |
| `SCHEMA_OBJECT_TYPES` | Objects to return: `views` \| `tables` \| `both` | `both` |
| `OBJECT_ALLOWLIST` | Comma-separated list of allowed tables (e.g., `SalesLT.Customer,SalesLT.Product`) | Empty |
| `ROW_LIMIT_DEFAULT` | Default row limit for queries | `200` |
| `SCHEMA_EXCLUDE_SCHEMAS` | Schemas to exclude (e.g., `sys,INFORMATION_SCHEMA,cdc`) | `sys,INFORMATION_SCHEMA,cdc` |

---

## 💡 Best Practices

### Query Writing
- **Always use schema-qualified names**: `SalesLT.Customer` not just `Customer`
- **Use parameters**: `:id` instead of hardcoded values
- **Include TOP()**: Add `TOP(100)` to control result size
- **Test with small limits first**: Start with `row_limit: 10`

### Error Handling
- **Check status codes**: 200 = success, 400 = bad request, 500 = server error
- **Read error messages**: The `error` field contains helpful details
- **Validate SQL**: Ensure your query is SELECT-only with no banned keywords

### Performance
- **Limit results**: Use appropriate `row_limit` values
- **Indexed columns**: Query on indexed columns for better performance
- **Avoid SELECT ***: Specify only needed columns

---

## 🚨 Common Issues & Solutions

| Issue | Cause | Solution |
|-------|-------|----------|
| `400 Bad Request` | Missing `sql` parameter or invalid SQL | Check request body and SQL syntax |
| `500 Internal Server Error` | Banned keywords or invalid SQL | Remove banned keywords, ensure SELECT-only |
| Empty results | No matching data or invalid table names | Verify table names and schema |
| Slow queries | Large result sets or missing indexes | Add `TOP()` and check query performance |

---

## 📚 Additional Resources

- **OpenAPI Spec**: Available at `/openapi.yaml`
- **Database Connection**: Uses Azure Managed Identity for secure access
- **Logging**: All queries are logged (SQL truncated to 200 chars for security)
- **Timezone**: All timestamps are in UTC

---

## 🔍 Need Help?

If you encounter issues:
1. Check the error message in the response
2. Verify your function key is correct
3. Ensure your SQL follows the security rules
4. Check that table/view names exist in your database

**Remember**: This is a read-only API designed for safe data exploration and reporting! 📊✨


