// VA-ORM Select Projection
//
// Resolves which columns to SELECT. Keys required for relation mapping
// (primary key, parent-held foreign keys) are auto-included in the query.
// Rows are stripped to wanted columns + relation keys afterwards, so output
// matches the requested select even when the driver returns extra columns.

import type { IncludeMap, ModelMeta, SelectArg } from '../core/types.js';

export interface ResolvedSelect {
  columns: string[] | null;
  keep: string[] | null;
}

export function normalizeSelect(select: SelectArg): string[] {
  if (Array.isArray(select)) return [...select];
  return Object.entries(select)
    .filter(([, enabled]) => enabled)
    .map(([field]) => field);
}

export function resolveSelect(
  model: ModelMeta,
  select?: SelectArg,
  include?: IncludeMap,
): ResolvedSelect {
  if (select === undefined) return { columns: null, keep: null };

  const wanted = normalizeSelect(select);
  if (wanted.length === 0) return { columns: null, keep: null };

  const required = new Set<string>([model.primaryKey]);
  const includeKeys: string[] = [];
  if (include) {
    for (const field of Object.keys(include)) {
      includeKeys.push(field);
      const meta = model.relations.get(field);
      if (meta && !meta.isList && meta.isFkHolder) {
        for (const fk of meta.fkFields) required.add(fk);
      }
    }
  }

  const columns = [...wanted];
  for (const col of required) {
    if (!columns.includes(col)) columns.push(col);
  }

  return { columns, keep: [...new Set([...wanted, ...includeKeys])] };
}

/**
 * Default projection: every scalar column plus the keys needed to hydrate
 * `include` relations (PK + FK columns of non-list FK-holder relations).
 * Returns null when the model carries no column metadata (SELECT * fallback).
 */
export function defaultColumns(model: ModelMeta, include?: IncludeMap): string[] | null {
  if (!model.columns || model.columns.length === 0) return null;
  const columns = [...model.columns];
  const have = new Set(columns);
  const add = (col?: string) => {
    if (col && have.has(col) === false && model.columns!.includes(col)) {
      have.add(col);
      columns.push(col);
    }
  };
  // Only add the PK when it is a real scalar column — composite-PK models
  // fall back to primaryKey='id' which does not exist as a column.
  add(model.primaryKey);
  if (include) {
    for (const field of Object.keys(include)) {
      const meta = model.relations.get(field);
      if (meta && !meta.isList && meta.isFkHolder) {
        for (const fk of meta.fkFields) add(fk);
      }
    }
  }
  return columns;
}

export function stripColumns<T extends Record<string, any>>(rows: T[], keep: string[] | null): T[] {
  if (keep === null) return rows;
  const keepSet = new Set(keep);
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!keepSet.has(key)) delete row[key];
    }
  }
  return rows;
}
