import { MigrationInterface, QueryRunner } from "typeorm";
export class InitialSchema1763000000000 implements MigrationInterface {
  name = "InitialSchema1763000000000";
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE TABLE wallets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, currency varchar(10) NOT NULL CHECK(currency IN ('IRR','USDT')), available_balance numeric(20,6) NOT NULL DEFAULT 0 CHECK(available_balance >= 0), reserved_balance numeric(20,6) NOT NULL DEFAULT 0 CHECK(reserved_balance >= 0), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,currency), CHECK(currency <> 'IRR' OR (available_balance = trunc(available_balance) AND reserved_balance = trunc(reserved_balance))));
      CREATE TABLE ledger_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), transaction_id uuid NOT NULL, account_code varchar(50) NOT NULL CHECK(account_code IN ('USER_WALLET_AVAILABLE','USER_WALLET_RESERVED','PSP_CLEARING','PAYOUT_CLEARING','ADJUSTMENT_CLEARING')), related_user_id uuid, reference_type varchar(50) NOT NULL, reference_id varchar(100) NOT NULL, amount numeric(20,6) NOT NULL CHECK(amount > 0), currency varchar(10) NOT NULL CHECK(currency IN ('IRR','USDT')), entry_type varchar(10) NOT NULL CHECK(entry_type IN ('DEBIT','CREDIT')), created_by_type varchar(20) NOT NULL CHECK(created_by_type IN ('SYSTEM','MANAGER')), created_by_id uuid, description text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
      CREATE INDEX idx_ledger_user_cursor ON ledger_entries(related_user_id, created_at DESC, id DESC); CREATE INDEX idx_ledger_tx ON ledger_entries(transaction_id); CREATE INDEX idx_ledger_ref ON ledger_entries(reference_type,reference_id);
      CREATE FUNCTION reject_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ledger entries are immutable'; END $$;
      CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
      CREATE TABLE payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, amount numeric(20,6) NOT NULL CHECK(amount > 0), currency varchar(10) NOT NULL CHECK(currency IN ('IRR','USDT')), status varchar(30) NOT NULL CHECK(status IN ('PENDING','PAYMENT_INITIATED','VERIFYING','SUCCEEDED','FAILED')), psp_token varchar(255), order_id varchar(100) NOT NULL UNIQUE, provider_ref_id varchar(100), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
      CREATE UNIQUE INDEX idx_payments_token ON payments(psp_token) WHERE psp_token IS NOT NULL; CREATE INDEX idx_payments_user_created ON payments(user_id,created_at DESC);
      CREATE TABLE withdrawals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, amount numeric(20,6) NOT NULL CHECK(amount > 0), currency varchar(10) NOT NULL CHECK(currency IN ('IRR','USDT')), destination varchar(255) NOT NULL, status varchar(30) NOT NULL CHECK(status IN ('PENDING','PROCESSING','UNKNOWN','SUCCEEDED','FAILED')), provider_request_id varchar(100) UNIQUE, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
      CREATE INDEX idx_withdrawals_daily ON withdrawals(user_id,currency,created_at,status); CREATE INDEX idx_withdrawals_pending ON withdrawals(status,created_at) WHERE status IN ('PENDING','UNKNOWN');
      CREATE TABLE idempotency_keys (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), scope varchar(100) NOT NULL, key varchar(255) NOT NULL, request_hash varchar(64) NOT NULL, response jsonb, status varchar(20) NOT NULL CHECK(status IN ('IN_PROGRESS','COMPLETED')), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(scope,key));`);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(
      "DROP TABLE idempotency_keys, withdrawals, payments, ledger_entries, wallets CASCADE; DROP FUNCTION reject_ledger_mutation();",
    );
  }
}
