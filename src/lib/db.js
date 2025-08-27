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

