# Changelog

All notable changes to `@v-va/orm` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
