# ADR 001: Double-entry ledger

## Context
Wallet balances must be auditable and every financial movement must balance by currency.

## Options considered
- Store only current balances.
- Store a one-sided activity log.
- Store immutable debit and credit entries.

## Decision
Use immutable double-entry rows grouped by `transaction_id`, with logical account codes and a consistent liability accounting convention.

## Reasons
This makes movements traceable, enables balance checks, and permits correction through compensating entries.

## Trade-offs
Every business operation must construct balanced entries. Application validation checks balance before commit; PostgreSQL blocks ledger updates and deletes, but group balance is not enforced by a deferred database trigger.
