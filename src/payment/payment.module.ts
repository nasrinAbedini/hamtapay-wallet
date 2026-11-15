import { Module } from "@nestjs/common";
import { PaymentService } from "./payment.service";
import { PaymentController } from "./payment.controller";
import { WalletModule } from "../wallet/wallet.module";
import { LedgerModule } from "../ledger/ledger.module";
import { PaymentIntegrationModule } from "../integrations/integrations.module";
import { IdempotencyModule } from "../idempotency/idempotency.module";
@Module({
  imports: [
    WalletModule,
    LedgerModule,
    PaymentIntegrationModule,
    IdempotencyModule,
  ],
  providers: [PaymentService],
  controllers: [PaymentController],
})
export class PaymentModule {}
