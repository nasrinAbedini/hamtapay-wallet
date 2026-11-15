# Hamtapay Wallet Backend

NestJS modular monolith for IRR wallet deposits, manager adjustments, withdrawals, and immutable double-entry ledger history. PostgreSQL is the source of truth; financial values are decimal strings in APIs and `NUMERIC(20,6)` in storage. IRR values are integer toman units.

## Architecture

Modules are Wallet, Ledger, Payment, Withdrawal, Idempotency, Payment Integration, and Webhooks. TypeORM is used for PostgreSQL connections, migrations, and transaction management; queries are explicit SQL so row locks and numeric handling remain visible. Schema synchronization is disabled. The five application tables are `wallets`, `ledger_entries`, `payments`, `withdrawals`, and `idempotency_keys`.

Accounting convention: wallet balances are customer liabilities. Credits increase wallet liability; debits decrease it. Deposits: debit PSP_CLEARING, credit USER_WALLET_AVAILABLE. Adjustments: debit ADJUSTMENT_CLEARING, credit wallet available. Withdrawal reservation: debit available, credit reserved. Settlement: debit reserved, credit PAYOUT_CLEARING. Definite failure: debit reserved, credit available. A returned transfer credits the user's available wallet with a compensating ledger transaction. Ledger immutability is enforced with a PostgreSQL trigger.

## Local setup

```sh
cp .env.example .env
docker load -i t103-simulator.tar.gz
docker compose up --build
```

Place the supplied `t103-simulator.tar.gz` in the working directory (or adjust the path in the load command). Compose starts PostgreSQL, the official simulator, and the app. Container-to-container traffic uses `http://simulator:8080`; the client-facing simulator port is `http://localhost:8080`. Set `SIM_CHAOS=off`, `default`, or `hostile` and `SIM_TIME_SCALE` in `.env`. For local watch mode, run PostgreSQL and the simulator with Compose, then start the app with `npm run start:dev`; set the provider base URLs to `http://localhost:8080` and both callback URLs to `http://host.docker.internal:3000/...` so the simulator container can reach the host process.

Migrations:

```sh
npm run migration:run
npm run migration:revert
```

API documentation is served at `http://localhost:3000/docs`.

## API

- `POST /deposits` — body `{ "userId": "uuid", "amount": "100000", "currency": "IRR" }`; requires `Idempotency-Key`.
- `GET /deposits/:id`
- `POST /payments/psp/callback` — simulator callback; callback is a signal and the backend verifies with PSP before crediting.
- `POST /deposits/:id/verify` — idempotent manual retry/status check for missed callbacks or transient verification failures.
- `POST /webhooks/payout` — payout event receiver; validates `X-Signature` over the exact raw body and deduplicates `X-Event-Id`.
- `POST /withdrawals` — body `{ "userId": "uuid", "amount": "100000", "currency": "IRR", "destination": "Iranian IBAN" }`; requires idempotency key. Only IRR withdrawals are supported.
- `GET /withdrawals/:id`
- `GET /wallets/:userId` and `/wallets/:userId/ledger?cursor=&limit=`
- `POST /internal/adjustments` — requires `Authorization: Bearer $MANAGER_TOKEN`, UUID `x-manager-id`, and idempotency key.
- `POST /internal/withdrawals/:id/verify` and `/internal/withdrawals/recover` — manager protected recovery operations.
- `POST /internal/withdrawals/:id/retry` — manager-protected retry for UNKNOWN payouts using the same provider request ID.

## Decisions and limitations

Daily IRR usage is summed from qualifying withdrawals in the Asia/Tehran business day while the wallet row is locked. IRR withdrawal minimum is 100,000 toman and the daily maximum is 200,000,000 toman. Iranian IBAN is checked for length, prefix, and mod-97 checksum. No fee is charged.

The internal manager token is a deployment-level access-control assumption; replace it with the platform's authenticated manager identity in production. There is no user authentication/authorization layer. The PSP and Payout adapters follow the simulator's documented routes and field names; details and source-inspected behavior are in `docs/provider-notes.md`. The simulator source was inspected from the supplied image archive, but live behavior was not exercised in this environment. There is no transactional outbox. A recovery endpoint replays PENDING and stale PROCESSING payout requests with the same stable provider request ID; deploy a scheduler or call it operationally. Unknown payout outcomes remain reserved pending status verification or retry.

Idempotency is protected by a unique constraint and insert-on-conflict, with an in-progress response for concurrent duplicate requests. A crash can leave an IN_PROGRESS key; operational cleanup/recovery is not automated. A PSP creation timeout leaves its payment PENDING without credit; retry deposit verification after the token is saved. The ledger validates balance in the service transaction and enforces row immutability in PostgreSQL; a deferred database constraint enforcing group balance is not installed.

## Simulator walkthrough

Create a deposit and copy the token from its payment URL. The simulator payment URL uses its internal hostname; from the host, use `http://localhost:8080/psp/pay/$TOKEN`:

```sh
curl -X POST http://localhost:3000/deposits \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: deposit-demo-1' \
  -d '{"userId":"11111111-1111-4111-8111-111111111111","amount":"100000","currency":"IRR"}'
curl -X POST "http://localhost:8080/psp/pay/$TOKEN" \
  -H 'Content-Type: application/json' -d '{"result":"success"}'
```

For a failed payment, send `{"result":"fail"}`. The simulator calls the configured PSP callback asynchronously. Check the wallet or use `POST /deposits/:id/verify` with a fresh idempotency key if the callback was missed.

Withdrawals require funded balance and a valid Iranian IBAN. The simulator responds asynchronously; poll `GET /withdrawals/:id` or call the manager-protected `POST /internal/withdrawals/:id/verify`. Valid payout webhooks update the same record. Status 404, timeout, and unknown responses keep the amount reserved.

Inspect simulator health and config with `curl http://localhost:8080/health` and `curl -H 'X-Admin-Key: local-simulator-admin' http://localhost:8080/__admin/config`. The admin key is for local development only. Change chaos profile with `POST /__admin/chaos` and body `{"profile":"off"}` (or `default`/`hostile`); queued PSP/Payout scenarios can be inspected with `GET /__admin/payments` and `GET /__admin/payouts`.

## Tests

`npm test` runs Jest. Integration tests require a real PostgreSQL instance configured with `TEST_DATABASE_URL`. `npm run test:e2e` is available for HTTP integration tests. The environment used for this implementation did not have Docker, PostgreSQL, or provider simulators available, so database-backed verification must be run in the configured environment.
