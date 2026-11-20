// VA-ORM — Dialect helpers for write statements
//
// The only dialect differences the write path needs, kept in one place so
// Repository / NestedWriter / ReturningWriter never branch on driver names
// themselves.

import type { DatabaseDriver, SqlDialect } from '../../core/types.js';
import { quoteColumn } from '../../relation/quote.js';

export function writeDialect(driver: DatabaseDriver): SqlDialect {
  return driver.getDialect();
}

/**
 * Postgres and SQLite support `RETURNING`; MySQL (and MariaDB) do not. When
 * false, callers must re-read the affected rows with a follow-up SELECT.
 */
export function supportsReturning(driver: DatabaseDriver): boolean {
  return writeDialect(driver) !== 'mysql';
}

/** `RETURNING *` when the dialect supports it, otherwise an empty string. */
export function returningClause(driver: DatabaseDriver): string {
  return supportsReturning(driver) ? ' RETURNING *' : '';
}

/**
 * Make a row insert idempotent when the key already exists.
 *
 * - Postgres/SQLite: `ON CONFLICT DO NOTHING`
 * - MySQL: no conflict-target syntax, so a no-op `ON DUPLICATE KEY UPDATE`
 *   on the first column is used (`A = A` changes nothing).
 */
export function onConflictDoNothingClause(driver: DatabaseDriver, columns: string[]): string {
  if (writeDialect(driver) !== 'mysql') return 'ON CONFLICT DO NOTHING';
  const column = quoteColumn(driver, columns[0]);
  return `ON DUPLICATE KEY UPDATE ${column} = ${column}`;
}

/**
 * Reference to the value proposed by the INSERT inside an upsert SET clause.
 * Postgres/SQLite: `EXCLUDED."col"`. MySQL: `VALUES(\`col\`)`.
 */
export function incomingValueRef(driver: DatabaseDriver, column: string): string {
  const quoted = quoteColumn(driver, column);
  return writeDialect(driver) === 'mysql' ? `VALUES(${quoted})` : `EXCLUDED.${quoted}`;
}
