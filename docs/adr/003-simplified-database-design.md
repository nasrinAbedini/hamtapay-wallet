# ADR 003: Simplified database design

## Context
Avoid redundant tables while preserving wallet deposits, daily limit computation, and manual adjustment history.

## Options considered
- Add deposits, adjustment, accounts, daily aggregate, and outbox tables.
- Store deposits in payments, adjustments directly in ledger, and compute daily use from withdrawals.

## Decision
Use only wallets, ledger_entries, payments, withdrawals, and idempotency_keys.

## Reasons
This matches the requested scope and avoids duplicate state.

## Trade-offs
Daily usage queries can become expensive at scale. The five-table design has no outbox and relies on operational recovery for committed pending payouts.
