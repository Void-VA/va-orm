// VA-ORM — Portable write path spec
//
// Verifies the two write strategies in `repository/write`:
//   • Postgres/SQLite → single statement with `RETURNING *`
//   • MySQL           → write, then re-read by primary/unique key
//
// The MySQL side uses a scripted driver so the emitted SQL can be asserted
// exactly; the RETURNING side runs against a real in-memory SQLite database so
// both the SQL and the round-trip are exercised.

import { describe, it, expect, beforeEach } from 'bun:test';
import { Repository } from '../repository/repository.js';
import { SqliteDriver } from '../drivers/sqlite/sqlite.driver.js';
import type { DatabaseDriver, QueryResult, SqlDialect } from '../core/types.js';

type Row = Record<string, any>;
interface Call {
  sql: string;
  params?: any[];
}

/** MySQL stand-in: records every statement and shifts scripted results. */
class ScriptedMysqlDriver implements DatabaseDriver {
  readonly calls: Call[] = [];
  private results: any[] = [];

  queue(...results: any[]): this {
    this.results.push(...results);
    return this;
  }

  private next(sql: string, params?: any[]): any {
    this.calls.push({ sql, params });
    if (this.results.length === 0) return { rows: [], rowCount: 0 };
    return this.results.shift();
  }

  async query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>> {
    return this.next(sql, params);
  }

  async execute(sql: string, params?: any[]): Promise<{ rowCount: number; insertId?: number }> {
    return this.next(sql, params);
  }

