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
    { description: "Row count for a table", template: "SELECT COUNT(*) AS total FROM <schema.table>" },
    { description: "Preview rows", template: "SELECT TOP(:limit) * FROM <schema.table> ORDER BY 1" },
    { description: "Count by a column", template: "SELECT <column>, COUNT(*) AS cnt FROM <schema.table> GROUP BY <column> ORDER BY cnt DESC" }
  ];
}

/** Get sample joins for common relationships */
export function getSampleJoins(tableName, fks) {
  if (!fks || fks.length === 0) return [];
  
  return fks.slice(0, 2).map(fk => {
    const refTableWithSchema = fk.ref_table.includes('.') ? fk.ref_table : `SalesLT.${fk.ref_table}`;
    return {
      description: `Join ${tableName} with ${refTableWithSchema}`,
      template: `SELECT t1.*, t2.* FROM ${tableName} t1 INNER JOIN ${refTableWithSchema} t2 ON t1.${fk.column} = t2.${fk.ref_column}`
    };
  });
}

