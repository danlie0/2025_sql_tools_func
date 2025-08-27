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
  // Check for both TOP(n) and TOP n syntax
  const hasTop = /\bselect\s+top\s*(\(|\d)/i.test(sql);
  if (hasTop) return sql;
  return sql.replace(/^(\s*select\s+)/i, `$1TOP(${n}) `);
}

/** Convert named params style :p1 to @p1 (tedious/mssql named binder). */
export function toTediousNamedParams(sql) {
  return sql.replace(/:([A-Za-z_]\w*)/g, '@$1');
}

