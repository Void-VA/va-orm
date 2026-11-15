// Local HTTP smoke test — proves VaClient works end-to-end behind a real
// HTTP server (Bun.serve → fetch over TCP loopback → SQLite file).
// Single-table schema on purpose: this checks transport, not relations.
// Not part of the test suite; run manually:
//   bun scripts/http-smoke.ts

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VaClient } from '../packages/client/src/index.js';
import { SchemaParser } from '../packages/schema/src/index.js';

const SCHEMA = `
datasource db {
  provider = "sqlite"
  url      = "file:./http-smoke.db"
}

model User {
  id    Int    @id @default(autoincrement())
  name  String
  email String?

  @@map("users")
}
`;

const dir = mkdtempSync(join(tmpdir(), 'va-http-'));
const dsn = join(dir, 'smoke.db');

const va = VaClient.create({
  driver: 'sqlite',
  dsn,
  schema: new SchemaParser().parse(SCHEMA),
});

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
}

async function main() {
  await va.connect();
  await va.execute('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT)');

  await va.model('User').create({ data: { name: 'Alice', email: 'a@x.dev' } });
  await va.model('User').create({ data: { name: 'Bob' } });

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      try {
        if (url.pathname === '/users' && req.method === 'GET') {
          return Response.json(await va.model('User').findMany({ orderBy: { id: 'asc' } }));
        }
        const m = url.pathname.match(/^\/users\/(\d+)$/);
        if (m && req.method === 'GET') {
          const user = await va.model('User').findUnique({ where: { id: Number(m[1]) } });
          return user ? Response.json(user) : new Response('not found', { status: 404 });
        }
        if (url.pathname === '/users' && req.method === 'POST') {
          const body = (await req.json()) as { name?: string; email?: string };
          if (!body.name) return new Response('name required', { status: 400 });
          return Response.json(await va.model('User').create({ data: body }), { status: 201 });
        }
        return new Response('not found', { status: 404 });
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 500 });
      }
    },
  });
  const base = `http://localhost:${server.port}`;

  // --- assertions over real HTTP -------------------------------------------
  const list = await (await fetch(`${base}/users`)).json() as any[];
  check('GET /users returns seeded rows', list.length === 2, `n=${list.length}`);

  const detail = await (await fetch(`${base}/users/1`)).json() as any;
  check('GET /users/:id returns row', detail?.name === 'Alice' && detail?.email === 'a@x.dev');

  const created = await fetch(`${base}/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Carol' }),
  });
  const createdBody = (await created.json()) as any;
  check('POST /users creates row', created.status === 201 && createdBody.name === 'Carol');

  const list2 = await (await fetch(`${base}/users`)).json() as any[];
  check('created row visible on next request', list2.length === 3);

  const missing = await fetch(`${base}/users/999`);
  check('unknown id → 404', missing.status === 404);

  // --- rough latency sample (for later TCP comparison) ----------------------
  const t0 = performance.now();
  const N = 200;
  for (let i = 0; i < N; i++) await fetch(`${base}/users/1`);
  const avgMs = (performance.now() - t0) / N;
  console.log(`latency: GET /users/:id avg ${(avgMs).toFixed(2)}ms over ${N} requests`);

  server.stop();
  await va.disconnect();
  rmSync(dir, { recursive: true, force: true });
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
