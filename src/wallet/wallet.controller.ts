import { Controller, Get, Param, ParseUUIDPipe, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { WalletService } from "./wallet.service";
@ApiTags("wallets")
@Controller("wallets")
export class WalletController {
  constructor(private readonly wallets: WalletService) {}
  @Get(":userId") get(@Param("userId", ParseUUIDPipe) userId: string) {
    return this.wallets.get(userId);
  }
  @Get(":userId/ledger") ledger(
    @Param("userId", ParseUUIDPipe) userId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    return this.wallets.ledger(userId, cursor, limit ? Number(limit) : 50);
  }
}
