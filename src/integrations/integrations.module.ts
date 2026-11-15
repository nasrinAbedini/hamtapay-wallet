import { Module } from "@nestjs/common";
import { PspAdapter } from "./psp.adapter";
import { PayoutAdapter } from "./payout.adapter";
@Module({
  providers: [PspAdapter, PayoutAdapter],
  exports: [PspAdapter, PayoutAdapter],
})
export class PaymentIntegrationModule {}
