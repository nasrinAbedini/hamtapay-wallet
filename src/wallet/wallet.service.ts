import { Injectable } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { queryRows } from "../database/query-rows";

export type WalletRow = {
  id: string;
  user_id: string;
  currency: string;
  available_balance: string;
  reserved_balance: string;
  created_at: Date;
  updated_at: Date;
};

@Injectable()
export class WalletService {
  constructor(private readonly db: DataSource) {}
  async ensure(manager: EntityManager, userId: string, currency: string) {
    await manager.query(
      `INSERT INTO wallets(user_id,currency) VALUES($1,$2) ON CONFLICT(user_id,currency) DO NOTHING`,
      [userId, currency],
    );
    const rows = await queryRows<WalletRow>(
      manager,
      `SELECT * FROM wallets WHERE user_id=$1 AND currency=$2 FOR UPDATE`,
      [userId, currency],
    );
    return rows[0];
  }
  async get(userId: string) {
    return this.db.transaction(async (m) => {
      const rows = await queryRows<WalletRow>(
        m,
        `INSERT INTO wallets(user_id,currency) VALUES($1,'IRR') ON CONFLICT(user_id,currency) DO UPDATE SET user_id=EXCLUDED.user_id RETURNING *`,
        [userId],
      );
      return rows[0];
    });
  }
  async ledger(userId: string, cursor?: string, limit = 50) {
    const size = Math.min(Math.max(limit, 1), 100);
    const rows = cursor
      ? await queryRows<Record<string, unknown>>(
          this.db,
          `SELECT * FROM ledger_entries WHERE related_user_id=$1 AND (created_at,id)<(SELECT created_at,id FROM ledger_entries WHERE id=$2) ORDER BY created_at DESC,id DESC LIMIT $3`,
          [userId, cursor, size + 1],
        )
      : await queryRows<Record<string, unknown>>(
          this.db,
          `SELECT * FROM ledger_entries WHERE related_user_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2`,
          [userId, size + 1],
        );
    const hasMore = rows.length > size;
    const items = rows.slice(0, size);
    return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
  }
}
