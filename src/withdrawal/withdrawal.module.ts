import { Module } from "@nestjs/common";
import { WithdrawalService } from "./withdrawal.service";
import { WithdrawalController } from "./withdrawal.controller";
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
  providers: [WithdrawalService],
  controllers: [WithdrawalController],
  exports: [WithdrawalService],
})
export class WithdrawalModule {}
