import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { validateEnvironment } from "./config/environment";
import { DatabaseModule } from "./database/database.module";
import { WalletModule } from "./wallet/wallet.module";
import { LedgerModule } from "./ledger/ledger.module";
import { IdempotencyModule } from "./idempotency/idempotency.module";
import { PaymentIntegrationModule } from "./integrations/integrations.module";
import { PaymentModule } from "./payment/payment.module";
import { WithdrawalModule } from "./withdrawal/withdrawal.module";
import { APP_FILTER } from "@nestjs/core";
import { ApiExceptionFilter } from "./common/exception.filter";
import { WebhooksModule } from "./webhooks/webhooks.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnvironment }),
    DatabaseModule,
    WalletModule,
    LedgerModule,
    IdempotencyModule,
    PaymentIntegrationModule,
    PaymentModule,
    WithdrawalModule,
    WebhooksModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: ApiExceptionFilter }],
})
export class AppModule {}
