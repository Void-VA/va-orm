// VA-ORM HTTP Driver Spec — SQL-over-HTTP dengan fetch mock

import { describe, it, expect } from 'bun:test';
import { HttpDriver } from '../drivers/http/http.driver.js';
import { VaClient } from '../core/va.client.js';
import { detectHttpProtocol, resolveHttpProfile } from '../drivers/http/http.protocols.js';
import { VaError } from '../core/errors.js';

interface CapturedRequest {
  url: string;
  body: any;
  headers: Record<string, string>;
}

function mockFetch(handler: (req: CapturedRequest) => { status?: number; body: any }) {
  const requests: CapturedRequest[] = [];
  const fetchImpl = (async (url: any, init: any) => {
    const req: CapturedRequest = {
      url: String(url),
      body: JSON.parse(init.body),
      headers: init.headers as Record<string, string>,
    };
    requests.push(req);
    const { status = 200, body } = handler(req);
    return new Response(JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { fetchImpl, requests };
}

describe('HttpDriver — generic protocol', () => {
  it('POST {sql, params} dan map {rows, rowCount}', async () => {
    const { fetchImpl, requests } = mockFetch(() => ({
      body: { rows: [{ id: 1 }], rowCount: 1 },
    }));
    const driver = new HttpDriver('https://db.example.com/sql', { fetch: fetchImpl });

    const result = await driver.query('SELECT * FROM users WHERE id = $1', [1]);

    expect(result.rows).toEqual([{ id: 1 }]);
    expect(result.rowCount).toBe(1);
    expect(requests).toHaveLength(1);
    expect(requests[0].body).toEqual({ sql: 'SELECT * FROM users WHERE id = $1', params: [1] });
    expect(requests[0].headers['content-type']).toBe('application/json');
  });

  it('accepts array response and {data} shape', async () => {
    const { fetchImpl } = mockFetch(() => ({ body: [{ id: 2 }] }));
    const driver = new HttpDriver('https://db.example.com/sql', { fetch: fetchImpl });
    const result = await driver.query('SELECT 1');
    expect(result.rows).toEqual([{ id: 2 }]);
    expect(result.rowCount).toBe(1);
  });

  it('execute returns rowCount', async () => {
    const { fetchImpl } = mockFetch(() => ({ body: { rows: [], rowCount: 3 } }));
    const driver = new HttpDriver('https://db.example.com/sql', { fetch: fetchImpl });
    const result = await driver.execute('DELETE FROM t');
    expect(result.rowCount).toBe(3);
  });

  it('placeholder $n untuk postgres, ? untuk sqlite', () => {
    const pg = new HttpDriver('https://db.example.com/sql', {
      fetch: (() => {}) as any,
      dialect: 'postgres',
    });
    expect(pg.getPlaceholder(3)).toBe('$3');
    expect(pg.getDialect()).toBe('postgres');

    const lite = new HttpDriver('https://db.example.com/sql', {
      fetch: (() => {}) as any,
      dialect: 'sqlite',
      placeholder: 'positional',
    });
    expect(lite.getPlaceholder(3)).toBe('?');
    expect(lite.getDialect()).toBe('sqlite');
  });

  it('kirim authToken sebagai Bearer + custom headers', async () => {
    const { fetchImpl, requests } = mockFetch(() => ({ body: { rows: [] } }));
    const driver = new HttpDriver('https://db.example.com/sql', {
      fetch: fetchImpl,
      authToken: 'secret-token',
      headers: { 'x-api-key': 'k' },
    });
    await driver.query('SELECT 1');
    expect(requests[0].headers.authorization).toBe('Bearer secret-token');
    expect(requests[0].headers['x-api-key']).toBe('k');
  });

  it('HTTP 4xx melempar VaError tanpa retry semantics', async () => {
    const { fetchImpl } = mockFetch(() => ({
      status: 400,
      body: { error: 'bad sql' },
    }));
    const driver = new HttpDriver('https://db.example.com/sql', { fetch: fetchImpl });
    await expect(driver.query('SELECT bogus')).rejects.toBeInstanceOf(VaError);
    await expect(driver.query('SELECT bogus')).rejects.toMatchObject({ code: 'HTTP_CLIENT_ERROR' });
  });

  it('HTTP 500 → HTTP_STATUS', async () => {
    const { fetchImpl } = mockFetch(() => ({ status: 500, body: 'boom' }));
    const driver = new HttpDriver('https://db.example.com/sql', { fetch: fetchImpl });
    await expect(driver.query('SELECT 1')).rejects.toMatchObject({ code: 'HTTP_STATUS' });
  });

  it('menolak URL non-http', () => {
    expect(() => new HttpDriver('file:///etc/passwd', { fetch: (() => {}) as any })).toThrow(
      VaError,
    );
    expect(() => new HttpDriver('notaurl', { fetch: (() => {}) as any })).toThrow(VaError);
  });
});

describe('HttpDriver — transaction', () => {
  it('protocol stateless melempar error eksplisit', async () => {
    const { fetchImpl } = mockFetch(() => ({ body: { rows: [] } }));
    const driver = new HttpDriver('https://db.example.com/sql', { fetch: fetchImpl });
    await expect(driver.transaction(async () => {})).rejects.toMatchObject({
      code: 'HTTP_TRANSACTION_UNSUPPORTED',
    });
  });
});

describe('HttpDriver — protocol profiles', () => {
  it('detectHttpProtocol dari hostname', () => {
    expect(detectHttpProtocol('https://x.neon.tech/sql')).toBe('neon');
    expect(detectHttpProtocol('https://x.turso.io')).toBe('turso');
    expect(detectHttpProtocol('https://api.cloudflare.com/client/v4/...')).toBe('d1');
    expect(detectHttpProtocol('https://db.example.com')).toBe('generic');
  });

  it('neon: {query, params} → rows+fields array-of-arrays → objects', async () => {
    const { fetchImpl, requests } = mockFetch(() => ({
      body: {
        command: 'SELECT',
        fields: [{ name: 'id' }, { name: 'name' }],
        rowCount: 1,
        rows: [[7, 'a']],
      },
    }));
    const driver = new HttpDriver('https://ep-cool.neon.tech/sql', { fetch: fetchImpl });
    const result = await driver.query('SELECT id, name FROM t');
    expect(requests[0].body).toEqual({ query: 'SELECT id, name FROM t', params: [] });
    expect(result.rows).toEqual([{ id: 7, name: 'a' }]);
    expect(driver.getDialect()).toBe('postgres');
  });

  it('d1: {result:[{results, meta}]} → rows + changes', async () => {
    const { fetchImpl, requests } = mockFetch(() => ({
      body: { success: true, result: [{ results: [{ id: 1 }], success: true, meta: {} }] },
    }));
    const driver = new HttpDriver('https://api.cloudflare.com/d1', {
      fetch: fetchImpl,
      protocol: 'd1',
    });
    const result = await driver.query('SELECT * FROM t');
    expect(requests[0].body).toEqual({ sql: 'SELECT * FROM t', params: [] });
    expect(result.rows).toEqual([{ id: 1 }]);
    expect(driver.getDialect()).toBe('sqlite');
    expect(driver.getPlaceholder(1)).toBe('?');
  });

  it('turso: pipeline body + baton session', async () => {
    const { fetchImpl, requests } = mockFetch((req) => ({
      body: {
        baton: req.body.baton ? 'baton-2' : 'baton-1',
        results: [
          {
            type: 'ok',
            response: {
              type: 'execute',
              result: {
                cols: [{ name: 'id' }],
                rows: [[{ type: 'integer', value: '5' }]],
                affected_row_count: 1,
              },
            },
          },
        ],
      },
    }));
    const driver = new HttpDriver('https://db.turso.io', { fetch: fetchImpl });
    const result = await driver.query('SELECT id FROM t WHERE x = ?', [9]);
    expect(requests[0].url).toContain('/v2/pipeline');
    expect(requests[0].body.requests[0].stmt.sql).toBe('SELECT id FROM t WHERE x = ?');
    expect(result.rows).toEqual([{ id: 5 }]);
  });

  it('resolveHttpProfile override dialect/placeholder/path', () => {
    const profile = resolveHttpProfile({ protocol: 'generic', dialect: 'sqlite' });
    expect(profile.dialect).toBe('sqlite');
    expect(profile.placeholder).toBe('numbered'); // generic default tetap numbered
  });
});

describe('VaClient driver:http end-to-end', () => {
  it('repository findMany lewat http generic + placeholder sinkron', async () => {
    const { fetchImpl, requests } = mockFetch(() => ({
      body: { rows: [{ id: 1, name: 'x' }], rowCount: 1 },
    }));
    const va = new VaClient({
      driver: 'http',
      dsn: 'https://sql-gate.example.com/query',
      pooling: false,
      http: { fetch: fetchImpl, dialect: 'postgres' },
      models: { User: { tableName: 'users' } },
    });

    const users = await va.repository<any>('User').findMany();
    expect(users).toEqual([{ id: 1, name: 'x' }]);
    expect(requests[0].body.sql).toContain('FROM "users"');
    expect(requests[0].body.params).toEqual([]);

    // Placeholder sinkron: query dengan where harus memakai $n (postgres).
    await va.repository<any>('User').findMany({ where: { id: 5 } } as any);
    expect(requests[1].body.sql).toContain('$1');
    expect(requests[1].body.params).toEqual([5]);
  });

  it('vaClient dengan pooling membuat HttpDriver via pool', async () => {
    const { fetchImpl } = mockFetch(() => ({ body: { rows: [], rowCount: 0 } }));
    const va = new VaClient({
      driver: 'http',
      dsn: 'https://sql-gate.example.com/query',
      connection: { min: 1, max: 2, http: { fetch: fetchImpl } },
      models: { User: { tableName: 'users' } },
    });
    await va.repository<any>('User').findMany();
    await va.disconnect();
  });
});
