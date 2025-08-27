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
      // Return rows as array of objects keyed by column name for Copilot table coercion
      const rows = result.recordset.map(r => {
        const obj = {};
        for (const c of columns) obj[c] = r[c];
        return obj;
      });

      // Log for audit (truncate SQL for security)
      ctx.log('SQL Query Executed', {
        sql: sql.substring(0, 200),
        row_count: rows.length,
        execution_time_ms: Date.now() - startTime,
        user: req.headers['x-ms-client-principal-name'] || 'anonymous'
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
      ctx.log.error(err);
      ctx.log('SQL Query Error', {
        error: err.message,
        execution_time_ms: Date.now() - startTime
      });
      return { status: 500, jsonBody: { error: err.message || String(err) } };
    }
  }
});

