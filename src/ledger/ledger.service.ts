import { Injectable } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { queryRows } from "../database/query-rows";
export type Entry = {
  account: string;
  userId?: string | null;
  amount: string;
  currency: string;
  side: "DEBIT" | "CREDIT";
};
@Injectable()
export class LedgerService {
  async record(
    m: EntityManager,
    input: {
      entries: Entry[];
      referenceType: string;
      referenceId: string;
      userId?: string | null;
      createdByType?: "SYSTEM" | "MANAGER";
      createdById?: string | null;
      description: string;
    },
  ) {
    const { entries } = input;
    const totals = new Map<string, { debit: bigint; credit: bigint }>();
    for (const e of entries) {
      const factor = 1_000_000n;
      const [w, f = ""] = e.amount.split(".");
      const v = BigInt(w) * factor + BigInt(f.padEnd(6, "0"));
      const t = totals.get(e.currency) ?? { debit: 0n, credit: 0n };
      t[e.side === "DEBIT" ? "debit" : "credit"] += v;
      totals.set(e.currency, t);
    }
    if (
      entries.length < 2 ||
      [...totals.values()].some((t) => t.debit !== t.credit)
    )
      throw new Error("Unbalanced ledger transaction");
    const txId = (
      await queryRows<{ id: string }>(m, "SELECT gen_random_uuid() id")
    )[0].id;
    for (const e of entries)
      await m.query(
        `INSERT INTO ledger_entries(transaction_id,account_code,related_user_id,reference_type,reference_id,amount,currency,entry_type,created_by_type,created_by_id,description) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          txId,
          e.account,
          e.userId ?? input.userId ?? null,
          input.referenceType,
          input.referenceId,
          e.amount,
          e.currency,
          e.side,
          input.createdByType ?? "SYSTEM",
          input.createdById ?? null,
          input.description,
        ],
      );
    return txId;
  }
}
