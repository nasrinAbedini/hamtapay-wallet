import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import { WalletService } from "../wallet/wallet.service";
import { LedgerService } from "../ledger/ledger.service";
import { PayoutAdapter } from "../integrations/payout.adapter";
import { IdempotencyService } from "../idempotency/idempotency.service";
import { amount, normalizeAmount, toUnits } from "../common/money";
import { ApiError } from "../common/errors";
import { queryRows } from "../database/query-rows";
const qualifying = ["PENDING", "PROCESSING", "UNKNOWN", "SUCCEEDED"];
type WithdrawalRow = {
  id: string;
  user_id: string;
  amount: string;
  currency: string;
  destination: string;
  status: string;
  provider_request_id: string;
  created_at: Date;
  updated_at: Date;
};
@Injectable()
export class WithdrawalService {
  constructor(
    private db: DataSource,
    private wallets: WalletService,
    private ledger: LedgerService,
    private payout: PayoutAdapter,
    private idem: IdempotencyService,
    private config: ConfigService,
  ) {}
  create(dto: any, key?: string) {
    return this.idem.run("POST:/withdrawals", key, dto, async () => {
      const value = amount(dto.amount, dto.currency);
      if (dto.currency !== "IRR")
        throw new ApiError("UNSUPPORTED_WITHDRAWAL_CURRENCY", 422);
      if (toUnits(value) < 100000n * 1_000_000n)
        throw new ApiError("BELOW_MINIMUM", 422);
      const cooldownMinutes = this.cooldownMinutes();
      const dailyLimit = this.dailyWithdrawalLimit();
      const id = require("node:crypto").randomUUID();
      const providerId = require("node:crypto").randomUUID();
      await this.db.transaction(async (m) => {
        const w = await this.wallets.ensure(m, dto.userId, "IRR");
        if (dto.currency === "IRR" && cooldownMinutes > 0) {
          const recent = await queryRows<{ id: string }>(
            m,
            `SELECT id FROM withdrawals WHERE user_id=$1 AND currency='IRR' AND status=ANY($2) AND created_at > statement_timestamp() - ($3::int * interval '1 minute') LIMIT 1`,
            [
              dto.userId,
              ["PENDING", "PROCESSING", "UNKNOWN", "SUCCEEDED"],
              cooldownMinutes,
            ],
          );
          if (recent.length)
            throw new ApiError("WITHDRAWAL_COOLDOWN_ACTIVE", 429);
        }
        if (toUnits(w.available_balance) < toUnits(value))
          throw new ApiError("INSUFFICIENT_FUNDS", 422);
        const rows = await queryRows<{ total: string }>(
          m,
          `SELECT COALESCE(sum(amount),0)::text total FROM withdrawals WHERE user_id=$1 AND currency='IRR' AND status=ANY($2) AND created_at >= (date_trunc('day',now() AT TIME ZONE $3) AT TIME ZONE $3) AND created_at < ((date_trunc('day',now() AT TIME ZONE $3)+interval '1 day') AT TIME ZONE $3)`,
          [
            dto.userId,
            qualifying,
            this.config.get<string>("BUSINESS_TIMEZONE", "UTC"),
          ],
        );
        const alreadyWithdrawn = toUnits(rows[0].total);
        const requested = toUnits(value);
        if (alreadyWithdrawn + requested > dailyLimit) {
          const remaining =
            alreadyWithdrawn >= dailyLimit ? 0n : dailyLimit - alreadyWithdrawn;
          throw new ApiError(
            "DAILY_WITHDRAWAL_LIMIT_EXCEEDED",
            422,
            "Daily withdrawal limit exceeded",
            {
              dailyLimit: (dailyLimit / 1_000_000n).toString(),
              amountAlreadyWithdrawn: (
                alreadyWithdrawn / 1_000_000n
              ).toString(),
              remainingDailyAllowance: (remaining / 1_000_000n).toString(),
              requestedAmount: (requested / 1_000_000n).toString(),
              currency: "IRR",
            },
          );
        }
        await m.query(
          `INSERT INTO withdrawals(id,user_id,amount,currency,destination,status,provider_request_id) VALUES($1,$2,$3,'IRR',$4,'PENDING',$5)`,
          [id, dto.userId, value, dto.destination, providerId],
        );
        await m.query(
          `UPDATE wallets SET available_balance=available_balance-$2,reserved_balance=reserved_balance+$2,updated_at=now() WHERE id=$1`,
          [w.id, value],
        );
        await this.ledger.record(m, {
          entries: [
            {
              account: "USER_WALLET_AVAILABLE",
              userId: dto.userId,
              amount: value,
              currency: "IRR",
              side: "DEBIT",
            },
            {
              account: "USER_WALLET_RESERVED",
              userId: dto.userId,
              amount: value,
              currency: "IRR",
              side: "CREDIT",
            },
          ],
          referenceType: "WITHDRAWAL_RESERVE",
          referenceId: id,
          userId: dto.userId,
          description: "Withdrawal reserved",
        });
      });
      return this.process(id);
    });
  }
  private cooldownMinutes() {
    const value = Number(process.env.WITHDRAWAL_COOLDOWN_MINUTES ?? 30);
    if (!Number.isSafeInteger(value) || value < 0)
      throw new ApiError("INVALID_WITHDRAWAL_COOLDOWN_CONFIGURATION", 500);
    return value;
  }
  private dailyWithdrawalLimit() {
    const value = process.env.DAILY_WITHDRAWAL_LIMIT;
    if (!value || !/^[1-9]\d*$/.test(value))
      throw new ApiError("INVALID_DAILY_WITHDRAWAL_LIMIT_CONFIGURATION", 500);
    try {
      return BigInt(value) * 1_000_000n;
    } catch {
      throw new ApiError("INVALID_DAILY_WITHDRAWAL_LIMIT_CONFIGURATION", 500);
    }
  }
  async get(id: string) {
    const r = await queryRows<WithdrawalRow>(
      this.db,
      "SELECT * FROM withdrawals WHERE id=$1",
      [id],
    );
    if (!r[0]) throw new ApiError("NOT_FOUND", 404);
    return r[0];
  }
  adjustment(dto: any, key?: string) {
    return this.idem.run("POST:/internal/adjustments", key, dto, async () => {
      const value = amount(dto.amount, dto.currency);
      const adjustmentId = require("node:crypto").randomUUID();
      await this.db.transaction(async (m) => {
        const w = await this.wallets.ensure(m, dto.userId, dto.currency);
        await m.query(
          "UPDATE wallets SET available_balance=available_balance+$2,updated_at=now() WHERE id=$1",
          [w.id, value],
        );
        await this.ledger.record(m, {
          entries: [
            {
              account: "ADJUSTMENT_CLEARING",
              amount: value,
              currency: dto.currency,
              side: "DEBIT",
            },
            {
              account: "USER_WALLET_AVAILABLE",
              userId: dto.userId,
              amount: value,
              currency: dto.currency,
              side: "CREDIT",
            },
          ],
          referenceType: "ADJUSTMENT",
          referenceId: adjustmentId,
          userId: dto.userId,
          createdByType: "SYSTEM",
          createdById: null,
          description: dto.reason,
        });
      });
      return {
        adjustmentId,
        status: "SUCCEEDED",
        userId: dto.userId,
        currency: dto.currency,
        amount: value,
      };
    });
  }
  async process(id: string) {
    const claimed = await queryRows<WithdrawalRow>(
      this.db,
      `UPDATE withdrawals SET status='PROCESSING',updated_at=now() WHERE id=$1 AND (status IN ('PENDING','UNKNOWN') OR (status='PROCESSING' AND updated_at < now()-interval '2 minutes')) RETURNING *`,
      [id],
    );
    if (!claimed.length) return this.get(id);
    const w = claimed[0];
    try {
      const result = await this.payout.submit({
        requestId: w.provider_request_id,
        amount: (toUnits(w.amount) / 1_000_000n).toString(),
        currency: w.currency,
        destination: w.destination,
      });
      const state = String(result.status ?? "").toUpperCase();
      if (state === "SUCCEEDED") return this.finish(id, true);
      if (state === "FAILED") return this.finish(id, false);
      if (["ACCEPTED", "PROCESSING"].includes(state)) return this.get(id);
      await this.db.query(
        `UPDATE withdrawals SET status='UNKNOWN',updated_at=now() WHERE id=$1 AND status NOT IN ('SUCCEEDED','FAILED','RETURNED')`,
        [id],
      );
    } catch (e) {
      if (
        e instanceof ApiError &&
        (e.getResponse() as any).code === "PAYOUT_ERROR"
      )
        return this.finish(id, false);
      await this.db.query(
        `UPDATE withdrawals SET status='UNKNOWN',updated_at=now() WHERE id=$1 AND status NOT IN ('SUCCEEDED','FAILED','RETURNED')`,
        [id],
      );
    }
    return this.get(id);
  }
  async verify(id: string) {
    const w = (
      await queryRows<WithdrawalRow>(
        this.db,
        "SELECT * FROM withdrawals WHERE id=$1",
        [id],
      )
    )[0];
    if (!w) throw new ApiError("NOT_FOUND", 404);
    try {
      const r = await this.payout.status(w.provider_request_id);
      if (
        r &&
        (r.requestId !== w.provider_request_id ||
          typeof r.amount !== "string" ||
          normalizeAmount(r.amount) !== normalizeAmount(w.amount) ||
          r.currency !== w.currency ||
          r.destination !== w.destination)
      )
        throw new ApiError("PAYOUT_STATUS_MISMATCH", 502);
      const s = String(r?.status ?? "").toUpperCase();
      if (s === "SUCCEEDED") return this.finish(id, true);
      if (s === "FAILED") return this.finish(id, false);
      if (s === "RETURNED") return this.returned(id);
      if (["ACCEPTED", "PROCESSING"].includes(s)) {
        await this.db.query(
          `UPDATE withdrawals SET status='PROCESSING',updated_at=now() WHERE id=$1 AND status IN ('PENDING','PROCESSING','UNKNOWN')`,
          [id],
        );
      }
      return this.get(id);
    } catch {
      return this.get(id);
    }
  }
  async recover() {
    const rows = await queryRows<{ id: string }>(
      this.db,
      `SELECT id FROM withdrawals WHERE status='PENDING' OR (status='PROCESSING' AND updated_at < now()-interval '2 minutes') ORDER BY created_at LIMIT 100`,
    );
    const results = [];
    for (const r of rows) results.push(await this.process(r.id));
    return { processed: results.length, items: results };
  }
  async handlePayoutEvent(event: Record<string, unknown>) {
    if (
      event.event !== "transfer.updated" ||
      typeof event.eventId !== "string" ||
      typeof event.requestId !== "string" ||
      typeof event.status !== "string"
    )
      throw new ApiError("INVALID_PAYOUT_WEBHOOK", 400);
    const withdrawal = (
      await queryRows<WithdrawalRow>(
        this.db,
        "SELECT * FROM withdrawals WHERE provider_request_id=$1",
        [event.requestId],
      )
    )[0];
    if (!withdrawal) throw new ApiError("WITHDRAWAL_NOT_FOUND", 404);
    if (
      typeof event.amount !== "string" ||
      event.currency !== withdrawal.currency
    )
      throw new ApiError("PAYOUT_WEBHOOK_MISMATCH", 422);
    const eventAmount = this.payout.webhookAmountToToman(event.amount);
    if (normalizeAmount(eventAmount) !== normalizeAmount(withdrawal.amount))
      throw new ApiError("PAYOUT_WEBHOOK_MISMATCH", 422);
    switch (event.status.toUpperCase()) {
      case "ACCEPTED":
      case "PROCESSING":
        await this.db.query(
          `UPDATE withdrawals SET status='PROCESSING',updated_at=now() WHERE id=$1 AND status IN ('PENDING','PROCESSING','UNKNOWN')`,
          [withdrawal.id],
        );
        return this.get(withdrawal.id);
      case "SUCCEEDED":
        return this.finish(withdrawal.id, true);
      case "FAILED":
        return this.finish(withdrawal.id, false);
      case "RETURNED":
        return this.returned(withdrawal.id);
      default:
        throw new ApiError("INVALID_PAYOUT_WEBHOOK", 400);
    }
  }
  private async returned(id: string) {
    return this.db.transaction(async (m) => {
      const withdrawal = (
        await queryRows<WithdrawalRow>(
          m,
          "SELECT * FROM withdrawals WHERE id=$1 FOR UPDATE",
          [id],
        )
      )[0];
      if (!withdrawal) throw new ApiError("NOT_FOUND", 404);
      if (["FAILED", "RETURNED"].includes(withdrawal.status)) return withdrawal;
      if (withdrawal.status === "SUCCEEDED") {
        const wallet = await this.wallets.ensure(
          m,
          withdrawal.user_id,
          withdrawal.currency,
        );
        await m.query(
          "UPDATE wallets SET available_balance=available_balance+$2,updated_at=now() WHERE id=$1",
          [wallet.id, withdrawal.amount],
        );
        await this.ledger.record(m, {
          entries: [
            {
              account: "PAYOUT_CLEARING",
              amount: withdrawal.amount,
              currency: withdrawal.currency,
              side: "DEBIT",
            },
            {
              account: "USER_WALLET_AVAILABLE",
              userId: withdrawal.user_id,
              amount: withdrawal.amount,
              currency: withdrawal.currency,
              side: "CREDIT",
            },
          ],
          referenceType: "WITHDRAWAL_RETURN",
          referenceId: id,
          userId: withdrawal.user_id,
          description: "Returned payout credited back to wallet",
        });
      } else {
        const wallet = await this.wallets.ensure(
          m,
          withdrawal.user_id,
          withdrawal.currency,
        );
        await m.query(
          "UPDATE wallets SET reserved_balance=reserved_balance-$2,available_balance=available_balance+$2,updated_at=now() WHERE id=$1",
          [wallet.id, withdrawal.amount],
        );
        await this.ledger.record(m, {
          entries: [
            {
              account: "USER_WALLET_RESERVED",
              userId: withdrawal.user_id,
              amount: withdrawal.amount,
              currency: withdrawal.currency,
              side: "DEBIT",
            },
            {
              account: "USER_WALLET_AVAILABLE",
              userId: withdrawal.user_id,
              amount: withdrawal.amount,
              currency: withdrawal.currency,
              side: "CREDIT",
            },
          ],
          referenceType: "WITHDRAWAL_RETURN",
          referenceId: id,
          userId: withdrawal.user_id,
          description: "Returned payout released from reservation",
        });
      }
      return (
        await queryRows<WithdrawalRow>(
          m,
          "UPDATE withdrawals SET status='RETURNED',updated_at=now() WHERE id=$1 RETURNING *",
          [id],
        )
      )[0];
    });
  }
  private async finish(id: string, success: boolean) {
    return this.db.transaction(async (m) => {
      const w = (
        await queryRows<WithdrawalRow>(
          m,
          "SELECT * FROM withdrawals WHERE id=$1 FOR UPDATE",
          [id],
        )
      )[0];
      if (!w) throw new ApiError("NOT_FOUND", 404);
      if (["FAILED", "SUCCEEDED", "RETURNED"].includes(w.status)) return w;
      const wallet = await this.wallets.ensure(m, w.user_id, w.currency);
      if (success) {
        await m.query(
          "UPDATE wallets SET reserved_balance=reserved_balance-$2,updated_at=now() WHERE id=$1",
          [wallet.id, w.amount],
        );
        await this.ledger.record(m, {
          entries: [
            {
              account: "USER_WALLET_RESERVED",
              userId: w.user_id,
              amount: w.amount,
              currency: w.currency,
              side: "DEBIT",
            },
            {
              account: "PAYOUT_CLEARING",
              amount: w.amount,
              currency: w.currency,
              side: "CREDIT",
            },
          ],
          referenceType: "WITHDRAWAL_SETTLEMENT",
          referenceId: id,
          userId: w.user_id,
          description: "Payout settled",
        });
      } else {
        await m.query(
          "UPDATE wallets SET reserved_balance=reserved_balance-$2,available_balance=available_balance+$2,updated_at=now() WHERE id=$1",
          [wallet.id, w.amount],
        );
        await this.ledger.record(m, {
          entries: [
            {
              account: "USER_WALLET_RESERVED",
              userId: w.user_id,
              amount: w.amount,
              currency: w.currency,
              side: "DEBIT",
            },
            {
              account: "USER_WALLET_AVAILABLE",
              userId: w.user_id,
              amount: w.amount,
              currency: w.currency,
              side: "CREDIT",
            },
          ],
          referenceType: "WITHDRAWAL_RELEASE",
          referenceId: id,
          userId: w.user_id,
          description: "Failed payout released",
        });
      }
      return (
        await queryRows<WithdrawalRow>(
          m,
          `UPDATE withdrawals SET status=$2,updated_at=now() WHERE id=$1 RETURNING *`,
          [id, success ? "SUCCEEDED" : "FAILED"],
        )
      )[0];
    });
  }
}
