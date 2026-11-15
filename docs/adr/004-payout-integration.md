# ADR 004: Payout integration

## Context
Payout calls cannot be part of the PostgreSQL transaction, and timeout does not prove failure.

## Options considered
- Call payout inside the wallet transaction.
- Commit reservation, then call provider.
- Use a transactional outbox.

## Decision
Commit a reservation and stable provider request ID first, then call payout. Unknown outcomes retain reserved funds. Provide manager-protected verification and recovery endpoints.

## Reasons
This avoids holding database locks over network calls while allowing safe retries using the same provider request ID.

## Trade-offs
A process can stop between commit and provider call. The recovery endpoint must be scheduled or invoked operationally. Provider idempotency semantics remain unverified until simulator documentation is available.
