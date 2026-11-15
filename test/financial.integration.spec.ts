import { DataSource } from "typeorm";
import { InitialSchema1763000000000 } from "../src/database/migrations/1763000000000-InitialSchema";
import { AllowReturnedWithdrawal1763100000000 } from "../src/database/migrations/1763100000000-AllowReturnedWithdrawal";
import { WalletService } from "../src/wallet/wallet.service";
import { LedgerService } from "../src/ledger/ledger.service";
import { IdempotencyService } from "../src/idempotency/idempotency.service";
import { WithdrawalService } from "../src/withdrawal/withdrawal.service";
import { PayoutAdapter } from "../src/integrations/payout.adapter";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
suite("financial integration (real PostgreSQL)", () => {
  let db: DataSource;
  let wallet: WalletService;
  let withdrawal: WithdrawalService;
  let payouts: {
    submit: (p: any) => Promise<any>;
    status: (id: string) => Promise<any>;
  };
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
    await db.initialize();
    await db.runMigrations();
    wallet = new WalletService(db);
    payouts = {
      submit: async () => ({ status: "UNKNOWN" }),
      status: async () => ({ status: "UNKNOWN" }),
    };
    withdrawal = new WithdrawalService(
      db,
      wallet,
      new LedgerService(),
      payouts as unknown as PayoutAdapter,
      new IdempotencyService(db),
    );
  });
  beforeEach(async () => {
    await db.query(
      "TRUNCATE idempotency_keys,withdrawals,payments,ledger_entries,wallets CASCADE",
    );
  });
  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
  });
  it("creates wallet lazily with zero balances", async () => {
    const user = "11111111-1111-4111-8111-111111111111";
    const result = await wallet.get(user);
    expect(result.available_balance).toBe("0.000000");
    expect(result.reserved_balance).toBe("0.000000");
  });
  it("serializes concurrent withdrawals and never reserves beyond balance", async () => {
    const user = "22222222-2222-4222-8222-222222222222";
    await db.query(
      `INSERT INTO wallets(user_id,currency,available_balance) VALUES($1,'IRR',150000)`,
      [user],
    );
    const iban = "IR490000000000000000000000";
    const results = await Promise.allSettled([
      withdrawal.create(
        { userId: user, amount: "100000", destination: iban },
        "withdrawal-a",
      ),
      withdrawal.create(
        { userId: user, amount: "100000", destination: iban },
        "withdrawal-b",
      ),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const row = (
      await db.query(
        "SELECT available_balance,reserved_balance FROM wallets WHERE user_id=$1",
        [user],
      )
    )[0];
    expect(row.available_balance).toBe("50000.000000");
    expect(row.reserved_balance).toBe("100000.000000");
    const groups = await db.query(
      `SELECT transaction_id FROM ledger_entries GROUP BY transaction_id HAVING sum(CASE WHEN entry_type='DEBIT' THEN amount ELSE -amount END)<>0`,
    );
    expect(groups).toHaveLength(0);
  });
  it("keeps reserved amount when payout outcome is unknown", async () => {
    const user = "33333333-3333-4333-8333-333333333333";
    await db.query(
      `INSERT INTO wallets(user_id,currency,available_balance) VALUES($1,'IRR',200000)`,
      [user],
    );
    const result = await withdrawal.create(
      {
        userId: user,
        amount: "100000",
        destination: "IR490000000000000000000000",
      },
      "withdrawal-unknown",
    );
    expect(result.status).toBe("UNKNOWN");
    const row = (
      await db.query(
        "SELECT available_balance,reserved_balance FROM wallets WHERE user_id=$1",
        [user],
      )
    )[0];
    expect(row.available_balance).toBe("100000.000000");
    expect(row.reserved_balance).toBe("100000.000000");
  });
  it("returns settled funds to available balance on a RETURNED event", async () => {
    const user = "44444444-4444-4444-8444-444444444444";
    await db.query(
      `INSERT INTO wallets(user_id,currency,available_balance) VALUES($1,'IRR',200000)`,
      [user],
    );
    payouts.submit = async () => ({ status: "SUCCEEDED" });
    const withdrawalRow = await withdrawal.create(
      {
        userId: user,
        amount: "100000",
        destination: "IR490000000000000000000000",
      },
      "withdrawal-returned",
    );
    expect(withdrawalRow.status).toBe("SUCCEEDED");
    const returned = await withdrawal.handlePayoutEvent({
      event: "transfer.updated",
      eventId: "evt-returned-1",
      requestId: withdrawalRow.provider_request_id,
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
  });
});
