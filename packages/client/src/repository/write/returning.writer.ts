// VA-ORM — Portable "write and return rows" executor
//
// Postgres/SQLite can return the affected rows from the write statement itself
// (`RETURNING *`). MySQL cannot, so this module re-reads rows by primary key /
// unique key after the write. Repository, NestedWriter and BatchRepository all
// go through here instead of hardcoding `RETURNING`.

import type { DatabaseDriver } from '../../core/types.js';
import { quoteColumn, quoteTable } from '../../relation/quote.js';
import { incomingValueRef, supportsReturning } from './write.dialect.js';

type Row = Record<string, any>;

export interface ReturningWriterOptions {
  /**
   * Primary-key column used to re-read rows on dialects without RETURNING.
   * Defaults to `id`; Repository accepts an override via `primaryKey`.
   */
  primaryKey?: string;
}

export interface UpdateSpec {
  setParts: string[];
  params: any[];
  whereParts: string[];
  whereParams: any[];
  /** Columns written by SET — detects a primary-key change on MySQL. */
  updatedColumns?: string[];
}

export interface WhereSpec {
  whereParts: string[];
  whereParams: any[];
}

export interface UpsertSpec {
  data: Row;
  conflictColumns: string[];
  updateColumns: string[];
}

export class ReturningWriter {
  private readonly primaryKey: string;

  constructor(
    private readonly driver: DatabaseDriver,
    options: ReturningWriterOptions = {},
  ) {
    this.primaryKey = options.primaryKey ?? 'id';
  }

  /** True when the dialect can return written rows in a single statement. */
  supportsReturning(): boolean {
    return supportsReturning(this.driver);
  }

  // ============ INSERT ============

  async insert<T extends Row = Row>(table: string, rows: Row[]): Promise<T[]> {
    if (rows.length === 0) return [];

    const columns = Object.keys(rows[0]);
    const columnKey = columns.slice().sort().join('\u0000');
    for (const row of rows) {
      if (Object.keys(row).sort().join('\u0000') !== columnKey) {
        throw new Error('createMany: all rows must share the same column set');
      }
    }

    return this.supportsReturning()
      ? this.insertReturning<T>(table, columns, rows)
      : this.insertFetch<T>(table, columns, rows);
  }

  private async insertReturning<T>(
    table: string,
    columns: string[],
    rows: Row[],
  ): Promise<T[]> {
    const quotedTable = quoteTable(this.driver, table);
    const quotedColumns = columns.map((c) => quoteColumn(this.driver, c)).join(', ');

    // Stay under the driver's bound-parameter limit: SQLite allows ~999
    // (older) / 32766 (newer) variables; Postgres and MySQL allow 65535.
    const budget = this.driver.getDialect() === 'sqlite' ? 900 : 30_000;
    const rowsPerChunk = Math.max(1, Math.floor(budget / Math.max(columns.length, 1)));

    const results: T[] = [];
    for (let start = 0; start < rows.length; start += rowsPerChunk) {
      const chunk = rows.slice(start, start + rowsPerChunk);
      const params: any[] = [];
      const tuples = chunk.map((row) => {
        const placeholders = columns.map((column) => {
          params.push(row[column]);
          return this.driver.getPlaceholder(params.length);
        });
        return `(${placeholders.join(', ')})`;
      });

      const sql = `INSERT INTO ${quotedTable} (${quotedColumns}) VALUES ${tuples.join(', ')} RETURNING *`;
      const result = await this.driver.query<T>(sql, params);
      results.push(...result.rows);
    }
    return results;
  }

  private async insertFetch<T>(table: string, columns: string[], rows: Row[]): Promise<T[]> {
    const quotedTable = quoteTable(this.driver, table);
    const quotedColumns = columns.map((c) => quoteColumn(this.driver, c)).join(', ');

    const results: T[] = [];
    // One INSERT per row: MySQL's insertId is only reliable for the statement's
    // first generated key, and concurrent writers may interleave generated ids.
    for (const row of rows) {
      const values = columns.map((column) => row[column]);
      const placeholders = values.map((_, i) => this.driver.getPlaceholder(i + 1));
      const sql = `INSERT INTO ${quotedTable} (${quotedColumns}) VALUES (${placeholders.join(', ')})`;

      const meta = await this.driver.execute(sql, values);
      const key = this.insertKey(row, meta.insertId);
      const fetched = await this.selectByPk<T>(table, key);
      if (!fetched) {
        throw new Error(
          `insert(): row not found after INSERT (${this.primaryKey}=${String(key)}). ` +
            `Check RepositoryOptions.primaryKey.`,
        );
      }
      results.push(fetched);
    }
    return results;
  }

