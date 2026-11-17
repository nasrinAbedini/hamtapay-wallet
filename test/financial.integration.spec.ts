import { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { RawBodyRequest } from "@nestjs/common";
import { Request } from "express";
import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
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
import { validateEnvironment } from "../src/config/environment";

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
  let originalCooldown: string | undefined;
  let originalDailyLimit: string | undefined;
  let originalBusinessTimezone: string | undefined;
  let withdrawalConfig: ConfigService;
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
    originalCooldown = process.env.WITHDRAWAL_COOLDOWN_MINUTES;
    process.env.WITHDRAWAL_COOLDOWN_MINUTES = "30";
    originalDailyLimit = process.env.DAILY_WITHDRAWAL_LIMIT;
    process.env.DAILY_WITHDRAWAL_LIMIT = "200000000";
    originalBusinessTimezone = process.env.BUSINESS_TIMEZONE;
    process.env.BUSINESS_TIMEZONE = "UTC";
    withdrawalConfig = new ConfigService({ BUSINESS_TIMEZONE: "UTC" });
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
      withdrawalConfig,
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
    withdrawalConfig?.set("BUSINESS_TIMEZONE", "UTC");
    await db.query(
      "TRUNCATE idempotency_keys,withdrawals,payments,ledger_entries,wallets CASCADE",
    );
  });
  afterAll(async () => {
    if (app) await app.close();
    if (db?.isInitialized) await db.destroy();
    if (originalCooldown === undefined)
      delete process.env.WITHDRAWAL_COOLDOWN_MINUTES;
    else process.env.WITHDRAWAL_COOLDOWN_MINUTES = originalCooldown;
    if (originalDailyLimit === undefined)
      delete process.env.DAILY_WITHDRAWAL_LIMIT;
    else process.env.DAILY_WITHDRAWAL_LIMIT = originalDailyLimit;
    if (originalBusinessTimezone === undefined)
      delete process.env.BUSINESS_TIMEZONE;
    else process.env.BUSINESS_TIMEZONE = originalBusinessTimezone;
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
  async function sendPayoutWebhook(event: Record<string, unknown>) {
    const rawBody = Buffer.from(JSON.stringify(event));
    const signature = createHmac("sha256", process.env.WEBHOOK_SECRET!)
      .update(rawBody)
      .digest("hex");
    const webhook = new PayoutWebhookController(
      new WebhookSignatureService(),
      new IdempotencyService(db),
      withdrawal,
    );
    return webhook.payout(
      { rawBody } as RawBodyRequest<Request>,
      signature,
      event.eventId as string,
    );
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
    const previousCooldown = process.env.WITHDRAWAL_COOLDOWN_MINUTES;
    process.env.WITHDRAWAL_COOLDOWN_MINUTES = "0";
    try {
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
    } finally {
      if (previousCooldown === undefined)
        delete process.env.WITHDRAWAL_COOLDOWN_MINUTES;
      else process.env.WITHDRAWAL_COOLDOWN_MINUTES = previousCooldown;
    }
  });

  it("enforces the daily limit across concurrent withdrawals", async () => {
    const user = "22222222-2222-4222-8222-222222222224";
    await seedWallet(user, "200100000");

    process.env.WITHDRAWAL_COOLDOWN_MINUTES = "0";

    try {
      const initial = await postWithdrawal(user, "199900000", "daily-initial");

      expect(initial.response.status).toBe(201);

      const ledgerBeforeRace = await db.query(
        "SELECT count(*)::int count FROM ledger_entries WHERE related_user_id=$1",
        [user],
      );

      const results = await Promise.all([
        postWithdrawal(user, "100000", "daily-a"),
        postWithdrawal(user, "100000", "daily-b"),
      ]);

      expect(results.map((r) => r.response.status).sort()).toEqual([201, 422]);

      const rejected = results.find((r) => r.response.status === 422);

      expect(rejected?.body.code).toBe("DAILY_WITHDRAWAL_LIMIT_EXCEEDED");

      expect(rejected?.body.details).toMatchObject({
        dailyLimit: "200000000",
        amountAlreadyWithdrawn: "200000000",
        remainingDailyAllowance: "0",
        requestedAmount: "100000",
        currency: "IRR",
      });

      const aggregate = await db.query(
        `SELECT COALESCE(sum(amount), 0)::text total
       FROM withdrawals
       WHERE user_id = $1
         AND currency = 'IRR'
         AND status IN ('PENDING', 'PROCESSING', 'UNKNOWN', 'SUCCEEDED')`,
        [user],
      );

      expect(toUnits(aggregate[0].total)).toBe(200_000_000n * 1_000_000n);

      const ledgerAfterRace = await db.query(
        "SELECT count(*)::int count FROM ledger_entries WHERE related_user_id=$1",
        [user],
      );

      expect(ledgerAfterRace[0].count - ledgerBeforeRace[0].count).toBe(2);

      await assertFinancialInvariants(user);
    } finally {
      process.env.WITHDRAWAL_COOLDOWN_MINUTES = "30";
    }
  });

  it("allows requests below and exactly at the configured daily limit", async () => {
    process.env.WITHDRAWAL_COOLDOWN_MINUTES = "0";
    const belowUser = "22222222-2222-4222-8222-222222222241";
    await seedWallet(belowUser, "200000");
    expect(
      (await postWithdrawal(belowUser, "199999", "limit-below")).response
        .status,
    ).toBe(201);
    const exactUser = "22222222-2222-4222-8222-222222222242";
    await seedWallet(exactUser, "200000000");
    expect(
      (await postWithdrawal(exactUser, "200000000", "limit-exact")).response
        .status,
    ).toBe(201);
  });
  it.each(["PENDING", "PROCESSING", "UNKNOWN", "SUCCEEDED"])(
    "%s withdrawals count toward the daily allowance",
    async (status) => {
      process.env.WITHDRAWAL_COOLDOWN_MINUTES = "0";

      const user = `33333333-3333-4333-8333-${String(
        333333330000 +
          ["PENDING", "PROCESSING", "UNKNOWN", "SUCCEEDED"].indexOf(status),
      ).slice(-12)}`;

      await seedWallet(user, "200000000");

      await db.query(
        `INSERT INTO withdrawals(user_id, amount, currency, destination, status)
       VALUES($1, '200000000', 'IRR', 'test', $2)`,
        [user, status],
      );

      const result = await postWithdrawal(user, "100000", `counts-${status}`);

      expect(result.response.status).toBe(422);
      expect(result.body.code).toBe("DAILY_WITHDRAWAL_LIMIT_EXCEEDED");
    },
  );
  it.each(["FAILED", "RETURNED"])(
    "%s withdrawals do not count toward the daily allowance",
    async (status) => {
      process.env.WITHDRAWAL_COOLDOWN_MINUTES = "0";
      const user = `44444444-4444-4444-8444-${String(444444440000 + ["FAILED", "RETURNED"].indexOf(status)).slice(-12)}`;
      await seedWallet(user, "200000");
      await db.query(
        "INSERT INTO withdrawals(user_id,amount,currency,destination,status) VALUES($1,'100000','IRR','test',$2)",
        [user, status],
      );
      expect(
        (await postWithdrawal(user, "200000", `excluded-${status}`)).response
          .status,
      ).toBe(201);
    },
  );
  it.each(["UTC", "Europe/Berlin"])(
    "uses %s calendar-day boundaries, including start and excluding next-day start",
    async (timezone) => {
      process.env.WITHDRAWAL_COOLDOWN_MINUTES = "0";
      withdrawalConfig.set("BUSINESS_TIMEZONE", timezone);
      const index = ["UTC", "Europe/Berlin"].indexOf(timezone);
      const includedUser = `55555555-5555-4555-8555-${String(555555550000 + index * 2).slice(-12)}`;
      await seedWallet(includedUser, "200000000");
      await db.query(
        `INSERT INTO withdrawals(user_id,amount,currency,destination,status,created_at)
         VALUES($1,'100000000','IRR','test','PENDING',
           date_trunc('day',now() AT TIME ZONE $2) AT TIME ZONE $2)`,
        [includedUser, timezone],
      );
      const included = await postWithdrawal(
        includedUser,
        "100000001",
        `boundary-start-${timezone}`,
      );
      expect(included.response.status).toBe(422);
      expect(included.body.code).toBe("DAILY_WITHDRAWAL_LIMIT_EXCEEDED");

      const excludedUser = `55555555-5555-4555-8555-${String(555555550001 + index * 2).slice(-12)}`;
      await seedWallet(excludedUser, "200000000");
      await db.query(
        `INSERT INTO withdrawals(user_id,amount,currency,destination,status,created_at)
         VALUES($1,'200000000','IRR','test','PENDING',
           (date_trunc('day',now() AT TIME ZONE $2)+interval '1 day') AT TIME ZONE $2)`,
        [excludedUser, timezone],
      );
      expect(
        (
          await postWithdrawal(
            excludedUser,
            "200000000",
            `boundary-end-${timezone}`,
          )
        ).response.status,
      ).toBe(201);
    },
  );
  it("uses a 23 or 25 hour day across Berlin daylight-saving transitions", async () => {
    const durations = await db.query(
      `SELECT
         extract(epoch FROM ((timestamp '2024-04-01 00:00:00' AT TIME ZONE $1) - (timestamp '2024-03-31 00:00:00' AT TIME ZONE $1)))::int spring,
         extract(epoch FROM ((timestamp '2024-10-28 00:00:00' AT TIME ZONE $1) - (timestamp '2024-10-27 00:00:00' AT TIME ZONE $1)))::int autumn`,
      ["Europe/Berlin"],
    );
    expect(durations[0].spring).toBe(23 * 60 * 60);
    expect(durations[0].autumn).toBe(25 * 60 * 60);
  });
  it("defaults the business timezone to UTC and rejects invalid identifiers", () => {
    expect(validateEnvironment({}).BUSINESS_TIMEZONE).toBe("UTC");
    expect(() =>
      validateEnvironment({ BUSINESS_TIMEZONE: "Mars/Olympus" }),
    ).toThrow("Invalid BUSINESS_TIMEZONE configuration");
  });
  it("calculates usage separately for different UTC calendar days", async () => {
    process.env.WITHDRAWAL_COOLDOWN_MINUTES = "0";
    withdrawalConfig.set("BUSINESS_TIMEZONE", "UTC");
    const user = "55555555-5555-4555-8555-555555555551";
    await seedWallet(user, "200000");
    await db.query(
      "INSERT INTO withdrawals(user_id,amount,currency,destination,status,created_at) VALUES($1,'200000','IRR','test','PENDING',date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' - interval '1 day')",
      [user],
    );
    expect(
      (await postWithdrawal(user, "200000", "different-day")).response.status,
    ).toBe(201);
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
    expect(Array.isArray(body)).toBe(false);
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
    ).toBe(2);
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
    expect(Array.isArray(body)).toBe(false);
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
    ).toBe(2);
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
  it("reuses the persisted provider request ID when retrying an UNKNOWN withdrawal", async () => {
    const user = "33333333-3333-4333-8333-333333333345";
    await seedWallet(user, "200000");
    const first = await postWithdrawal(user, "100000", "stable-provider-id");
    expect(first.body.status).toBe("UNKNOWN");
    const stored = (
      await db.query(
        "SELECT id,provider_request_id FROM withdrawals WHERE user_id=$1",
        [user],
      )
    )[0];
    payoutSubmit.mockResolvedValue({ status: "PROCESSING" });
    await withdrawal.process(stored.id);
    expect(payoutSubmit).toHaveBeenCalledTimes(2);
    expect(payoutSubmit.mock.calls[1][0].requestId).toBe(
      stored.provider_request_id,
    );
    expect(
      await db.query("SELECT id FROM withdrawals WHERE user_id=$1", [user]),
    ).toHaveLength(1);
    await assertFinancialInvariants(user);
  });
  it("maps an actual payout HTTP timeout to UNKNOWN and keeps funds reserved", async () => {
    const user = "33333333-3333-4333-8333-333333333336";
    await seedWallet(user, "200000");
    let received:
      | { method: string; url: string; body: Record<string, unknown> }
      | undefined;
    const provider = createServer((request, _response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received = {
          method: request.method ?? "",
          url: request.url ?? "",
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        };
        // Deliberately leave the request unanswered so the adapter's own
        // AbortController timeout is exercised.
      });
    });
    await new Promise<void>((resolve, reject) => {
      provider.once("error", reject);
      provider.listen(0, "127.0.0.1", resolve);
    });
    const address = provider.address() as AddressInfo;
    const previousBaseUrl = process.env.PAYOUT_BASE_URL;
    const previousTimeout = process.env.PROVIDER_TIMEOUT_MS;
    process.env.PAYOUT_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.PROVIDER_TIMEOUT_MS = "500";
    payoutSubmit.mockImplementation((payload) =>
      new PayoutAdapter().submit(payload),
    );
    try {
      const { response, body } = await postWithdrawal(
        user,
        "100000",
        "real-adapter-timeout",
      );
      expect(response.status).toBe(201);
      expect(body.status).toBe("UNKNOWN");
      expect(received).toMatchObject({
        method: "POST",
        url: "/payout/transfers",
        body: {
          requestId: body.provider_request_id,
          amount: "100000",
          currency: "IRR",
          type: "IBAN",
        },
      });
      await assertFinancialInvariants(user);
      const walletRow = (
        await db.query(
          "SELECT available_balance::text available,reserved_balance::text reserved FROM wallets WHERE user_id=$1",
          [user],
        )
      )[0];
      expect(walletRow.available).toBe("100000.000000");
      expect(walletRow.reserved).toBe("100000.000000");
    } finally {
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      if (previousBaseUrl === undefined) delete process.env.PAYOUT_BASE_URL;
      else process.env.PAYOUT_BASE_URL = previousBaseUrl;
      if (previousTimeout === undefined) delete process.env.PROVIDER_TIMEOUT_MS;
      else process.env.PROVIDER_TIMEOUT_MS = previousTimeout;
    }
  });
  it("rejects a new IRR withdrawal while the cooldown is active", async () => {
    const user = "33333333-3333-4333-8333-333333333337";
    await seedWallet(user, "300000");
    const previousCooldown = process.env.WITHDRAWAL_COOLDOWN_MINUTES;
    process.env.WITHDRAWAL_COOLDOWN_MINUTES = "30";
    try {
      const first = await postWithdrawal(user, "100000", "cooldown-first");
      expect(first.response.status).toBe(201);
      const before = (
        await db.query(
          "SELECT available_balance::text available,reserved_balance::text reserved FROM wallets WHERE user_id=$1",
          [user],
        )
      )[0];
      const ledgerEntriesBefore = await db.query(
        "SELECT id FROM ledger_entries WHERE reference_type='WITHDRAWAL_RESERVE' AND related_user_id=$1",
        [user],
      );
      expect(ledgerEntriesBefore).toHaveLength(2);

      const second = await postWithdrawal(user, "100000", "cooldown-second");
      expect(second.response.status).toBe(429);
      expect(second.body.code).toBe("WITHDRAWAL_COOLDOWN_ACTIVE");
      expect(
        await db.query("SELECT id FROM withdrawals WHERE user_id=$1", [user]),
      ).toHaveLength(1);
      expect(
        await db.query(
          "SELECT id FROM ledger_entries WHERE reference_type='WITHDRAWAL_RESERVE' AND related_user_id=$1",
          [user],
        ),
      ).toHaveLength(ledgerEntriesBefore.length);
      const after = (
        await db.query(
          "SELECT available_balance::text available,reserved_balance::text reserved FROM wallets WHERE user_id=$1",
          [user],
        )
      )[0];
      expect(after).toEqual(before);
      expect(payoutSubmit).toHaveBeenCalledTimes(1);
      await assertFinancialInvariants(user);
    } finally {
      if (previousCooldown === undefined)
        delete process.env.WITHDRAWAL_COOLDOWN_MINUTES;
      else process.env.WITHDRAWAL_COOLDOWN_MINUTES = previousCooldown;
    }
  });
  it.each([
    ["PENDING", "33333333-3333-4333-8333-333333333342"],
    ["PROCESSING", "33333333-3333-4333-8333-333333333343"],
    ["SUCCEEDED", "33333333-3333-4333-8333-333333333344"],
  ])("cooldown includes a recent %s withdrawal", async (status, user) => {
    process.env.WITHDRAWAL_COOLDOWN_MINUTES = "30";
    await seedWallet(user, "300000");
    if (status === "PROCESSING")
      payoutSubmit.mockResolvedValue({ status: "PROCESSING" });
    if (status === "SUCCEEDED")
      payoutSubmit.mockResolvedValue({ status: "SUCCEEDED" });
    const first = await postWithdrawal(user, "100000", `cooldown-${status}`);
    expect(first.response.status).toBe(201);
    if (status === "PENDING")
      await db.query(
        "UPDATE withdrawals SET status='PENDING' WHERE user_id=$1",
        [user],
      );
    const second = await postWithdrawal(user, "100000", `after-${status}`);
    expect(second.response.status).toBe(429);
    expect(second.body.code).toBe("WITHDRAWAL_COOLDOWN_ACTIVE");
    await assertFinancialInvariants(user);
  });
  it("allows a withdrawal after the configured cooldown expires", async () => {
    const user = "33333333-3333-4333-8333-333333333338";
    await seedWallet(user, "300000");
    const previousCooldown = process.env.WITHDRAWAL_COOLDOWN_MINUTES;
    process.env.WITHDRAWAL_COOLDOWN_MINUTES = "2";
    payoutSubmit.mockResolvedValue({ status: "SUCCEEDED" });
    try {
      const first = await postWithdrawal(user, "100000", "cooldown-expiry-a");
      expect(first.response.status).toBe(201);
      await db.query(
        "UPDATE withdrawals SET created_at=statement_timestamp()-interval '3 minutes' WHERE user_id=$1",
        [user],
      );
      const second = await postWithdrawal(user, "100000", "cooldown-expiry-b");
      expect(second.response.status).toBe(201);
      expect(second.body.status).toBe("SUCCEEDED");
      expect(
        await db.query("SELECT id FROM withdrawals WHERE user_id=$1", [user]),
      ).toHaveLength(2);
      await assertFinancialInvariants(user);
    } finally {
      if (previousCooldown === undefined)
        delete process.env.WITHDRAWAL_COOLDOWN_MINUTES;
      else process.env.WITHDRAWAL_COOLDOWN_MINUTES = previousCooldown;
    }
  });
  it("does not report an IRR cooldown for unsupported USDT withdrawals", async () => {
    const user = "33333333-3333-4333-8333-333333333339";
    await seedWallet(user, "200000");
    const recent = await postWithdrawal(user, "100000", "irr-before-usdt");
    expect(recent.response.status).toBe(201);
    const unsupported = withdrawal.create(
      {
        userId: user,
        amount: "100000",
        currency: "USDT",
        destination: "IR490000000000000000000000",
      },
      "unsupported-usdt",
    );
    await expect(unsupported).rejects.toMatchObject({
      response: { code: "UNSUPPORTED_WITHDRAWAL_CURRENCY" },
    });
  });
  it("allows a new withdrawal after a prior payout definitively failed", async () => {
    const user = "33333333-3333-4333-8333-333333333340";
    await seedWallet(user, "200000");
    payoutSubmit.mockResolvedValueOnce({ status: "FAILED" });
    payoutSubmit.mockResolvedValueOnce({ status: "UNKNOWN" });
    const first = await postWithdrawal(user, "100000", "failed-then-new-a");
    expect(first.body.status).toBe("FAILED");
    const second = await postWithdrawal(user, "100000", "failed-then-new-b");
    expect(second.response.status).toBe(201);
    expect(second.body.status).toBe("UNKNOWN");
    expect(
      await db.query("SELECT id FROM withdrawals WHERE user_id=$1", [user]),
    ).toHaveLength(2);
    await assertFinancialInvariants(user);
  });
  it("serializes concurrent requests against the IRR cooldown", async () => {
    const user = "33333333-3333-4333-8333-333333333341";
    await seedWallet(user, "300000");
    const results = await Promise.all([
      postWithdrawal(user, "100000", "cooldown-race-a"),
      postWithdrawal(user, "100000", "cooldown-race-b"),
    ]);
    expect(results.map((result) => result.response.status).sort()).toEqual([
      201, 429,
    ]);
    expect(
      results.find((result) => result.response.status === 429)?.body.code,
    ).toBe("WITHDRAWAL_COOLDOWN_ACTIVE");
    expect(
      await db.query("SELECT id FROM withdrawals WHERE user_id=$1", [user]),
    ).toHaveLength(1);
    expect(payoutSubmit).toHaveBeenCalledTimes(1);
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
  it("replays a withdrawal with the same idempotency key without a second payout", async () => {
    const user = "22222222-2222-4222-8222-222222222227";
    await seedWallet(user, "300000");
    payoutSubmit.mockResolvedValue({ status: "UNKNOWN" });
    const first = await postWithdrawal(user, "100000", "withdrawal-replay");
    const replay = await postWithdrawal(user, "100000", "withdrawal-replay");
    expect(first.response.status).toBe(201);
    expect(replay.response.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    expect(
      await db.query("SELECT id FROM withdrawals WHERE user_id=$1", [user]),
    ).toHaveLength(1);
    expect(payoutSubmit).toHaveBeenCalledTimes(1);
    expect(
      await db.query(
        "SELECT id FROM ledger_entries WHERE reference_type='WITHDRAWAL_RESERVE'",
      ),
    ).toHaveLength(2);
    await assertFinancialInvariants(user);
  });
  it("settles an UNKNOWN withdrawal from a webhook and ignores its duplicate", async () => {
    const user = "44444444-4444-4444-8444-444444444447";
    await seedWallet(user, "200000");
    payoutSubmit.mockResolvedValue({ status: "UNKNOWN" });
    const created = await postWithdrawal(user, "100000", "webhook-withdrawal");
    expect(created.body.status).toBe("UNKNOWN");
    const event = {
      event: "transfer.updated",
      eventId: "integration-event-1",
      requestId: created.body.provider_request_id,
      status: "SUCCEEDED",
      amount: "100000",
      currency: "IRR",
    };
    await sendPayoutWebhook(event);
    await sendPayoutWebhook(event);
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
    const next = await postWithdrawal(user, "100000", "after-returned");
    expect(next.response.status).toBe(201);
    expect(next.body.status).toBe("SUCCEEDED");
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
  it("does not change withdrawal balances or call payout when reserve ledger insertion fails", async () => {
    const user = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeef";
    await seedWallet(user, "200000");
    await db.query(`
      CREATE FUNCTION fail_withdrawal_reserve_entry() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected withdrawal ledger failure'; END $$;
      CREATE TRIGGER fail_withdrawal_reserve_entry BEFORE INSERT ON ledger_entries
      FOR EACH ROW WHEN (NEW.reference_type = 'WITHDRAWAL_RESERVE')
      EXECUTE FUNCTION fail_withdrawal_reserve_entry();
    `);
    try {
      const result = await postWithdrawal(
        user,
        "100000",
        "withdrawal-rollback",
      );
      expect(result.response.status).toBe(500);
    } finally {
      await db.query(`
        DROP TRIGGER IF EXISTS fail_withdrawal_reserve_entry ON ledger_entries;
        DROP FUNCTION IF EXISTS fail_withdrawal_reserve_entry();
      `);
    }
    expect(
      await db.query("SELECT id FROM withdrawals WHERE user_id=$1", [user]),
    ).toHaveLength(0);
    expect(payoutSubmit).not.toHaveBeenCalled();
    await assertFinancialInvariants(user);
  });
  it("does not create a separate adjustments table", async () => {
    const tables = await db.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='adjustments'",
    );
    expect(tables).toHaveLength(0);
  });
});
