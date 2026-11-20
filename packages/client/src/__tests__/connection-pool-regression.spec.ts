// VA-ORM — Regression tests for docs/14-bug-connection-pool-ssl.md
//
// Bug #1: failed query/execute burned a pool slot forever (inUseCount never
//         decremented), ending in permanent "Connection acquisition timeout".
// Bug #2: `ssl`, `idleTimeoutMs` and `disablePreparedStatements` were dropped
//         between ConnectionPool and the driver, so TLS was silently off.
// Bug #3: Neon pooled hosts (`...-pooler...neon.tech`) were not recognised as
//         PgBouncer, so prepared statements stayed enabled.

import { describe, it, expect, afterEach } from 'bun:test';
import { ConnectionPool } from '../core/connection.pool.js';
import type { DatabaseDriver } from '../core/types.js';
import { SqliteDriver } from '../drivers/sqlite/sqlite.driver.js';
import { PostgresDriver } from '../drivers/postgres/postgres.driver.js';

const PGHOST_DSN = 'postgresql://user:pass@localhost:5432/va_test';
const NEON_POOLER_DSN =
  'postgresql://user:pass@ep-flat-123-pooler.c-9.us-east-2.aws.neon.tech/va_test';

interface DriverProbe {
  driver: DatabaseDriver;
  closed: boolean;
}

/**
 * Pool backed by SQLite drivers whose `query()` fails until the failure budget
 * is spent. Every failure is a genuine connection-level error, exactly like the
 * Neon SSL rejection that triggered the production outage.
 */
function createFailingPool(options: { remainingFailures: number; max?: number; min?: number }): {
  pool: ConnectionPool;
  probes: DriverProbe[];
} {
  let remainingFailures = options.remainingFailures;
  const probes: DriverProbe[] = [];

  const pool = new ConnectionPool('sqlite', ':memory:', {
    min: options.min ?? 1,
    max: options.max ?? 2,
    healthCheck: false,
    retryMode: 'none',
    connectionTimeoutMs: 250,
    driverFactory: () => {
      const driver = new SqliteDriver(':memory:');
      const originalQuery = driver.query.bind(driver);
      const probe: DriverProbe = { driver, closed: false };
      const originalClose = driver.close.bind(driver);

      driver.query = async (sql: string, params?: any[]) => {
        if (remainingFailures > 0) {
          remainingFailures--;
          throw new Error('simulated connection failure');
        }
        return originalQuery(sql, params);
      };
      driver.close = async () => {
        probe.closed = true;
        await originalClose();
      };

      probes.push(probe);
      return driver;
    },
  });

  return { pool, probes };
}

describe('phase 14 — connection pool slot accounting', () => {
  let pool: ConnectionPool | undefined;

  afterEach(async () => {
    await pool?.close();
    pool = undefined;
  });

  it('returns activeCount to its baseline after a failed query', async () => {
    const created = createFailingPool({ remainingFailures: 1, max: 2 });
    pool = created.pool;
    await (pool as any).ready;

    const before = pool.getStats().activeCount;

    await expect(pool.query('SELECT 1')).rejects.toThrow('simulated connection failure');

    const after = pool.getStats();
    expect(after.activeCount).toBe(before);
    // The broken driver must be closed, not parked in the idle pool.
    expect(created.probes.filter((probe) => probe.closed)).toHaveLength(1);
    expect(after.idleCount).toBe(before);
  });

  it('keeps serving after `max` consecutive failures (no acquisition timeout)', async () => {
    const created = createFailingPool({ remainingFailures: 5, max: 2 });
    pool = created.pool;
    await (pool as any).ready;

    // Without the fix the third call rejects with "Connection acquisition
    // timeout" instead of the real error, because both slots were burned.
    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(pool.query('SELECT 1')).rejects.toThrow('simulated connection failure');
    }

    expect(pool.getStats().activeCount).toBe(0);

    const result = await pool.query<{ value: number }>('SELECT 1 AS value');
    expect(result.rows[0]).toEqual({ value: 1 });
    expect(pool.getStats().activeCount).toBe(0);
  });

  it('hands a replacement connection to a waiter when a query fails', async () => {
    let releaseFirst: () => void = () => {};
    let firstStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let calls = 0;

    pool = new ConnectionPool('sqlite', ':memory:', {
      min: 1,
      max: 1,
      healthCheck: false,
      retryMode: 'none',
      connectionTimeoutMs: 250,
      driverFactory: () => {
        const driver = new SqliteDriver(':memory:');
        const originalQuery = driver.query.bind(driver);
        driver.query = async (sql: string, params?: any[]) => {
          calls++;
          if (calls === 1) {
            firstStarted();
            await new Promise<void>((resolve) => {
              releaseFirst = resolve;
            });
            throw new Error('first query failed');
          }
          return originalQuery(sql, params);
        };
        return driver;
      },
    });
    await (pool as any).ready;

    const first = pool.query('SELECT 1');
    await started;
    const second = pool.query<{ value: number }>('SELECT 2 AS value');
    // `query()` awaits `ready` before acquire, so let it reach the queue.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(pool.getStats().waitingCount).toBe(1);

    releaseFirst();

    await expect(first).rejects.toThrow('first query failed');
    await expect(second).resolves.toMatchObject({ rows: [{ value: 2 }] });
    expect(pool.getStats().activeCount).toBe(0);
    expect(pool.getStats().waitingCount).toBe(0);
  });
});

