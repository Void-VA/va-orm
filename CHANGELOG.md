# Changelog

All notable changes to `@v-va/orm` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.1.3]

### Fixed

- **Connection pool never leaked again on failed query**: `query()` and
  `execute()` closed the driver on error without decrementing `inUseCount`,
  so every failed query burned a pool slot permanently. After `max` errors
  the pool answered every request with `Connection acquisition timeout`
  until the process restarted. Failures now go through `discard()`, which
  releases the slot and hands a fresh connection to a waiting consumer.
- **Connection options no longer dropped by the pool**: `ssl`,
  `idleTimeoutMs` and `disablePreparedStatements` were accepted but never
  forwarded to the driver, so pooled connections always ran with
  `ssl: false` and prepared statements enabled. Neon rejects that with
  `28000 connection is insecure (try using sslmode=require)`.
- **Neon pooled endpoints detected as PgBouncer**: DSN hosts containing
  `-pooler.` now disable prepared statements (`prepareThreshold: 0`).
- **Pool lifecycle limits now apply**: `maxUses` and `maxLifetimeMs` were
  reset on every release, so connections were never retired for age or usage.
  Checkout counters and creation time are now tracked per driver, and idle
  connections that are unhealthy, out of uses, or too old are closed on the
  next acquire instead of silently kept.
- **`autoincrement()` DDL is valid again**: the SQL generator emitted
  `DEFAULT GENERATED ALWAYS AS IDENTITY` (Postgres), `DEFAULT AUTO_INCREMENT`
  (MySQL), and relied on a SQLite special case. Identity/auto-increment
  clauses are now emitted as column modifiers, so `va db push`,
  `va migrate dev`, and `va generate --sql` produce runnable DDL on all three
  providers.
- **`va generate --sql` uses the schema's dialect**: the command always
  generated PostgreSQL DDL unless `--provider` was passed, and the CLI never
  read `--provider` at all. The dialect now defaults to the schema datasource
  (`postgres`, `mysql`, `sqlite`) and the flag is wired through.
- **MySQL pools honour `max`**: the driver passed `max` to `mysql2`, which
  ignores it and only honours `connectionLimit`. Pool size limits now apply
  to MySQL connections too.

Detail: [`docs/14-bug-connection-pool-ssl.md`](./docs/14-bug-connection-pool-ssl.md).

## [0.1.2]

### Fixed

- **`http` driver (SQL-over-HTTP) restored**: `driver: 'http'` executes SQL
  through an HTTP endpoint instead of a TCP connection — for serverless
  environments (Vercel/Workers) where direct Postgres connections are not
  possible. Zero-dependency (`fetch`), with protocol profiles for `generic`,
  Neon, Prisma Accelerate, Cloudflare D1, and Turso/libSQL (including baton
  sessions for interactive transactions). Remote dialect (`postgres` /
  `sqlite`) and placeholder style are resolved synchronously so quoting and
  `$n`/`?` params always match the server engine. Shipped in `0.1.0-beta.9`,
  dropped from the build in `beta.10`, restored here — `0.1.1` consumers that
  import `HttpDriver` or pass `driver: 'http'` need this version.
- **Stale build output no longer ships**: `tsup` left orphaned chunks in
  `dist/` across rebuilds (four `va.client-*.d.ts`, ~23 obsolete `.js`), and
  `files[]` publishes the whole tree. `prebuild` now removes both `dist`
  directories first, so the tarball contains exactly what the build emitted.

## [0.1.1]

### Fixed

- **Nested transactions on PostgreSQL**: the outer `BEGIN` was not counted in
  `txDepth`, so any nested `transaction()` inside `va.transaction` issued a
  second `BEGIN`/`COMMIT` — prematurely committing the outer transaction and
  leaking partial writes. Nested calls now correctly use
  `SAVEPOINT`/`RELEASE`/`ROLLBACK TO SAVEPOINT`.
- **Nested transactions on MySQL**: same class of bug — nested calls at depth
  0 skipped savepoints entirely, so a nested failure rolled back the whole
  parent transaction instead of just the savepoint.
- `Repository.createMany` issued one `INSERT ... RETURNING *` per row;
  ~2000 queries for 2000 rows. Now builds chunked multi-row
  `INSERT ... VALUES (...), (...) RETURNING *` statements, sized to each
  driver's parameter budget (Postgres/MySQL ~30k params, SQLite ~900).
  `BatchRepository.createMany` benefits automatically.

### Added

- **Scalar column projection**: `findMany`/`findUnique` and the include
  loader no longer `SELECT *` — they project the modeled scalar columns plus
  the keys relations need. Wide/complex columns (e.g. `tsvector`, `text[]`,
  `tsrange`) are no longer transferred unless requested. Explicit `select`
  remains authoritative.
- **Parallel include branches**: independent `include` branches are resolved
  concurrently instead of sequentially.
- **Flat-write fast path**: `create`/`update` calls whose data contains no
  relation keys — and, for `update`, targets the primary key — skip the
  `BEGIN`/`COMMIT` wrapper. Nested writes keep full transactional semantics.

### Benchmarks

- See README § Benchmarks: vs Prisma, Drizzle, TypeORM on PostgreSQL
  (Pagila + AI-agent/JSONB workloads), plus an HTTP-transport check.
  Environment and caveats documented there.

## [0.1.0-beta.10] and earlier

Beta series (`0.1.0-beta.1` … `beta.10`): schema-first client, `VaClient`,
model delegates, relations/includes, transactions, raw queries, CLI
(`va db push`, `va generate`), Elysia/NestJS integrations, security
hardening phases 0–3b. See git history for per-release detail.
