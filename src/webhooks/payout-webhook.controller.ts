import {
  Controller,
  Headers,
  HttpCode,
  Post,
  RawBodyRequest,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import { ApiExcludeEndpoint } from "@nestjs/swagger";
import { Request } from "express";
import { IdempotencyService } from "../idempotency/idempotency.service";
import { WithdrawalService } from "../withdrawal/withdrawal.service";
import { WebhookSignatureService } from "./webhook-signature.service";
import { ApiError } from "../common/errors";

@Controller("webhooks")
export class PayoutWebhookController {
  constructor(
    private readonly signatures: WebhookSignatureService,
    private readonly idempotency: IdempotencyService,
    private readonly withdrawals: WithdrawalService,
  ) {}

  @Post("payout")
  @HttpCode(200)
  @ApiExcludeEndpoint()
  async payout(
    @Req() request: RawBodyRequest<Request>,
    @Headers("x-signature") signature?: string,
    @Headers("x-event-id") eventId?: string,
  ) {
    if (!this.signatures.verify(request.rawBody, signature))
      throw new UnauthorizedException({
        code: "INVALID_WEBHOOK_SIGNATURE",
        message: "Invalid payout webhook signature",
      });
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(request.rawBody?.toString("utf8") ?? "") as Record<
        string,
        unknown
      >;
    } catch {
      throw new ApiError("INVALID_WEBHOOK_PAYLOAD", 400);
    }
    if (
      !eventId ||
      typeof event.eventId !== "string" ||
      event.eventId !== eventId
    )
      throw new UnauthorizedException({
        code: "INVALID_WEBHOOK_EVENT_ID",
        message: "Webhook event ID does not match its header",
      });
    return this.idempotency.run("WEBHOOK:PAYOUT", eventId, event, () =>
      this.withdrawals.handlePayoutEvent(event),
    );
  }
}
