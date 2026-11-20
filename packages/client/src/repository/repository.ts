// VA-ORM Repository

import type {
  DatabaseDriver,
  WhereClause,
  OrderClause,
  SortDirection,
  RepositoryOptions,
  OffsetResult,
  OffsetOptions,
  CursorResult,
  CursorOptions,
} from '../core/types.js';
import { QueryBuilder } from '../core/query-builder.js';
import { ExpressionBuilder } from '../core/expression.js';
import { buildSetClause } from './field.ops.js';
import { quoteColumn, quoteTable } from '../relation/quote.js';
import { ReturningWriter } from './write/index.js';

export class Repository<T extends Record<string, any>> {
  private options: Required<Omit<RepositoryOptions, 'updatedAtField'>>;
  private updatedAtField?: string;
  private writer: ReturningWriter;

  constructor(
    private driver: DatabaseDriver,
    private tableName: string,
    options: RepositoryOptions = {},
  ) {
    this.options = {
      softDelete: options.softDelete ?? false,
      softDeleteColumn: options.softDeleteColumn ?? 'deleted_at',
      camelToSnake: options.camelToSnake ?? true,
      primaryKey: options.primaryKey ?? 'id',
    };
    this.updatedAtField = options.updatedAtField;
    this.writer = new ReturningWriter(driver, { primaryKey: this.options.primaryKey });
  }

  /**
   * Fill @updatedAt-managed field with now() when the caller did not set it.
   * Explicit values always win. Shallow-copies so caller objects are untouched.
   */
  private touch<D extends Record<string, any>>(data: D): D {
    const field = this.updatedAtField;
    if (!field || field in data) return data;
    return { ...data, [field]: new Date() };
  }

  // ============ CREATE ============

  async create(data: Partial<T>): Promise<T> {
    const touched = this.touch({ ...(data as Record<string, any>) });
    const rows = await this.writer.insert<T>(this.tableName, [touched]);
    return rows[0];
  }

  async createMany(data: Partial<T>[]): Promise<T[]> {
    if (data.length === 0) return [];

    const touched = data.map((item) => this.touch({ ...(item as Record<string, any>) }));
    return this.writer.insert<T>(this.tableName, touched);
  }

  // ============ READ ============

  async findUnique(where: Partial<T>): Promise<T | null> {
    const conditions = Object.entries(where);
    const whereClause = conditions.map(([key, value], i) => ({
      column: key,
      operator: '=' as const,
      value,
    }));

    const builder = new QueryBuilder<T>(this.driver, this.tableName);
    builder.where((eb) => {
      for (const clause of whereClause) {
        eb.eq(clause.column, clause.value);
      }
    });

    return builder.first();
  }

  async findFirst(where?: Partial<T>): Promise<T | null> {
    const builder = new QueryBuilder<T>(this.driver, this.tableName);

    if (where) {
      builder.where((eb) => {
        for (const [key, value] of Object.entries(where)) {
          eb.eq(key, value);
        }
      });
    }

    return builder.first();
  }

