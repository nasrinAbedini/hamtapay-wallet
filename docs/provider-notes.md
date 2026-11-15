# Simulator provider notes

The supplied `hamtapay/t103-simulator:1.0` OCI image was inspected directly from `t103-simulator.tar.gz`. Its bundled simulator source confirms the routes, field names, status values, and chaos behavior below. The image could not be loaded into Docker in this session because the Docker escalation request was rejected, so these findings are source-inspected; live requests and webhook delivery have not been run here.

## PSP

| Operation | Contract |
|---|---|
| Create | `POST /psp/payments` with `{ "amount": "100000", "callbackUrl": "http://app:3000/payments/psp/callback", "orderId": "..." }`; response `201` `{ "code": 100, "token": "...", "paymentUrl": "..." }`. Amount must be a positive integer and at least `10000`. |
| Payment page | `GET /psp/pay/{token}` returns page metadata as JSON. |
| Simulate user action | `POST /psp/pay/{token}` with `{ "result": "success" }` or `{ "result": "fail" }`. It returns the payment result and asynchronously sends callback(s). This endpoint is not the callback endpoint. |
| Callback | Simulator sends unsigned JSON `{ "token", "orderId", "status" }` to the supplied callback URL. Status is `OK` or `NOK`; chaos can duplicate, omit, reorder, or forge callbacks. Callback is only a signal; backend checks token/order and queries the provider before verifying. |
| Verify | `POST /psp/verify` with `{ "token": "..." }`. Confirmed payment: `{ "code": 100, "status": "OK", "amount": "...", "refId": "..." }`. Already verified: code `101`, status `ALREADY_VERIFIED`, amount and refId. Not paid: code `-51`, status `FAILED`. Expired/reversed before verification: code `-54`, status `EXPIRED`. A simulated transient failure may return HTTP 503. |
| Status | `GET /psp/payments/{token}` returns token, orderId, status, amount, refId (nullable). This is used to validate provider ownership/amount before verification and supports the manual deposit verification route. |
| Settlement | `GET /psp/settlement?date=YYYY-MM-DD` returns CSV. The adapter exposes retrieval; no reconciliation endpoint or module is added. |

The status-code meanings above are confirmed from the image's bundled JavaScript. The integration accepts only the matching documented code/status pairs and credits only after a successful verification and amount check. A PSP timeout/unavailable response leaves the payment pending. `POST /deposits/:id/verify` allows a fresh idempotency key to retry status verification when a callback is missed or PSP verification temporarily fails.

## Payout

| Operation | Contract |
|---|---|
| Create transfer | `POST /payout/transfers` with `{ "requestId": "...", "type": "IBAN", "destination": "IR...", "amount": "500000", "currency": "IRR" }`. The request ID must be 8–64 characters. Response is normally HTTP 202 and includes requestId, trackingId, status (`ACCEPTED` initially), reason, amount, currency, destination, and updatedAt. |
| Status | `GET /payout/transfers/{requestId}` returns the same transfer details. HTTP 404 means not found or temporarily hidden; it is not proof of failure. |
| Webhook | `POST /webhooks/payout`; JSON event includes `event: "transfer.updated"`, `eventId`, requestId, trackingId, status, reason, amount, currency, occurredAt. Headers are `X-Signature` and `X-Event-Id`. Signature is lowercase hex HMAC-SHA256 over the exact raw body using `WEBHOOK_SECRET`. |

Observed source statuses are `ACCEPTED`, `PROCESSING`, `SUCCEEDED`, `FAILED`, and `RETURNED`. The backend keeps reservations for accepted/processing/unknown results, releases only on definite `FAILED`, and credits a returned transfer back to the wallet once. Retries use the original requestId; the simulator returns the existing transfer for duplicate request IDs. No extra idempotency header is sent because requestId is the simulator's idempotency key.

The simulator may return HTTP 503 before creating a transfer, after creating it, or close the client connection after creating it. A subsequent GET may return 404 for up to 90 scaled seconds. All these cases remain UNKNOWN/reserved; status verification or retry uses the same requestId. The simulator's settlement CSV includes an additional 2500 fee row for successful IBAN transfers; this backend does not charge that fee to the user's wallet and has no reconciliation/accounting module for simulator fee rows.

## Chaos profiles (source-inspected)

- `off`: chaos probabilities are zero; validation and normal asynchronous transfer timing still apply.
- `default`: PSP callbacks can be duplicated, missed, reordered, or forged; PSP verification can return 503. Payout webhooks can be duplicated, missed, stale, or forged; payout create can return 503 before/after creation or time out; transfers can be slow or later returned.
- `hostile`: the same conditions occur more often. The source sets representative default/hostile probabilities; results are random unless simulator scenarios are explicitly queued.

The application rejects bad webhook signatures, validates event IDs and transfer amounts, uses provider verification for deposits, and makes terminal wallet changes transactionally/idempotently. Live behavior under `off`, `default`, or `hostile` remains unverified in this environment.
