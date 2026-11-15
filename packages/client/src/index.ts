// VA-ORM Client - Main Entry Point

export * from './core/types.js';
export * from './core/va.client.js';
export * from './core/connection.pool.js';
export * from './core/query-builder.js';
export * from './core/expression.js';

export * from './repository/repository.js';
export * from './repository/batch.js';
export * from './repository/aggregation.js';
export * from './repository/model.delegate.js';
export * from './repository/nested.writes.js';
export * from './repository/field.ops.js';

export * from './relation/index.js';
export { ansiQuote, mysqlQuote, quoterFor } from './relation/quote.js';
export type { QuoteFn } from './relation/quote.js';

export * from './raw/raw-query.js';
export * from './raw/cte.js';
export * from './raw/subquery.js';

export * from './pagination/offset.js';
export * from './pagination/cursor.js';
export * from './pagination/keyset.js';
export * from './pagination/adapters/odata.adapter.js';
export * from './pagination/adapters/rest.adapter.js';
export * from './pagination/adapters/graphql.adapter.js';

export { VaClient } from './core/va.client.js';
export type { VaClientOptions } from './core/va.client.js';

// Process-wide singleton — framework-agnostic, so it is exported from the root
// too. `@v-va/orm/elysia` re-exports the same function plus `vaPlugin`; importing
// that subpath never pulls in `elysia` itself, the name only reflects the plugin
// shape (`{ name, start, stop }`) it also ships.
export { VaSingleton, createVaSingleton } from './integrations/elysia/va.singleton.js';
export type { SchemaAST } from '../../schema/src/schema.types.js';
export { VaError } from './core/errors.js';

export { HttpDriver } from './drivers/http/http.driver.js';
export {
  HTTP_PROFILES,
  detectHttpProtocol,
  resolveHttpProfile,
  encodeTursoValue,
  decodeTursoValue,
} from './drivers/http/http.protocols.js';
export type { HttpProtocolProfile } from './drivers/http/http.protocols.js';
