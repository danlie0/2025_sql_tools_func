import { app } from '@azure/functions';
import { getPool } from '../lib/db.js';
import sql from 'mssql';
import { getTableDescription, getColumnDescription, getCommonQueryTemplates, getSampleJoins } from '../lib/schemaHelpers.js';

const VIEW_WHITELIST = process.env.SCHEMA_WHITELIST || 'vw%';
const OBJECT_TYPES_DEFAULT = (process.env.SCHEMA_OBJECT_TYPES || 'both').toLowerCase(); // views|tables|both
const OBJECT_ALLOWLIST = (process.env.OBJECT_ALLOWLIST || '')
  .split(',').map(s => s.trim()).filter(Boolean); // schema.name or schema.*
const INCLUDE_TYPES = (process.env.SCHEMA_INCLUDE_TYPES || 'tables,views').toLowerCase();
const EXCLUDE_SCHEMAS = (process.env.SCHEMA_EXCLUDE_SCHEMAS || 'sys,INFORMATION_SCHEMA,cdc')
  .split(',').map(s => s.trim()).filter(Boolean);

app.http('sql-schema', {
  methods: ['GET','POST'],
  authLevel: 'function',
  route: 'sql-schema',
  handler: async (req, ctx) => {
    try {
      const body = await (req.method === 'POST' ? req.json().catch(() => ({})) : {});
      const headerGetter = req.headers && typeof req.headers.get === 'function' ? (k => req.headers.get(k)) : (k => req.headers?.[k]);
      const headerMode = headerGetter('x-schema-object-types') || headerGetter('X-Schema-Object-Types') || undefined;
      const mode = (headerMode || body?.object_types || OBJECT_TYPES_DEFAULT).toLowerCase();

      const clientFilter = Array.isArray(body?.tables) ? body.tables : null; // schema-qualified

      const pool = await getPool();
      const objects = [];
      let usingCatalogFallback = false;

      // Views via whitelist pattern
      if (mode === 'views' || mode === 'both') {
        const q = `
          SELECT TABLE_SCHEMA, TABLE_NAME
          FROM INFORMATION_SCHEMA.VIEWS
          WHERE TABLE_NAME LIKE @vwPattern
        `;
        const r = await pool.request()
          .input('vwPattern', sql.NVarChar(128), VIEW_WHITELIST)
          .query(q);
        r.recordset.forEach(v => objects.push({ schema: v.TABLE_SCHEMA, name: v.TABLE_NAME, type: 'VIEW' }));
      }

      // Tables via allow-list (env or request) - supports wildcards like SalesLT.*
      if ((mode === 'tables' || mode === 'both') && (OBJECT_ALLOWLIST.length || clientFilter?.length)) {
        const allow = clientFilter?.length ? clientFilter : OBJECT_ALLOWLIST;
        const reqTables = pool.request();
        allow.forEach((qn, i) => {
          const [sch, nm] = qn.split('.');
          reqTables.input(`s${i}`, sql.NVarChar(128), sch);
          // Convert * to % for SQL LIKE, otherwise exact match
          if (nm === '*') {
            reqTables.input(`n${i}`, sql.NVarChar(128), '%');
          } else {
            reqTables.input(`n${i}`, sql.NVarChar(128), nm);
          }
        });
        const ors = allow.map((qn, i) => {
          const [sch, nm] = qn.split('.');
          // Use LIKE for wildcards, = for exact matches
          return nm === '*' 
            ? `(t.TABLE_SCHEMA = @s${i} AND t.TABLE_NAME LIKE @n${i})`
            : `(t.TABLE_SCHEMA = @s${i} AND t.TABLE_NAME = @n${i})`;
        }).join(' OR ');
        const q = `
          SELECT t.TABLE_SCHEMA, t.TABLE_NAME
          FROM INFORMATION_SCHEMA.TABLES t
          WHERE t.TABLE_TYPE='BASE TABLE' AND (${ors})
        `;
        const r = await reqTables.query(q);
        r.recordset.forEach(t => objects.push({ schema: t.TABLE_SCHEMA, name: t.TABLE_NAME, type: 'TABLE' }));
      }

      // Catalog fallback: no allow-list provided → include user tables/views, exclude system schemas
      if ((mode === 'tables' || mode === 'both' || mode === 'views') && objects.length === 0) {
        const includeTables = INCLUDE_TYPES.includes('tables');
        const includeViews  = INCLUDE_TYPES.includes('views');
        const typePreds = [];
        if (includeTables) typePreds.push("o.type = 'U'");
        if (includeViews)  typePreds.push("o.type = 'V'");
        if (!typePreds.length) typePreds.push('1=0');

        const reqObj = pool.request();
        EXCLUDE_SCHEMAS.forEach((s, i) => reqObj.input(`xs${i}`, sql.NVarChar(128), s));
        const exPh = EXCLUDE_SCHEMAS.map((_, i) => `@xs${i}`).join(',');
        const q = `
          SELECT s.name AS schema_name, o.name AS object_name, o.type
          FROM sys.objects o
          JOIN sys.schemas s ON s.schema_id = o.schema_id
          WHERE (${typePreds.join(' OR ')})
            AND o.is_ms_shipped = 0
            ${EXCLUDE_SCHEMAS.length ? `AND s.name NOT IN (${exPh})` : ''}
          ORDER BY s.name, o.name
        `;
        const r = await reqObj.query(q);
        r.recordset.forEach(row => {
          const kind = row.type === 'U' ? 'TABLE' : 'VIEW';
          objects.push({ schema: row.schema_name, name: row.object_name, type: kind });
        });
        usingCatalogFallback = true;
      }

      if (objects.length === 0) {
        return {
          status: 200,
          jsonBody: {
            tables: [],
            common_queries: getCommonQueryTemplates(),
            generated_at_utc: new Date().toISOString(),
            notes: `Mode=${mode}; views LIKE ${VIEW_WHITELIST}; tables from allow-list`
          }
        };
      }

      const qnames = objects.map(o => `${o.schema}.${o.name}`);

      // COLUMNS for schema-qualified names
      const reqCols = pool.request();
      qnames.forEach((qn, i) => reqCols.input(`q${i}`, sql.NVarChar(256), qn));
      const colOrs = qnames.map((_, i) => `(TABLE_SCHEMA + '.' + TABLE_NAME) = @q${i}`).join(' OR ');
      const columns = await reqCols.query(`
        SELECT TABLE_SCHEMA + '.' + TABLE_NAME AS qn,
               COLUMN_NAME, DATA_TYPE, IS_NULLABLE, CHARACTER_MAXIMUM_LENGTH, ORDINAL_POSITION
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE ${colOrs}
        ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
      `);

      // PKs by schema+table
      const reqPk = pool.request();
      qnames.forEach((qn, i) => {
        const [s, n] = qn.split('.');
        reqPk.input(`ps${i}`, sql.NVarChar(128), s);
        reqPk.input(`pn${i}`, sql.NVarChar(128), n);
      });
      const pkOrs = qnames.map((_, i) => `(s.name=@ps${i} AND t.name=@pn${i})`).join(' OR ');
      const pkRows = await reqPk.query(`
        SELECT s.name AS schema_name, t.name AS table_name, c.name AS column_name
        FROM sys.tables t
        JOIN sys.schemas s ON s.schema_id = t.schema_id
        JOIN sys.indexes i ON i.object_id = t.object_id AND i.is_primary_key=1
        JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id
        JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id
        WHERE ${pkOrs}
      `);

      // FKs (parent side filtered)
      const reqFk = pool.request();
      qnames.forEach((qn, i) => {
        const [s, n] = qn.split('.');
        reqFk.input(`fs${i}`, sql.NVarChar(128), s);
        reqFk.input(`fn${i}`, sql.NVarChar(128), n);
      });
      const fkOrs = qnames.map((_, i) => `(sp.name=@fs${i} AND tp.name=@fn${i})`).join(' OR ');
      const fkRows = await reqFk.query(`
        SELECT sp.name AS parent_schema, tp.name AS parent_table, cp.name AS parent_col,
               sr.name AS ref_schema,   tr.name AS ref_table,   cr.name AS ref_col
        FROM sys.foreign_keys fk
        JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id=fk.object_id
        JOIN sys.tables tp ON tp.object_id=fkc.parent_object_id
        JOIN sys.schemas sp ON sp.schema_id = tp.schema_id
        JOIN sys.columns cp ON cp.object_id=fkc.parent_object_id AND cp.column_id=fkc.parent_column_id
        JOIN sys.tables tr ON tr.object_id=fkc.referenced_object_id
        JOIN sys.schemas sr ON sr.schema_id = tr.schema_id
        JOIN sys.columns cr ON cr.object_id=fkc.referenced_object_id AND cr.column_id=fkc.referenced_column_id
        WHERE ${fkOrs}
      `);

      // Maps
      const pkMap = {};
      pkRows.recordset.forEach(r => { (pkMap[`${r.schema_name}.${r.table_name}`] ??= new Set()).add(r.column_name); });

      const fkMap = {};
      fkRows.recordset.forEach(r => {
        const key = `${r.parent_schema}.${r.parent_table}`;
        (fkMap[key] ??= []).push({ column: r.parent_col, ref_table: `${r.ref_schema}.${r.ref_table}`, ref_column: r.ref_col });
      });

      const colMap = {};
      columns.recordset.forEach(r => {
        (colMap[r.qn] ??= []).push({
          name: r.COLUMN_NAME,
          type: r.DATA_TYPE,
          nullable: r.IS_NULLABLE === 'YES',
          ...(r.CHARACTER_MAXIMUM_LENGTH ? { max_len: r.CHARACTER_MAXIMUM_LENGTH } : {})
        });
      });

      const tables = qnames.map(qn => {
        const bare = qn.split('.')[1];
        return {
          name: qn,
          description: getTableDescription(bare),
          columns: (colMap[qn] || []).map(c => ({
            ...c,
            pk: pkMap[qn]?.has(c.name) || false,
            description: getColumnDescription(bare, c.name)
          })),
          fks: fkMap[qn] || [],
          sample_joins: getSampleJoins(qn, fkMap[qn])
        };
      });

      return {
        status: 200,
        jsonBody: {
          tables,
          common_queries: getCommonQueryTemplates(),
          generated_at_utc: new Date().toISOString(),
          notes: usingCatalogFallback
            ? `Included: ${INCLUDE_TYPES}; Excluded schemas: ${EXCLUDE_SCHEMAS.join(',')}`
            : `Mode=${mode}; views LIKE ${VIEW_WHITELIST}; tables from allow-list`
        }
      };
    } catch (err) {
      ctx.log.error(err);
      return { status: 500, jsonBody: { error: err.message || String(err) } };
    }
  }
});