  private insertKey(row: Row, insertId?: number | string): number | string {
    const provided = row[this.primaryKey];
    if (provided !== undefined && provided !== null) return provided;
    if (insertId !== undefined && insertId !== null && String(insertId) !== '0') return insertId;
    throw new Error(
      `insert(): dialect without RETURNING (mysql) needs a primary key to re-read the row. ` +
        `Provide "${this.primaryKey}" in the data or set RepositoryOptions.primaryKey.`,
    );
  }

  // ============ UPDATE ============

  async update<T extends Row = Row>(table: string, spec: UpdateSpec): Promise<T[]> {
    const quotedTable = quoteTable(this.driver, table);

    if (this.supportsReturning()) {
      const sql =
        `UPDATE ${quotedTable} SET ${spec.setParts.join(', ')} ` +
        `WHERE ${spec.whereParts.join(' AND ')} RETURNING *`;
      const result = await this.driver.query<T>(sql, [...spec.params, ...spec.whereParams]);
      return result.rows;
    }

    const before = await this.selectWhere<T>(table, spec.whereParts, spec.whereParams);
    if (before.length === 0) return [];

    const sql = `UPDATE ${quotedTable} SET ${spec.setParts.join(', ')} WHERE ${spec.whereParts.join(' AND ')}`;
    await this.driver.execute(sql, [...spec.params, ...spec.whereParams]);

    return this.refreshAfterUpdate(table, before, spec.updatedColumns ?? []);
  }

  // ============ DELETE (soft + hard) ============

  async softDelete<T extends Row = Row>(
    table: string,
    column: string,
    spec: WhereSpec,
  ): Promise<T[]> {
    const quotedTable = quoteTable(this.driver, table);
    const setClause = `${quoteColumn(this.driver, column)} = NOW()`;

    if (this.supportsReturning()) {
      const sql = `UPDATE ${quotedTable} SET ${setClause} WHERE ${spec.whereParts.join(' AND ')} RETURNING *`;
      return (await this.driver.query<T>(sql, spec.whereParams)).rows;
    }

    const before = await this.selectWhere<T>(table, spec.whereParts, spec.whereParams);
    if (before.length === 0) return [];

    await this.driver.execute(
      `UPDATE ${quotedTable} SET ${setClause} WHERE ${spec.whereParts.join(' AND ')}`,
      spec.whereParams,
    );
    return this.refreshAfterUpdate(table, before, [column]);
  }

  async remove<T extends Row = Row>(table: string, spec: WhereSpec): Promise<T[]> {
    const quotedTable = quoteTable(this.driver, table);

    if (this.supportsReturning()) {
      const sql = `DELETE FROM ${quotedTable} WHERE ${spec.whereParts.join(' AND ')} RETURNING *`;
      return (await this.driver.query<T>(sql, spec.whereParams)).rows;
    }

    // Deleted rows cannot be re-read: capture them first.
    const before = await this.selectWhere<T>(table, spec.whereParts, spec.whereParams);
    if (before.length === 0) return [];

    await this.driver.execute(
      `DELETE FROM ${quotedTable} WHERE ${spec.whereParts.join(' AND ')}`,
      spec.whereParams,
    );
    return before;
  }

  // ============ UPSERT ============

