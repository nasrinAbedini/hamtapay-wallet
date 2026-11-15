import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { WalletService } from "../wallet/wallet.service";
import { LedgerService } from "../ledger/ledger.service";
import { PspAdapter } from "../integrations/psp.adapter";
import { IdempotencyService } from "../idempotency/idempotency.service";
import { amount, normalizeAmount } from "../common/money";
import { ApiError } from "../common/errors";
@Injectable()
export class PaymentService {
  constructor(
    private db: DataSource,
    private wallets: WalletService,
    private ledger: LedgerService,
    private psp: PspAdapter,
    private idem: IdempotencyService,
  ) {}
  create(dto: any, key?: string) {
    return this.idem.run("POST:/deposits", key, dto, async () => {
      const value = amount(dto.amount, dto.currency);
      if (dto.currency !== "IRR")
        throw new ApiError("UNSUPPORTED_CURRENCY", 422);
      const row = (
        await this.db.query(
          `INSERT INTO payments(user_id,amount,currency,status,order_id) VALUES($1,$2,$3,'PENDING',$4) RETURNING *`,
          [
            dto.userId,
            value,
            dto.currency,
            require("node:crypto").randomUUID(),
          ],
        )
      )[0];
      try {
        const result = await this.psp.create({
          orderId: row.order_id,
          amount: value,
          callbackUrl:
            process.env.PSP_CALLBACK_URL ??
            "http://app:3000/payments/psp/callback",
        });
        if (
          result.code !== 100 ||
          typeof result.token !== "string" ||
          typeof result.paymentUrl !== "string"
        )
          throw new ApiError("PSP_INVALID_RESPONSE", 502);
        await this.db.query(
          `UPDATE payments SET psp_token=$2,status='PAYMENT_INITIATED',updated_at=now() WHERE id=$1`,
          [row.id, result.token],
        );
        return {
          id: row.id,
          status: "PAYMENT_INITIATED",
          amount: value,
          currency: dto.currency,
          paymentUrl: result.paymentUrl,
        };
      } catch (e) {
        const errorCode =
          e instanceof ApiError ? (e.getResponse() as any).code : undefined;
        if (!["PSP_TIMEOUT", "PSP_UNAVAILABLE"].includes(errorCode))
          await this.db.query(
            `UPDATE payments SET status='FAILED',updated_at=now() WHERE id=$1`,
            [row.id],
          );
        throw e;
      }
    });
  }
  async get(id: string) {
    const r = await this.db.query(
      "SELECT id,user_id,amount,currency,status,provider_ref_id,created_at FROM payments WHERE id=$1",
      [id],
    );
    if (!r[0]) throw new ApiError("NOT_FOUND", 404);
    return r[0];
  }
  verifyById(id: string, key?: string) {
    return this.idem.run(
      `POST:/deposits/${id}/verify`,
      key,
      { id },
      async () => {
        const payment = (
          await this.db.query("SELECT * FROM payments WHERE id=$1", [id])
        )[0];
        if (!payment) throw new ApiError("NOT_FOUND", 404);
        if (["SUCCEEDED", "FAILED"].includes(payment.status))
          return { status: payment.status };
        if (!payment.psp_token) return { status: payment.status };
        return this.confirm(payment);
      },
    );
  }
  async callback(body: any) {
    if (
      !body ||
      typeof body.token !== "string" ||
      typeof body.orderId !== "string" ||
      !["OK", "NOK"].includes(body.status)
    )
      throw new ApiError("INVALID_CALLBACK", 400);
    const p = (
      await this.db.query(
        "SELECT * FROM payments WHERE psp_token=$1 AND order_id=$2",
        [body.token, body.orderId],
      )
    )[0];
    if (!p) throw new ApiError("INVALID_CALLBACK", 400);
    if (p.status === "SUCCEEDED" || p.status === "FAILED")
      return { status: p.status };
    if (
      body.amount !== undefined &&
      (typeof body.amount !== "string" ||
        normalizeAmount(body.amount) !== normalizeAmount(p.amount))
    )
      throw new ApiError("PAYMENT_MISMATCH", 422);
    return this.confirm(p);
  }

  private async confirm(p: any) {
    const providerPayment = await this.psp.paymentStatus(p.psp_token);
    if (
      providerPayment.token !== p.psp_token ||
      providerPayment.orderId !== p.order_id ||
      typeof providerPayment.amount !== "string" ||
      normalizeAmount(providerPayment.amount) !== normalizeAmount(p.amount)
    )
      throw new ApiError("PAYMENT_MISMATCH", 422);
    if (
      !["PAID", "VERIFIED", "FAILED", "REVERSED"].includes(
        String(providerPayment.status),
      )
    )
      return { status: p.status };
    const verified = await this.psp.verify(p.psp_token);
    if (![100, 101, -51, -54].includes(Number(verified.code)))
      throw new ApiError("PSP_VERIFICATION_PENDING", 503);
    const success =
      (verified.code === 100 && verified.status === "OK") ||
      (verified.code === 101 && verified.status === "ALREADY_VERIFIED");
    const definitivelyFailed =
      (verified.code === -51 && verified.status === "FAILED") ||
      (verified.code === -54 && verified.status === "EXPIRED");
    if (!success && !definitivelyFailed)
      throw new ApiError("PSP_VERIFICATION_PENDING", 503);
    if (
      success &&
      (typeof verified.amount !== "string" ||
        normalizeAmount(verified.amount) !== normalizeAmount(p.amount))
    )
      throw new ApiError("PAYMENT_MISMATCH", 422);
    if (success && typeof verified.refId !== "string")
      throw new ApiError("PSP_INVALID_RESPONSE", 502);
    await this.db.transaction(async (m) => {
      const locked = (
        await m.query("SELECT * FROM payments WHERE id=$1 FOR UPDATE", [p.id])
      )[0];
      if (locked.status === "SUCCEEDED" || locked.status === "FAILED") return;
      if (success) {
        const w = await this.wallets.ensure(m, p.user_id, p.currency);
        await m.query(
          "UPDATE wallets SET available_balance=available_balance+$2,updated_at=now() WHERE id=$1",
          [w.id, p.amount],
        );
        await this.ledger.record(m, {
          entries: [
            {
              account: "PSP_CLEARING",
              amount: p.amount,
              currency: p.currency,
              side: "DEBIT",
            },
            {
              account: "USER_WALLET_AVAILABLE",
              userId: p.user_id,
              amount: p.amount,
              currency: p.currency,
              side: "CREDIT",
            },
          ],
          referenceType: "PAYMENT",
          referenceId: p.id,
          userId: p.user_id,
          description: "PSP deposit",
        });
      }
      await m.query(
        `UPDATE payments SET status=$2,provider_ref_id=$3,updated_at=now() WHERE id=$1`,
        [
          p.id,
          success ? "SUCCEEDED" : "FAILED",
          success ? String(verified.refId) : "",
        ],
      );
    });
    return { status: success ? "SUCCEEDED" : "FAILED" };
  }
}
