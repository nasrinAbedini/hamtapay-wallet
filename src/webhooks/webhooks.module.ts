import { Module } from "@nestjs/common";
import { IdempotencyModule } from "../idempotency/idempotency.module";
import { WithdrawalModule } from "../withdrawal/withdrawal.module";
import { PayoutWebhookController } from "./payout-webhook.controller";
import { WebhookSignatureService } from "./webhook-signature.service";

@Module({
  imports: [IdempotencyModule, WithdrawalModule],
  controllers: [PayoutWebhookController],
  providers: [WebhookSignatureService],
})
export class WebhooksModule {}
