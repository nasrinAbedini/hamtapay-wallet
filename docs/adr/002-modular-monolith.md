# ADR 002: Modular monolith

## Context
The wallet needs consistent financial transactions across domains and a simple deployment.

## Options considered
- Separate microservices.
- One application with explicit NestJS modules.

## Decision
Use a NestJS modular monolith.

## Reasons
It permits database atomicity across payment, wallet, and ledger operations while keeping deployment and operations small.

## Trade-offs
Modules share one process and database and cannot be deployed independently.
