import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
} from "@nestjs/common";
import { ApiHeader, ApiProperty, ApiTags } from "@nestjs/swagger";
import { IsIn, IsString, IsUUID, Matches } from "class-validator";
import { PaymentService } from "./payment.service";
class DepositDto {
  @ApiProperty({ format: "uuid" })
  @IsUUID()
  userId!: string;
  @ApiProperty({
    type: String,
    example: "100000",
    description: "Positive decimal string; IRR must be integer",
  })
  @IsString()
  @Matches(/^(0|[1-9]\d*)(\.\d{1,6})?$/)
  amount!: string;
  @ApiProperty({ enum: ["IRR", "USDT"] })
  @IsIn(["IRR", "USDT"])
  currency!: string;
}
@ApiTags("deposits")
@Controller()
export class PaymentController {
  constructor(private service: PaymentService) {}
  @Post("deposits")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  create(@Body() dto: DepositDto, @Headers("idempotency-key") key?: string) {
    return this.service.create(dto, key);
  }
  @Get("deposits/:id") get(@Param("id", ParseUUIDPipe) id: string) {
    return this.service.get(id);
  }
  @Post("deposits/:id/verify")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  verify(
    @Param("id", ParseUUIDPipe) id: string,
    @Headers("idempotency-key") key?: string,
  ) {
    return this.service.verifyById(id, key);
  }
  @Post("payments/psp/callback") callback(@Body() body: any) {
    return this.service.callback(body);
  }
}
