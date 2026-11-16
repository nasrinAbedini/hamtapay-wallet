import { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { RawBodyRequest } from "@nestjs/common";
import { Request } from "express";
import { Test } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { InitialSchema1763000000000 } from "../src/database/migrations/1763000000000-InitialSchema";
import { AllowReturnedWithdrawal1763100000000 } from "../src/database/migrations/1763100000000-AllowReturnedWithdrawal";
import { WalletService } from "../src/wallet/wallet.service";
import { LedgerService } from "../src/ledger/ledger.service";
import { IdempotencyService } from "../src/idempotency/idempotency.service";
import { WithdrawalService } from "../src/withdrawal/withdrawal.service";
import { PayoutAdapter } from "../src/integrations/payout.adapter";
import { WithdrawalController } from "../src/withdrawal/withdrawal.controller";
import { ApiExceptionFilter } from "../src/common/exception.filter";
import { PayoutWebhookController } from "../src/webhooks/payout-webhook.controller";
import { WebhookSignatureService } from "../src/webhooks/webhook-signature.service";
import { toUnits } from "../src/common/money";

function envFile(): Record<string, string> {
  const path = resolve(process.cwd(), ".env");
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.trim().startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

const fileEnvironment = envFile();
const databaseUrl =
  process.env.TEST_DATABASE_URL ?? fileEnvironment.TEST_DATABASE_URL;
if (!databaseUrl)
  throw new Error(
    "TEST_DATABASE_URL is required. Configure a dedicated PostgreSQL test database; integration tests will not be skipped.",
  );
const testDatabase = new URL(databaseUrl);
const testDatabaseName = testDatabase.pathname.replace(/^\//, "");
if (!/_test$/i.test(testDatabaseName))
  throw new Error(
    "Refusing destructive test cleanup: TEST_DATABASE_URL must target a database whose name ends in _test.",
  );
const appDatabaseUrl = process.env.DATABASE_URL ?? fileEnvironment.DATABASE_URL;
if (appDatabaseUrl) {
  const appDatabase = new URL(appDatabaseUrl);
  if (
    appDatabase.hostname === testDatabase.hostname &&
    appDatabase.port === testDatabase.port &&
    appDatabase.pathname === testDatabase.pathname
  )
    throw new Error(
      "Refusing destructive test cleanup: TEST_DATABASE_URL resolves to DATABASE_URL.",
    );
}

describe("financial integration (real PostgreSQL)", () => {
  let db: DataSource;
  let wallet: WalletService;
  let withdrawal: WithdrawalService;
  let app: INestApplication;
  let apiBase: string;
  let payouts: {
    submit: (p: any) => Promise<any>;
    status: (id: string) => Promise<any>;
  };
  let payoutSubmit: jest.Mock;
  beforeAll(async () => {
    db = new DataSource({
      type: "postgres",
      url: databaseUrl,
      entities: [],
      migrations: [
        InitialSchema1763000000000,
        AllowReturnedWithdrawal1763100000000,
      ],
      synchronize: false,
    });
    try {
      await db.initialize();
    } catch (error) {
      throw new Error(
        `Cannot connect to the dedicated TEST_DATABASE_URL PostgreSQL database (${testDatabase.hostname}:${testDatabase.port || "5432"}/${testDatabaseName}). Start it with: docker compose --profile test up -d postgres-test. Integration tests will not be skipped.`,
        { cause: error },
      );
    }
    try {
      await db.runMigrations();
    } catch (error) {
      throw new Error(
        `TypeORM migrations failed on the dedicated test database '${testDatabaseName}'. No development database was selected.`,
        { cause: error },
      );
    }
    wallet = new WalletService(db);
    payoutSubmit = jest.fn(async () => ({ status: "UNKNOWN" }));
    payouts = {
      submit: (payload) => payoutSubmit(payload),
      status: async () => ({ status: "UNKNOWN" }),
    };
    withdrawal = new WithdrawalService(
      db,
      wallet,
      new LedgerService(),
      payouts as unknown as PayoutAdapter,
      new IdempotencyService(db),
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [WithdrawalController],
      providers: [{ provide: WithdrawalService, useValue: withdrawal }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.listen(0);
    const address = app.getHttpServer().address() as AddressInfo;
    apiBase = `http://127.0.0.1:${address.port}`;
    process.env.WEBHOOK_SECRET = "integration-test-webhook-secret";
  });
  beforeEach(async () => {
    payoutSubmit.mockReset();
    payoutSubmit.mockResolvedValue({ status: "UNKNOWN" });
    await db.query(
      "TRUNCATE idempotency_keys,withdrawals,payments,ledger_entries,wallets CASCADE",
    );
  });
  afterAll(async () => {
    if (app) await app.close();
    if (db?.isInitialized) await db.destroy();
  });
  async function postAdjustment(body: unknown, key = "adjustment-test-key") {
    const response = await fetch(`${apiBase}/internal/adjustments`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": key,
      },
      body: JSON.stringify(body),
    });
    return { response, body: await response.json() };
  }
  async function seedWallet(
    userId: string,
    available: string,
    reserved = "0",
    currency = "IRR",
  ) {
    await db.transaction(async (manager) => {
      await manager.query(
        "INSERT INTO wallets(user_id,currency,available_balance,reserved_balance) VALUES($1,$2,$3,$4)",
        [userId, currency, available, reserved],
      );
      if (toUnits(available) > 0n)
        await new LedgerService().record(manager, {
          entries: [
            {
              account: "ADJUSTMENT_CLEARING",
              amount: available,
              currency,
              side: "DEBIT",
            },
            {
              account: "USER_WALLET_AVAILABLE",
              userId,
              amount: available,
              currency,
              side: "CREDIT",
            },
          ],
          referenceType: "TEST_OPENING_BALANCE",
          referenceId: `${userId}-available`,
          userId,
          description: "Integration test opening available balance",
        });
      if (toUnits(reserved) > 0n)
        await new LedgerService().record(manager, {
          entries: [
            {
              account: "ADJUSTMENT_CLEARING",
              amount: reserved,
              currency,
              side: "DEBIT",
            },
            {
              account: "USER_WALLET_RESERVED",
              userId,
              amount: reserved,
              currency,
              side: "CREDIT",
            },
          ],
          referenceType: "TEST_OPENING_BALANCE",
          referenceId: `${userId}-reserved`,
          userId,
          description: "Integration test opening reserved balance",
        });
    });
  }
  async function postWithdrawal(
    userId: string,
    amount: string,
    key: string,
    currency = "IRR",
  ) {
    const response = await fetch(`${apiBase}/withdrawals`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": key,
      },
      body: JSON.stringify({
        userId,
        amount,
        currency,
        destination: "IR490000000000000000000000",
      }),
    });
    return { response, body: await response.json() };
  }
  async function assertFinancialInvariants(userId: string, currency = "IRR") {
    const row = (
      await db.query(
        "SELECT available_balance::text available,reserved_balance::text reserved FROM wallets WHERE user_id=$1 AND currency=$2",
        [userId, currency],
      )
    )[0];
    expect(row).toBeDefined();
    expect(toUnits(row.available)).toBeGreaterThanOrEqual(0n);
    expect(toUnits(row.reserved)).toBeGreaterThanOrEqual(0n);
    const ledgerBalances = await db.query(
      `SELECT account_code,COALESCE(sum(CASE WHEN entry_type='CREDIT' THEN amount ELSE -amount END),0)::text balance FROM ledger_entries WHERE related_user_id=$1 AND currency=$2 GROUP BY account_code`,
      [userId, currency],
    );
    const byAccount = new Map(
      ledgerBalances.map((entry: any) => [entry.account_code, entry.balance]),
    );
    expect(toUnits(row.available)).toBe(
      toUnits(String(byAccount.get("USER_WALLET_AVAILABLE") ?? "0")),
    );
    expect(toUnits(row.reserved)).toBe(
      toUnits(String(byAccount.get("USER_WALLET_RESERVED") ?? "0")),
    );
    const unbalanced = await db.query(
      `SELECT transaction_id,currency FROM ledger_entries GROUP BY transaction_id,currency HAVING sum(CASE WHEN entry_type='DEBIT' THEN amount ELSE -amount END)<>0`,
    );
    expect(unbalanced).toHaveLength(0);
    const duplicateOperations = await db.query(
      `SELECT reference_type,reference_id,currency FROM ledger_entries GROUP BY reference_type,reference_id,currency HAVING count(DISTINCT transaction_id)>1`,
    );
    expect(duplicateOperations).toHaveLength(0);
  }
  it("creates wallet lazily with zero balances", async () => {
    const user = "11111111-1111-4111-8111-111111111111";
    const result = await wallet.get(user);
    expect(result.available_balance).toBe("0.000000");
    expect(result.reserved_balance).toBe("0.000000");
  });
  it("creates a successful IRR withdrawal and reserves funds", async () => {
    const user = "22222222-2222-4222-8222-222222222222";
    await seedWallet(user, "300000");
    payoutSubmit.mockResolvedValue({ status: "PROCESSING" });
    const { response, body } = await postWithdrawal(user, "100000", "irr-ok");
    expect(response.status).toBe(201);
    expect(body).toMatchObject({
      user_id: user,
      currency: "IRR",
      status: "PROCESSING",
    });
    expect(payoutSubmit).toHaveBeenCalledTimes(1);
    expect(payoutSubmit.mock.calls[0][0]).toMatchObject({
      amount: "100000",
      currency: "IRR",
    });
    const rows = await db.query("SELECT * FROM withdrawals WHERE user_id=$1", [
      user,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].provider_request_id).toBe(
      payoutSubmit.mock.calls[0][0].requestId,
    );
    await assertFinancialInvariants(user);
  });
  it("rejects a withdrawal below the minimum without changing balances", async () => {
    const user = "33333333-3333-4333-8333-333333333333";
    await seedWallet(user, "200000");
    const { response, body } = await postWithdrawal(user, "99999", "below-min");
    expect(response.status).toBe(422);
    expect(body.code).toBe("BELOW_MINIMUM");
    expect(await db.query("SELECT id FROM withdrawals")).toHaveLength(0);
    await assertFinancialInvariants(user);
  });
  it("rejects insufficient funds without creating a withdrawal", async () => {
    const user = "33333333-3333-4333-8333-333333333334";
    await seedWallet(user, "99999");
    const { response, body } = await postWithdrawal(user, "100000", "too-poor");
    expect(response.status).toBe(422);
    expect(body.code).toBe("INSUFFICIENT_FUNDS");
    expect(await db.query("SELECT id FROM withdrawals")).toHaveLength(0);
    await assertFinancialInvariants(user);
  });
  it("reserves funds during a concurrent insufficient-funds race", async () => {
    const user = "22222222-2222-4222-8222-222222222223";
    await seedWallet(user, "150000");
    const results = await Promise.all([
      postWithdrawal(user, "100000", "race-a"),
      postWithdrawal(user, "100000", "race-b"),
    ]);
    expect(results.map((r) => r.response.status).sort()).toEqual([201, 422]);
    const rejected = results.find((r) => r.response.status === 422);
    expect(rejected?.body.code).toBe("INSUFFICIENT_FUNDS");
    const row = (
      await db.query(
        "SELECT available_balance::text available,reserved_balance::text reserved FROM wallets WHERE user_id=$1",
        [user],
      )
    )[0];
    expect(toUnits(row.available)).toBe(50_000n * 1_000_000n);
    expect(toUnits(row.reserved)).toBe(100_000n * 1_000_000n);
    expect(toUnits(row.reserved)).toBeLessThanOrEqual(150_000n * 1_000_000n);
    await assertFinancialInvariants(user);
  });
  it("enforces the daily limit across concurrent withdrawals", async () => {
    const user = "22222222-2222-4222-8222-222222222224";
    await seedWallet(user, "200100000");
    const initial = await postWithdrawal(user, "199900000", "daily-initial");
    expect(initial.response.status).toBe(201);
    const results = await Promise.all([
      postWithdrawal(user, "100000", "daily-a"),
      postWithdrawal(user, "100000", "daily-b"),
    ]);
    expect(results.map((r) => r.response.status).sort()).toEqual([201, 422]);
    expect(results.find((r) => r.response.status === 422)?.body.code).toBe(
      "DAILY_LIMIT_EXCEEDED",
    );
    const aggregate = await db.query(
      "SELECT COALESCE(sum(amount),0)::text total FROM withdrawals WHERE user_id=$1 AND currency='IRR' AND status IN ('PENDING','PROCESSING','UNKNOWN','SUCCEEDED')",
      [user],
    );
    expect(toUnits(aggregate[0].total)).toBe(200_000_000n * 1_000_000n);
    await assertFinancialInvariants(user);
  });
  it("settles a successful payout exactly once", async () => {
    const user = "44444444-4444-4444-8444-444444444445";
    await seedWallet(user, "200000");
    payoutSubmit.mockResolvedValue({ status: "SUCCEEDED" });
    const { response, body } = await postWithdrawal(
      user,
      "100000",
      "payout-success",
    );
    expect(response.status).toBe(201);
    expect(body.status).toBe("SUCCEEDED");
    const walletRow = (
      await db.query(
        "SELECT available_balance::text available,reserved_balance::text reserved FROM wallets WHERE user_id=$1",
        [user],
      )
    )[0];
    expect(walletRow.available).toBe("100000.000000");
    expect(walletRow.reserved).toBe("0.000000");
    expect(
      (
        await db.query(
          "SELECT id FROM ledger_entries WHERE reference_type='WITHDRAWAL_SETTLEMENT'",
        )
      ).length,
    ).toBe(1);
    await assertFinancialInvariants(user);
  });
  it("releases reserved funds when payout definitively fails", async () => {
    const user = "44444444-4444-4444-8444-444444444446";
    await seedWallet(user, "200000");
    payoutSubmit.mockResolvedValue({ status: "FAILED" });
    const { response, body } = await postWithdrawal(
      user,
      "100000",
      "payout-failed",
    );
    expect(response.status).toBe(201);
    expect(body.status).toBe("FAILED");
    const walletRow = (
      await db.query(
        "SELECT available_balance::text available,reserved_balance::text reserved FROM wallets WHERE user_id=$1",
        [user],
      )
    )[0];
    expect(walletRow.available).toBe("200000.000000");
    expect(walletRow.reserved).toBe("0.000000");
    expect(
      (
        await db.query(
          "SELECT id FROM ledger_entries WHERE reference_type='WITHDRAWAL_RELEASE'",
        )
      ).length,
    ).toBe(1);
    await assertFinancialInvariants(user);
  });
  it("keeps funds reserved when payout outcome is unknown", async () => {
    const user = "33333333-3333-4333-8333-333333333335";
    await seedWallet(user, "200000");
    payoutSubmit.mockResolvedValue({ status: "UNKNOWN" });
    const { response, body } = await postWithdrawal(
      user,
      "100000",
      "withdrawal-unknown",
    );
    expect(response.status).toBe(201);
    expect(body.status).toBe("UNKNOWN");
    await assertFinancialInvariants(user);
  });
  it("creates one withdrawal for concurrent identical idempotency requests", async () => {
    const user = "22222222-2222-4222-8222-222222222225";
    await seedWallet(user, "300000");
    payoutSubmit.mockResolvedValue({ status: "UNKNOWN" });
    const results = await Promise.all([
      postWithdrawal(user, "100000", "same-key"),
      postWithdrawal(user, "100000", "same-key"),
      postWithdrawal(user, "100000", "same-key"),
    ]);
    expect(results.every((r) => [201, 409].includes(r.response.status))).toBe(
      true,
    );
    expect(
      await db.query("SELECT id FROM withdrawals WHERE user_id=$1", [user]),
    ).toHaveLength(1);
    expect(payoutSubmit).toHaveBeenCalledTimes(1);
    expect(
      (
        await db.query(
          "SELECT id FROM ledger_entries WHERE reference_type='WITHDRAWAL_RESERVE'",
        )
      ).length,
    ).toBe(2);
    await assertFinancialInvariants(user);
  });
  it("rejects reused idempotency key with changed withdrawal payload", async () => {
    const user = "22222222-2222-4222-8222-222222222226";
    await seedWallet(user, "300000");
    const first = await postWithdrawal(user, "100000", "changed-key");
    const changed = await postWithdrawal(user, "200000", "changed-key");
    expect(first.response.status).toBe(201);
    expect(changed.response.status).toBe(422);
    expect(changed.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(
      await db.query("SELECT id FROM withdrawals WHERE user_id=$1", [user]),
    ).toHaveLength(1);
    await assertFinancialInvariants(user);
  });
  it("processes duplicate signed payout webhooks without double settlement", async () => {
    const user = "44444444-4444-4444-8444-444444444447";
    await seedWallet(user, "200000");
    payoutSubmit.mockResolvedValue({ status: "PROCESSING" });
    const created = await postWithdrawal(user, "100000", "webhook-withdrawal");
    const event = {
      event: "transfer.updated",
      eventId: "integration-event-1",
      requestId: created.body.provider_request_id,
      status: "SUCCEEDED",
      amount: "100000",
      currency: "IRR",
    };
    const rawBody = Buffer.from(JSON.stringify(event));
    const signature = createHmac("sha256", process.env.WEBHOOK_SECRET!)
      .update(rawBody)
      .digest("hex");
    const webhook = new PayoutWebhookController(
      new WebhookSignatureService(),
      new IdempotencyService(db),
      withdrawal,
    );
    const request = { rawBody } as RawBodyRequest<Request>;
    await webhook.payout(request, signature, event.eventId);
    await webhook.payout(request, signature, event.eventId);
    expect(
      (
        await db.query(
          "SELECT id FROM ledger_entries WHERE reference_type='WITHDRAWAL_SETTLEMENT'",
        )
      ).length,
    ).toBe(2);
    const final = (
      await db.query("SELECT status FROM withdrawals WHERE user_id=$1", [user])
    )[0];
    expect(final.status).toBe("SUCCEEDED");
    await assertFinancialInvariants(user);
  });
  it("returns settled funds to available balance on a RETURNED event", async () => {
    const user = "44444444-4444-4444-8444-444444444444";
    await seedWallet(user, "200000");
    payoutSubmit.mockResolvedValue({ status: "SUCCEEDED" });
    const created = await postWithdrawal(user, "100000", "withdrawal-returned");
    expect(created.body.status).toBe("SUCCEEDED");
    const returned = await withdrawal.handlePayoutEvent({
      event: "transfer.updated",
      eventId: "evt-returned-1",
      requestId: created.body.provider_request_id,
      status: "RETURNED",
      amount: "100000",
      currency: "IRR",
    });
    expect(returned.status).toBe("RETURNED");
    const row = (
      await db.query(
        "SELECT available_balance,reserved_balance FROM wallets WHERE user_id=$1",
        [user],
      )
    )[0];
    expect(row.available_balance).toBe("200000.000000");
    expect(row.reserved_balance).toBe("0.000000");
    await assertFinancialInvariants(user);
  });
  it("credits IRR once and records exactly two balanced ADJUSTMENT entries", async () => {
    const user = "55555555-5555-4555-8555-555555555555";
    await db.query(
      `INSERT INTO wallets(user_id,currency,available_balance,reserved_balance) VALUES($1,'IRR',50000,7000)`,
      [user],
    );
    const { response, body } = await postAdjustment({
      userId: user,
      currency: "IRR",
      amount: "100000",
      reason: "Manual balance correction",
    });
    expect(response.status).toBe(201);
    expect(body).toMatchObject({
      status: "SUCCEEDED",
      adjustmentId: expect.any(String),
      userId: user,
      currency: "IRR",
      amount: "100000",
    });
    const walletRow = (
      await db.query(
        "SELECT available_balance,reserved_balance FROM wallets WHERE user_id=$1 AND currency='IRR'",
        [user],
      )
    )[0];
    expect(walletRow.available_balance).toBe("150000.000000");
    expect(walletRow.reserved_balance).toBe("7000.000000");
    const entries = await db.query(
      "SELECT * FROM ledger_entries WHERE reference_type='ADJUSTMENT' AND reference_id=$1 ORDER BY entry_type",
      [body.adjustmentId],
    );
    expect(entries).toHaveLength(2);
    expect(
      entries.map((entry: any) => [entry.account_code, entry.entry_type]),
    ).toEqual([
      ["USER_WALLET_AVAILABLE", "CREDIT"],
      ["ADJUSTMENT_CLEARING", "DEBIT"],
    ]);
    expect(entries[0].transaction_id).toBe(entries[1].transaction_id);
    expect(entries[0].created_by_type).toBe("SYSTEM");
    expect(entries[0].created_by_id).toBeNull();
    expect(entries[0].description).toBe("Manual balance correction");
    const totals = await db.query(
      `SELECT sum(amount) FILTER (WHERE entry_type='DEBIT')::text debit, sum(amount) FILTER (WHERE entry_type='CREDIT')::text credit FROM ledger_entries WHERE reference_id=$1`,
      [body.adjustmentId],
    );
    expect(totals[0].debit).toBe(totals[0].credit);
  });
  it("supports USDT adjustment precision", async () => {
    const user = "66666666-6666-4666-8666-666666666666";
    const { response, body } = await postAdjustment({
      userId: user,
      currency: "USDT",
      amount: "12.345678",
      reason: "USDT correction",
    });
    expect(response.status).toBe(201);
    expect(body.amount).toBe("12.345678");
    const result = (
      await db.query(
        "SELECT available_balance::text available,reserved_balance::text reserved FROM wallets WHERE user_id=$1 AND currency='USDT'",
        [user],
      )
    )[0];
    expect(result.available).toBe("12.345678");
    expect(result.reserved).toBe("0.000000");
  });
  it("rejects invalid inputs and accepts unauthenticated adjustment requests", async () => {
    const base = {
      userId: "77777777-7777-4777-8777-777777777777",
      currency: "IRR",
      amount: "100000",
      reason: "Correction",
    };
    const invalidUuid = await postAdjustment({ ...base, userId: "bad" });
    expect(invalidUuid.response.status).toBe(400);
    const zero = await postAdjustment({ ...base, amount: "0" }, "zero-key");
    expect(zero.response.status).toBe(400);
    const negative = await postAdjustment(
      { ...base, amount: "-1" },
      "negative-key",
    );
    expect(negative.response.status).toBe(400);
    const fractionalIrr = await postAdjustment(
      { ...base, amount: "100.5" },
      "fractional-irr-key",
    );
    expect(fractionalIrr.response.status).toBe(400);
    const unsupportedCurrency = await postAdjustment(
      { ...base, currency: "EUR" },
      "unsupported-currency-key",
    );
    expect(unsupportedCurrency.response.status).toBe(400);
    const blankReason = await postAdjustment(
      { ...base, reason: "   " },
      "blank-reason-key",
    );
    expect(blankReason.response.status).toBe(400);
    const missingReason = await postAdjustment(
      { userId: base.userId, currency: base.currency, amount: base.amount },
      "missing-reason-key",
    );
    expect(missingReason.response.status).toBe(400);
    const unauthenticated = await postAdjustment(base, "unauthenticated-key");
    expect(unauthenticated.response.status).toBe(201);
  });
  it("replays identical idempotency keys and rejects changed payloads", async () => {
    const input = {
      userId: "88888888-8888-4888-8888-888888888888",
      currency: "IRR",
      amount: "120000",
      reason: "Replay test",
    };
    const first = await postAdjustment(input, "adjustment-replay-key");
    const replay = await postAdjustment(input, "adjustment-replay-key");
    expect(first.response.status).toBe(201);
    expect(replay.response.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    const changed = await postAdjustment(
      { ...input, amount: "130000" },
      "adjustment-replay-key",
    );
    expect(changed.response.status).toBe(422);
    const walletRow = (
      await db.query("SELECT available_balance FROM wallets WHERE user_id=$1", [
        input.userId,
      ])
    )[0];
    expect(walletRow.available_balance).toBe("120000.000000");
    const count = await db.query(
      "SELECT count(*)::int count FROM ledger_entries WHERE reference_type='ADJUSTMENT' AND related_user_id=$1",
      [input.userId],
    );
    expect(count[0].count).toBe(2);
  });
  it("serializes concurrent duplicate adjustment requests", async () => {
    const input = {
      userId: "99999999-9999-4999-8999-999999999999",
      currency: "IRR",
      amount: "140000",
      reason: "Concurrent replay test",
    };
    const results = await Promise.all([
      postAdjustment(input, "adjustment-concurrent-key"),
      postAdjustment(input, "adjustment-concurrent-key"),
    ]);
    expect(results).toHaveLength(2);
    expect(
      results.every((result) => [201, 409].includes(result.response.status)),
    ).toBe(true);
    expect(results.some((result) => result.response.status === 201)).toBe(true);
    if (results.every((result) => result.response.status === 201))
      expect(results[0].body).toEqual(results[1].body);
    const replay = await postAdjustment(input, "adjustment-concurrent-key");
    expect(replay.response.status).toBe(201);
    const walletRow = (
      await db.query("SELECT available_balance FROM wallets WHERE user_id=$1", [
        input.userId,
      ])
    )[0];
    expect(walletRow.available_balance).toBe("140000.000000");
    const count = await db.query(
      "SELECT count(*)::int count FROM ledger_entries WHERE reference_type='ADJUSTMENT' AND related_user_id=$1",
      [input.userId],
    );
    expect(count[0].count).toBe(2);
  });
  it("rolls back wallet balance when ledger insertion fails", async () => {
    const user = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    await db.query(
      `INSERT INTO wallets(user_id,currency,available_balance,reserved_balance) VALUES($1,'IRR',20000,5000)`,
      [user],
    );
    await db.query(`
      CREATE FUNCTION fail_adjustment_entry() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected ledger failure'; END $$;
      CREATE TRIGGER fail_adjustment_entry BEFORE INSERT ON ledger_entries
      FOR EACH ROW WHEN (NEW.reference_type = 'ADJUSTMENT')
      EXECUTE FUNCTION fail_adjustment_entry();
    `);
    try {
      const result = await postAdjustment(
        {
          userId: user,
          currency: "IRR",
          amount: "100000",
          reason: "Rollback test",
        },
        "adjustment-rollback-key",
      );
      expect(result.response.status).toBe(500);
    } finally {
      await db.query(`
        DROP TRIGGER IF EXISTS fail_adjustment_entry ON ledger_entries;
        DROP FUNCTION IF EXISTS fail_adjustment_entry();
      `);
    }
    const walletRow = (
      await db.query(
        "SELECT available_balance,reserved_balance FROM wallets WHERE user_id=$1 AND currency='IRR'",
        [user],
      )
    )[0];
    expect(walletRow.available_balance).toBe("20000.000000");
    expect(walletRow.reserved_balance).toBe("5000.000000");
    const entries = await db.query(
      "SELECT count(*)::int count FROM ledger_entries WHERE reference_type='ADJUSTMENT' AND related_user_id=$1",
      [user],
    );
    expect(entries[0].count).toBe(0);
  });
  it("does not create a separate adjustments table", async () => {
    const tables = await db.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='adjustments'",
    );
    expect(tables).toHaveLength(0);
  });
});