  async findMany(
    options: {
      where?: Partial<T>;
      orderBy?: { [K in keyof T]?: SortDirection };
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<T[]> {
    const builder = new QueryBuilder<T>(this.driver, this.tableName);

    if (options.where) {
      builder.where((eb) => {
        for (const [key, value] of Object.entries(options.where!)) {
          eb.eq(key, value);
        }
      });
    }

    if (options.orderBy) {
      for (const [key, direction] of Object.entries(options.orderBy)) {
        builder.orderBy(key, direction as SortDirection);
      }
    }

    if (options.limit !== undefined) {
      builder.limit(options.limit);
    }

    if (options.offset !== undefined) {
      builder.offset(options.offset);
    }

    return builder.execute();
  }

  // ============ UPDATE ============

  async update(where: Partial<T>, data: Partial<T>): Promise<T> {
    if (Object.keys(where).length === 0) {
      throw new Error('refusing UPDATE without WHERE');
    }
    const touched = this.touch({ ...(data as Record<string, any>) });
    const {
      setParts,
      params: setValues,
      nextIndex,
    } = buildSetClause(
      touched,
      (i) => this.driver.getPlaceholder(i),
      (name) => quoteColumn(this.driver, name),
    );

    const whereConditions = Object.entries(where);
    const whereParts = whereConditions.map(
      ([key], i) =>
        `${quoteColumn(this.driver, key)} = ${this.driver.getPlaceholder(nextIndex + i)}`,
    );
    const whereValues = whereConditions.map(([, value]) => value);

    const rows = await this.writer.update<T>(this.tableName, {
      setParts,
      params: setValues,
      whereParts,
      whereParams: whereValues,
      updatedColumns: Object.keys(touched),
    });
    return rows[0];
  }

  async updateMany(where: Partial<T>, data: Partial<T>): Promise<number> {
    if (Object.keys(where).length === 0) {
      throw new Error('refusing UPDATE without WHERE');
    }
    const {
      setParts,
      params: setValues,
      nextIndex,
    } = buildSetClause(
      this.touch({ ...(data as Record<string, any>) }),
      (i) => this.driver.getPlaceholder(i),
      (name) => quoteColumn(this.driver, name),
    );

    const whereConditions = Object.entries(where);
    const whereParts = whereConditions.map(
      ([key], i) =>
        `${quoteColumn(this.driver, key)} = ${this.driver.getPlaceholder(nextIndex + i)}`,
    );
    const whereValues = whereConditions.map(([, value]) => value);

    const sql = `UPDATE ${quoteTable(this.driver, this.tableName)} SET ${setParts.join(', ')} WHERE ${whereParts.join(' AND ')}`;
    const result = await this.driver.execute(sql, [...setValues, ...whereValues]);
    return result.rowCount;
  }

  // ============ UPSERT ============
  // NOTE: upsert intentionally does NOT auto-touch updatedAt — the caller
  // controls updateColumns explicitly, so implicit columns would be inconsistent.

  async upsert(data: Partial<T>, conflictColumns: string[], updateColumns: string[]): Promise<T> {
    return this.writer.upsert<T>(this.tableName, {
      data: data as Record<string, any>,
      conflictColumns,
      updateColumns,
    });
  }

  // ============ DELETE ============

  async delete(where: Partial<T>): Promise<T> {
    if (Object.keys(where).length === 0) {
      throw new Error('refusing DELETE without WHERE');
    }
    const conditions = Object.entries(where);
    const whereParts = conditions.map(
      ([key], i) => `${quoteColumn(this.driver, key)} = ${this.driver.getPlaceholder(i + 1)}`,
    );
    const whereValues = conditions.map(([, value]) => value);

    const rows = this.options.softDelete
      ? await this.writer.softDelete<T>(this.tableName, this.options.softDeleteColumn, {
          whereParts,
          whereParams: whereValues,
        })
      : await this.writer.remove<T>(this.tableName, { whereParts, whereParams: whereValues });
    return rows[0];
  }

  /**
   * Delete rows matching `where`. Refuses an empty/missing filter — wiping a
   * whole table must go through {@link deleteAll} so it is explicit at the
   * call site.
   */
  async deleteMany(where: Partial<T>): Promise<number> {
    if (!where || Object.keys(where).length === 0) {
      throw new Error(
        'refusing deleteMany without WHERE — use deleteAll() to remove every row intentionally',
      );
    }

    const conditions = Object.entries(where);
    const whereParts = conditions.map(
      ([key], i) => `${quoteColumn(this.driver, key)} = ${this.driver.getPlaceholder(i + 1)}`,
    );
    const whereValues = conditions.map(([, value]) => value);

    if (this.options.softDelete) {
      const sql = `UPDATE ${quoteTable(this.driver, this.tableName)} SET ${quoteColumn(this.driver, this.options.softDeleteColumn)} = NOW() WHERE ${whereParts.join(' AND ')}`;
      const result = await this.driver.execute(sql, whereValues);
      return result.rowCount;
    }

    const sql = `DELETE FROM ${quoteTable(this.driver, this.tableName)} WHERE ${whereParts.join(' AND ')}`;
    const result = await this.driver.execute(sql, whereValues);
    return result.rowCount;
  }

  /**
   * Remove every row in the table. Explicit escape hatch — the name makes the
   * blast radius obvious at the call site (unlike a bare deleteMany()).
   */
  async deleteAll(): Promise<number> {
    if (this.options.softDelete) {
      const sql = `UPDATE ${quoteTable(this.driver, this.tableName)} SET ${quoteColumn(this.driver, this.options.softDeleteColumn)} = NOW()`;
      const result = await this.driver.execute(sql);
      return result.rowCount;
    }

    const sql = `DELETE FROM ${quoteTable(this.driver, this.tableName)}`;
    const result = await this.driver.execute(sql);
    return result.rowCount;
  }

  // ============ AGGREGATE ============

  async count(where?: Partial<T>): Promise<number> {
    const builder = new QueryBuilder(this.driver, this.tableName);

    if (where) {
      builder.where((eb) => {
        for (const [key, value] of Object.entries(where)) {
          eb.eq(key, value);
        }
      });
    }

    return builder.count();
  }

  async exists(where?: Partial<T>): Promise<boolean> {
    const count = await this.count(where);
    return count > 0;
  }

  // ============ PAGINATION ============

  async paginate(
    options: OffsetOptions & {
      where?: Partial<T>;
      orderBy?: { [K in keyof T]?: SortDirection };
    } = {},
  ): Promise<OffsetResult<T>> {
    const page = options.page ?? 1;
    const limit = options.limit ?? 10;
    const skip = options.skip ?? (page - 1) * limit;

    const [items, total] = await Promise.all([
      this.findMany({ ...options, limit, offset: skip }),
      this.count(options.where),
    ]);

    const totalPages = Math.ceil(total / limit);

    return {
      items,
      total,
      page,
      limit,
      skip,
      totalPages,
      hasNext: page < totalPages,
      hasPrevious: page > 1,
    };
  }

  async cursorPaginate(
    options: CursorOptions & {
      where?: Partial<T>;
      orderBy?: { [K in keyof T]?: SortDirection };
    } = {},
  ): Promise<CursorResult<T>> {
    const limit = options.limit ?? 10;
    const builder = new QueryBuilder<T>(this.driver, this.tableName);

    if (options.where) {
      builder.where((eb) => {
        for (const [key, value] of Object.entries(options.where!)) {
          eb.eq(key, value);
        }
      });
    }

    if (options.cursor) {
      // Simple cursor implementation using id
      builder.where((eb) => {
        eb.gt('id', options.cursor);
      });
    }

    if (options.orderBy) {
      for (const [key, direction] of Object.entries(options.orderBy)) {
        builder.orderBy(key, direction as SortDirection);
      }
    }

    builder.limit(limit + 1); // Fetch one extra to determine if there are more

    const items = await builder.execute();
    const hasMore = items.length > limit;
    const resultItems = hasMore ? items.slice(0, limit) : items;

    return {
      items: resultItems,
      nextCursor: hasMore ? resultItems[resultItems.length - 1]?.id : undefined,
      hasMore,
      hasPrevious: !!options.cursor,
    };
  }

  // ============ BATCH ============

  async transaction<R>(fn: (repo: Repository<T>) => Promise<R>): Promise<R> {
    return this.driver.transaction(async (driver) => {
      const repo = new Repository<T>(driver, this.tableName, this.options);
      return fn(repo);
    });
  }

  // ============ RAW QUERY ============

  async raw<R = any>(sql: string, params?: any[]): Promise<R[]> {
    const result = await this.driver.query<R>(sql, params);
    return result.rows;
  }

  async rawOne<R = any>(sql: string, params?: any[]): Promise<R | null> {
    const result = await this.driver.query<R>(sql, params);
    return result.rows[0] || null;
  }

  async rawExecute(sql: string, params?: any[]): Promise<number> {
    const result = await this.driver.execute(sql, params);
    return result.rowCount;
  }

  // ============ QUERY BUILDER ============

  query(): QueryBuilder<T> {
    return new QueryBuilder<T>(this.driver, this.tableName);
  }

  expression(): ExpressionBuilder {
    return ExpressionBuilder.create((i) => this.driver.getPlaceholder(i));
  }
}