  async transaction<T>(fn: (driver: DatabaseDriver) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async close(): Promise<void> {}

  getPlaceholder(): string {
    return '?';
  }

  getDialect(): SqlDialect {
    return 'mysql';
  }

  sql(): string[] {
    return this.calls.map((call) => call.sql);
  }
}

function mysqlRepository(
  driver: ScriptedMysqlDriver,
  options: { softDelete?: boolean; primaryKey?: string } = {},
): Repository<any> {
  return new Repository(driver, 'users', options);
}

describe('MySQL write path (no RETURNING)', () => {
  let driver: ScriptedMysqlDriver;

  beforeEach(() => {
    driver = new ScriptedMysqlDriver();
  });

  it('create inserts, then re-reads by generated insertId', async () => {
    driver
      .queue({ rowCount: 1, insertId: 42 }) // INSERT
      .queue({ rows: [{ id: 42, name: 'ada' }], rowCount: 1 }); // SELECT

    const row = await mysqlRepository(driver).create({ name: 'ada' });

    expect(row).toEqual({ id: 42, name: 'ada' });
    expect(driver.sql()[0]).toBe('INSERT INTO `users` (`name`) VALUES (?)');
    expect(driver.sql()[0]).not.toContain('RETURNING');
    expect(driver.sql()[1]).toBe('SELECT * FROM `users` WHERE `id` = ? LIMIT 1');
    expect(driver.calls[1].params).toEqual([42]);
  });

  it('create uses an explicit primary key when one is supplied', async () => {
    driver
      .queue({ rowCount: 1, insertId: 0 })
      .queue({ rows: [{ uid: 'u-1', name: 'ada' }], rowCount: 1 });

    const row = await mysqlRepository(driver, { primaryKey: 'uid' }).create({
      uid: 'u-1',
      name: 'ada',
    });

    expect(row).toEqual({ uid: 'u-1', name: 'ada' });
    expect(driver.sql()[1]).toBe('SELECT * FROM `users` WHERE `uid` = ? LIMIT 1');
    expect(driver.calls[1].params).toEqual(['u-1']);
  });

  it('create explains the failure when no key can identify the new row', async () => {
    driver.queue({ rowCount: 1, insertId: 0 });

    await expect(mysqlRepository(driver).create({ name: 'ada' })).rejects.toThrow(
      /needs a primary key to re-read the row/,
    );
  });

  it('createMany writes one row at a time and keeps input order', async () => {
    driver
      .queue({ rowCount: 1, insertId: 1 })
      .queue({ rows: [{ id: 1, name: 'a' }] })
      .queue({ rowCount: 1, insertId: 2 })
      .queue({ rows: [{ id: 2, name: 'b' }] });

    const rows = await mysqlRepository(driver).createMany([{ name: 'a' }, { name: 'b' }]);

    expect(rows).toEqual([
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
    ]);
    expect(driver.sql().filter((sql) => sql.startsWith('INSERT'))).toHaveLength(2);
    expect(driver.sql().filter((sql) => sql.startsWith('SELECT'))).toHaveLength(2);
  });

  it('update pre-selects, writes, then re-selects the affected keys', async () => {
    driver
      .queue({ rows: [{ id: 1, name: 'old' }, { id: 2, name: 'old' }] }) // pre-select
      .queue({ rowCount: 2 }) // UPDATE
      .queue({ rows: [{ id: 1, name: 'new' }, { id: 2, name: 'new' }] }); // re-select

    const row = await mysqlRepository(driver).update({ name: 'old' }, { name: 'new' });

    expect(row).toEqual({ id: 1, name: 'new' });
    expect(driver.sql()[0]).toBe('SELECT * FROM `users` WHERE `name` = ?');
    expect(driver.sql()[1]).toBe('UPDATE `users` SET `name` = ? WHERE `name` = ?');
    expect(driver.sql()[1]).not.toContain('RETURNING');
    expect(driver.sql()[2]).toBe('SELECT * FROM `users` WHERE `id` IN (?, ?)');
    expect(driver.calls[2].params).toEqual([1, 2]);
  });

  it('update returns nothing when the WHERE matches no row', async () => {
    driver.queue({ rows: [] });

    const row = await mysqlRepository(driver).update({ id: 9 }, { name: 'x' });

    expect(row).toBeUndefined();
    expect(driver.sql()).toHaveLength(1);
  });

  it('update that moves the primary key returns the pre-write rows', async () => {
    driver.queue({ rows: [{ id: 1, name: 'a' }] }).queue({ rowCount: 1 });

    const row = await mysqlRepository(driver).update({ id: 1 }, { id: 7 });

    expect(row).toEqual({ id: 1, name: 'a' });
    // No re-select: the old key no longer addresses the row.
    expect(driver.sql()).toHaveLength(2);
  });

  it('soft delete writes the timestamp column and returns the refreshed row', async () => {
    driver
      .queue({ rows: [{ id: 1, name: 'a', deleted_at: null }] })
      .queue({ rowCount: 1 })
      .queue({ rows: [{ id: 1, name: 'a', deleted_at: '2026-01-01' }] });

    const row = await mysqlRepository(driver, { softDelete: true }).delete({ id: 1 });

    expect(row).toEqual({ id: 1, name: 'a', deleted_at: '2026-01-01' });
    expect(driver.sql()[1]).toBe('UPDATE `users` SET `deleted_at` = NOW() WHERE `id` = ?');
  });

  it('hard delete captures rows before deleting them', async () => {
    driver
      .queue({ rows: [{ id: 1, name: 'a' }] })
      .queue({ rowCount: 1 });

    const row = await mysqlRepository(driver).delete({ id: 1 });

    expect(row).toEqual({ id: 1, name: 'a' });
    expect(driver.sql()[1]).toBe('DELETE FROM `users` WHERE `id` = ?');
    expect(driver.sql()[1]).not.toContain('RETURNING');
  });

  it('upsert inserts with ON DUPLICATE KEY UPDATE and re-reads by insertId', async () => {
    driver
      .queue({ rowCount: 1, insertId: 5 })
      .queue({ rows: [{ id: 5, email: 'a@x.io', name: 'a' }] });

    const row = await mysqlRepository(driver).upsert({ email: 'a@x.io', name: 'a' }, ['email'], ['name']);

    expect(row).toEqual({ id: 5, email: 'a@x.io', name: 'a' });
    expect(driver.sql()[0]).toBe(
      'INSERT INTO `users` (`email`, `name`) VALUES (?, ?) ' +
        'ON DUPLICATE KEY UPDATE `name` = VALUES(`name`)',
    );
    expect(driver.sql()[0]).not.toContain('RETURNING');
    expect(driver.sql()[1]).toBe('SELECT * FROM `users` WHERE `id` = ? LIMIT 1');
  });

  it('upsert re-reads by the conflict columns when the row already existed', async () => {
    driver
      .queue({ rowCount: 2, insertId: 0 }) // duplicate → MySQL reports 0
      .queue({ rows: [{ id: 3, email: 'a@x.io', name: 'updated' }] });

    const row = await mysqlRepository(driver).upsert(
      { email: 'a@x.io', name: 'updated' },
      ['email'],
      ['name'],
    );

    expect(row).toEqual({ id: 3, email: 'a@x.io', name: 'updated' });
    expect(driver.sql()[1]).toBe('SELECT * FROM `users` WHERE `email` = ? LIMIT 1');
    expect(driver.calls[1].params).toEqual(['a@x.io']);
  });
});

describe('SQLite/Postgres write path (RETURNING)', () => {
  let driver: SqliteDriver;
  let repo: Repository<any>;

  beforeEach(async () => {
    driver = new SqliteDriver(':memory:');
    await driver.execute(
      'CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT UNIQUE)',
    );
    repo = new Repository(driver, 'users');
  });

  it('create and createMany return rows from the INSERT itself', async () => {
    const one = await repo.create({ name: 'a', email: 'a@x.io' });
    const many = await repo.createMany([
      { name: 'b', email: 'b@x.io' },
      { name: 'c', email: 'c@x.io' },
    ]);

    expect(one).toMatchObject({ name: 'a', email: 'a@x.io' });
    expect(one.id).toBe(1);
    expect(many.map((row: Row) => row.name)).toEqual(['b', 'c']);
    expect(many[1].id).toBe(3);
  });

  it('update returns the written row', async () => {
    const created = await repo.create({ name: 'a', email: 'a@x.io' });
    const updated = await repo.update({ id: created.id }, { name: 'renamed' });

    expect(updated).toMatchObject({ id: created.id, name: 'renamed' });
  });

  it('upsert updates on conflict and returns the row', async () => {
    await repo.create({ name: 'a', email: 'a@x.io' });

    const row = await repo.upsert({ name: 'a2', email: 'a@x.io' }, ['email'], ['name']);

    expect(row).toMatchObject({ email: 'a@x.io', name: 'a2' });
  });

  it('delete returns the removed row', async () => {
    const created = await repo.create({ name: 'a', email: 'a@x.io' });
    const deleted = await repo.delete({ id: created.id });

    expect(deleted).toMatchObject({ id: created.id, name: 'a' });
    expect(await repo.findMany()).toHaveLength(0);
  });
});