  async upsert<T extends Row = Row>(table: string, spec: UpsertSpec): Promise<T> {
    const columns = Object.keys(spec.data);
    const values = Object.values(spec.data);
    const placeholders = values.map((_, i) => this.driver.getPlaceholder(i + 1));
    const quotedTable = quoteTable(this.driver, table);
    const quotedColumns = columns.map((c) => quoteColumn(this.driver, c)).join(', ');

    if (this.supportsReturning()) {
      const conflictClause = spec.conflictColumns
        .map((c) => quoteColumn(this.driver, c))
        .join(', ');
      const updateClause = spec.updateColumns
        .map((col) => `${quoteColumn(this.driver, col)} = EXCLUDED.${quoteColumn(this.driver, col)}`)
        .join(', ');
      const sql =
        `INSERT INTO ${quotedTable} (${quotedColumns}) VALUES (${placeholders.join(', ')}) ` +
        `ON CONFLICT (${conflictClause}) DO UPDATE SET ${updateClause} RETURNING *`;
      return (await this.driver.query<T>(sql, values)).rows[0];
    }

    const updateClause =
      spec.updateColumns.length > 0
        ? spec.updateColumns
            .map((col) => {
              const quoted = quoteColumn(this.driver, col);
              return `${quoted} = ${incomingValueRef(this.driver, col)}`;
            })
            .join(', ')
        : `${quoteColumn(this.driver, this.primaryKey)} = ${quoteColumn(this.driver, this.primaryKey)}`;

    const sql =
      `INSERT INTO ${quotedTable} (${quotedColumns}) VALUES (${placeholders.join(', ')}) ` +
      `ON DUPLICATE KEY UPDATE ${updateClause}`;
    const meta = await this.driver.execute(sql, values);

    const conflictMatch = spec.conflictColumns.every(
      (column) => spec.data[column] !== undefined && spec.data[column] !== null,
    );
    if (conflictMatch) {
      const match: Row = {};
      for (const column of spec.conflictColumns) match[column] = spec.data[column];
      const found = await this.selectByColumns<T>(table, match);
      if (found) return found;
    }

    const key = this.insertKey(spec.data, meta.insertId);
    const found = await this.selectByPk<T>(table, key);
    if (!found) {
      throw new Error(
        `upsert(): row not found after write (${this.primaryKey}=${String(key)}). ` +
          `Check the conflict columns and RepositoryOptions.primaryKey.`,
      );
    }
    return found;
  }

  // ============ FETCH HELPERS ============

  private async refreshAfterUpdate<T extends Row>(
    table: string,
    before: T[],
    updatedColumns: string[],
  ): Promise<T[]> {
    const keys = before.map((row) => row[this.primaryKey]);
    if (updatedColumns.includes(this.primaryKey) || keys.some((key) => key === undefined)) {
      // The key itself moved (or is unknown): the pre-update rows are the only
      // rows we can still address unambiguously.
      return before;
    }
    const after = await this.selectManyByPk<T>(table, keys);
    return after.length > 0 ? after : before;
  }

  private async selectWhere<T>(table: string, whereParts: string[], params: any[]): Promise<T[]> {
    if (whereParts.length === 0) {
      throw new Error('refusing write without WHERE');
    }
    const sql = `SELECT * FROM ${quoteTable(this.driver, table)} WHERE ${whereParts.join(' AND ')}`;
    return (await this.driver.query<T>(sql, params)).rows;
  }

  private async selectByPk<T>(table: string, key: any): Promise<T | null> {
    const sql =
      `SELECT * FROM ${quoteTable(this.driver, table)} ` +
      `WHERE ${quoteColumn(this.driver, this.primaryKey)} = ${this.driver.getPlaceholder(1)} LIMIT 1`;
    const result = await this.driver.query<T>(sql, [key]);
    return result.rows[0] ?? null;
  }

  private async selectByColumns<T>(table: string, match: Row): Promise<T | null> {
    const entries = Object.entries(match);
    const where = entries
      .map(([column], i) => `${quoteColumn(this.driver, column)} = ${this.driver.getPlaceholder(i + 1)}`)
      .join(' AND ');
    const sql = `SELECT * FROM ${quoteTable(this.driver, table)} WHERE ${where} LIMIT 1`;
    const result = await this.driver.query<T>(
      sql,
      entries.map(([, value]) => value),
    );
    return result.rows[0] ?? null;
  }

  private async selectManyByPk<T extends Row>(table: string, keys: any[]): Promise<T[]> {
    if (keys.length === 0) return [];
    const placeholders = keys.map((_, i) => this.driver.getPlaceholder(i + 1)).join(', ');
    const sql =
      `SELECT * FROM ${quoteTable(this.driver, table)} ` +
      `WHERE ${quoteColumn(this.driver, this.primaryKey)} IN (${placeholders})`;
    const rows = (await this.driver.query<T>(sql, keys)).rows;

    // Keep the caller's order (the rows are returned in WHERE-match order).
    const byKey = new Map(rows.map((row) => [String(row[this.primaryKey]), row]));
    return keys.map((key) => byKey.get(String(key))).filter((row): row is T => row !== undefined);
  }
}
