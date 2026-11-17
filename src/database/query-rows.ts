import { DataSource, EntityManager } from "typeorm";

type QueryExecutor = Pick<DataSource, "query"> | Pick<EntityManager, "query">;

/**
 * TypeORM's PostgreSQL driver returns SELECT/INSERT rows directly, but returns
 * UPDATE/DELETE results as [rows, affectedCount]. Expose row-producing queries
 * consistently as a flat row array for both DataSource and EntityManager.
 */
export async function queryRows<T extends Record<string, unknown>>(
  executor: QueryExecutor,
  sql: string,
  parameters?: unknown[],
): Promise<T[]> {
  const result: unknown = await executor.query(sql, parameters);
  if (!Array.isArray(result))
    throw new TypeError("Expected TypeORM raw query to return an array");

  if (
    result.length === 2 &&
    Array.isArray(result[0]) &&
    typeof result[1] === "number"
  )
    return result[0] as T[];

  return result as T[];
}
