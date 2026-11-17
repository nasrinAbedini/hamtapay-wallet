# Hamtapay Wallet Backend

A wallet backend built with NestJS and PostgreSQL for managing IRR deposits, withdrawals, balance adjustments, and transaction history.

## Tech Stack

- NestJS / TypeScript
- PostgreSQL
- TypeORM
- Docker & Docker Compose
- Jest

## Architecture

The application follows a **Modular Monolith** architecture with separate modules:

- Wallet
- Ledger
- Payment
- Withdrawal
- Idempotency
- Payment Integration
- Webhooks

Key design decisions:

- PostgreSQL as the source of truth for financial data.
- Double-entry ledger for auditable transactions.
- Immutable ledger entries enforced by PostgreSQL.
- Database transactions and row-level locking for financial consistency.
- Idempotency keys to prevent duplicate operations.
- Decimal strings in APIs and `NUMERIC(20,6)` for monetary values.
- External provider calls are performed outside database transactions.
- Unknown payout outcomes keep funds reserved until verified.

## Getting Started

Copy the environment file:

```bash
cp .env.example .env
```

Load the supplied simulator image:

```bash
docker load -i t103-simulator.tar.gz
```

Start the application:

```bash
docker compose up --build
```

Make sure `t103-simulator.tar.gz` is available in the project directory.

API documentation:

`http://localhost:3000/docs`

## Main API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| POST | `/deposits` | Create a deposit |
| GET | `/deposits/:id` | Get deposit status |
| POST | `/withdrawals` | Create a withdrawal |
| GET | `/withdrawals/:id` | Get withdrawal status |
| GET | `/wallets/:userId` | Get wallet balance |
| GET | `/wallets/:userId/ledger` | Get ledger history |
| POST | `/webhooks/payout` | Receive payout events |

`Idempotency-Key` is required for deposit and withdrawal requests.

## Configuration

Important environment variables:

- `BUSINESS_TIMEZONE`: Timezone used for daily withdrawal limits.
- `DAILY_WITHDRAWAL_LIMIT`: Maximum daily withdrawal amount.
- `WITHDRAWAL_COOLDOWN_MINUTES`: Minimum interval between withdrawals.
- `SIM_CHAOS`: Simulator behavior (`off`, `default`, `hostile`).
- `SIM_TIME_SCALE`: Simulator time scaling.

See `.env.example` for the complete configuration.

## Database Migrations

Run migrations:

```bash
npm run migration:run
```

Revert the latest migration:

```bash
npm run migration:revert
```

## Tests

Start the test PostgreSQL database:

```bash
sudo docker compose --profile test up -d postgres-test
```

Check database status:

```bash
sudo docker compose --profile test ps
```

Run integration tests:

```bash
npm run test:integration
```

## Documentation

Additional architecture decisions and provider integration details are available in the `docs/` directory.