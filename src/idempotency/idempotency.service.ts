import { HttpException, Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { hashRequest } from "../common/money";
import { ApiError } from "../common/errors";
@Injectable()
export class IdempotencyService {
  constructor(private readonly db: DataSource) {}
  async run<T>(
    scope: string,
    key: string | undefined,
    request: unknown,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!key) throw new ApiError("IDEMPOTENCY_KEY_REQUIRED", 400);
    const digest = hashRequest(request);
    const inserted = await this.db.query(
      `INSERT INTO idempotency_keys(scope,key,request_hash,status) VALUES($1,$2,$3,'IN_PROGRESS') ON CONFLICT(scope,key) DO NOTHING RETURNING id`,
      [scope, key, digest],
    );
    if (!inserted.length) {
      const row = (
        await this.db.query(
          `SELECT * FROM idempotency_keys WHERE scope=$1 AND key=$2`,
          [scope, key],
        )
      )[0];
      if (row.request_hash !== digest)
        throw new ApiError("IDEMPOTENCY_KEY_REUSED", 422);
      if (row.status === "COMPLETED") {
        const saved = row.response as any;
        if (saved?.__idempotencyError)
          throw new HttpException(
            saved.__idempotencyError.response,
            saved.__idempotencyError.status,
          );
        return saved as T;
      }
      throw new ApiError("IDEMPOTENCY_IN_PROGRESS", 409);
    }
    try {
      const result = await operation();
      await this.db.query(
        `UPDATE idempotency_keys SET response=$3::jsonb,status='COMPLETED' WHERE scope=$1 AND key=$2`,
        [scope, key, JSON.stringify(result)],
      );
      return result;
    } catch (error) {
      if (error instanceof HttpException)
        await this.db.query(
          `UPDATE idempotency_keys SET response=$3::jsonb,status='COMPLETED' WHERE scope=$1 AND key=$2`,
          [
            scope,
            key,
            JSON.stringify({
              __idempotencyError: {
                status: error.getStatus(),
                response: error.getResponse(),
              },
            }),
          ],
        );
      throw error;
    }
  }
}