describe('phase 14 — connection lifecycle limits', () => {
  function createLifecyclePool(options: { maxUses?: number; maxLifetimeMs?: number }): {
    pool: ConnectionPool;
    created: () => number;
    closed: () => number;
  } {
    let createdCount = 0;
    let closedCount = 0;
    const pool = new ConnectionPool('sqlite', ':memory:', {
      min: 0,
      max: 1,
      healthCheck: false,
      ...options,
      driverFactory: () => {
        createdCount++;
        const driver = new SqliteDriver(':memory:');
        const originalClose = driver.close.bind(driver);
        driver.close = async () => {
          closedCount++;
          await originalClose();
        };
        return driver;
      },
    });
    return { pool, created: () => createdCount, closed: () => closedCount };
  }

  it('retires a connection once maxUses checkouts are spent', async () => {
    const { pool, created, closed } = createLifecyclePool({ maxUses: 3 });
    await (pool as any).ready;

    try {
      const drivers = new Set<DatabaseDriver>();
      for (let i = 0; i < 4; i++) {
        const driver = await pool.acquire();
        drivers.add(driver);
        await pool.release(driver);
      }

      // Three reuses of the first connection, then a brand new one.
      expect(drivers.size).toBe(2);
      expect(created()).toBe(2);
      expect(closed()).toBe(1);
    } finally {
      await pool.close();
    }
  });

  it('retires a connection older than maxLifetimeMs', async () => {
    const { pool, created } = createLifecyclePool({ maxLifetimeMs: 25 });
    await (pool as any).ready;

    try {
      const first = await pool.acquire();
      await pool.release(first);

      // Still fresh: reused instead of recreated.
      const reused = await pool.acquire();
      expect(reused).toBe(first);
      await pool.release(reused);

      await new Promise<void>((resolve) => setTimeout(resolve, 40));

      // Age is measured from creation, not from the last release.
      const aged = await pool.acquire();
      expect(aged).not.toBe(first);
      await pool.release(aged);

      expect(created()).toBe(2);
    } finally {
      await pool.close();
    }
  });
});

describe('phase 14 — connection options reach the driver', () => {
  it('forwards ssl from ConnectionConfig to PostgresDriver', async () => {
    const factories = (ConnectionPool as any).globalFactories as Map<string, unknown>;
    const saved = factories.get('postgres');
    factories.delete('postgres');

    const ssl = { rejectUnauthorized: false, ca: 'test-ca-pem' };
    const pool = new ConnectionPool('postgres', PGHOST_DSN, {
      min: 0,
      max: 1,
      healthCheck: false,
      ssl,
    });

    try {
      const driver = (await pool.acquire()) as any;
      expect(driver.pool.options.ssl).toEqual(ssl);
      await pool.release(driver);
    } finally {
      if (saved) factories.set('postgres', saved);
      await pool.close();
    }
  });
});

describe('phase 14 — PostgresDriver options', () => {
  it('keeps ssl off the pg options when it is not configured', async () => {
    const driver = new PostgresDriver(PGHOST_DSN);
    try {
      // Leaving `ssl` unset lets pg honour `?sslmode=require` in the DSN.
      expect('ssl' in ((driver as any).pool.options as object)).toBe(false);
    } finally {
      await driver.close();
    }
  });

  it('passes an explicit ssl option to pg', async () => {
    const ssl = { rejectUnauthorized: true };
    const driver = new PostgresDriver(PGHOST_DSN, { ssl });
    try {
      expect((driver as any).pool.options.ssl).toEqual(ssl);
    } finally {
      await driver.close();
    }
  });

  it('disables prepared statements on Neon pooled endpoints', async () => {
    const driver = new PostgresDriver(NEON_POOLER_DSN);
    try {
      expect((driver as any).pool.options.prepareThreshold).toBe(0);
    } finally {
      await driver.close();
    }
  });

  it('keeps prepared statements on direct (non-pooled) hosts', async () => {
    const driver = new PostgresDriver(PGHOST_DSN);
    try {
      expect('prepareThreshold' in ((driver as any).pool.options as object)).toBe(false);
    } finally {
      await driver.close();
    }
  });

  it('disables prepared statements when disablePreparedStatements is set', async () => {
    const driver = new PostgresDriver(PGHOST_DSN, { disablePreparedStatements: true });
    try {
      expect((driver as any).pool.options.prepareThreshold).toBe(0);
    } finally {
      await driver.close();
    }
  });
});
