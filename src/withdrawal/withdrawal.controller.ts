import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  UnauthorizedException,
} from "@nestjs/common";
import { ApiHeader, ApiProperty, ApiTags } from "@nestjs/swagger";
import { IsIn, IsString, IsUUID, Matches } from "class-validator";
import { WithdrawalService } from "./withdrawal.service";
import { ApiError } from "../common/errors";
class WithdrawalDto {
  @ApiProperty({ format: "uuid" })
  @IsUUID()
  userId!: string;
  @ApiProperty({ enum: ["IRR"], description: "IRR withdrawals only in this version" })
  @IsIn(["IRR"])
  currency!: "IRR";
  @ApiProperty({
    type: String,
    example: "100000",
    description: "Positive integer amount in toman",
  })
  @IsString()
  @Matches(/^(0|[1-9]\d*)$/)
  amount!: string;
  @ApiProperty({ example: "IR490000000000000000000000" })
  @IsString()
  destination!: string;
}
class AdjustmentDto {
  @ApiProperty({ format: "uuid" })
  @IsUUID()
  userId!: string;
  @ApiProperty({ enum: ["IRR", "USDT"] })
  @IsIn(["IRR", "USDT"])
  currency!: string;
  @ApiProperty({ type: String, example: "100000" })
  @IsString()
  @Matches(/^(0|[1-9]\d*)(\.\d{1,6})?$/)
  amount!: string;
  @ApiProperty()
  @IsString()
  reason!: string;
}
@ApiTags("withdrawals")
@Controller()
export class WithdrawalController {
  constructor(private service: WithdrawalService) {}
  @Post("withdrawals")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  create(@Body() dto: WithdrawalDto, @Headers("idempotency-key") key?: string) {
    if (!validIranIban(dto.destination))
      throw new ApiError("INVALID_DESTINATION", 422);
    return this.service.create(dto, key);
  }
  @Get("withdrawals/:id") get(@Param("id", ParseUUIDPipe) id: string) {
    return this.service.get(id);
  }
  @Post("internal/withdrawals/:id/verify") verify(
    @Param("id", ParseUUIDPipe) id: string,
    @Headers("authorization") auth?: string,
    @Headers("x-manager-id") actor?: string,
  ) {
    this.manager(auth, actor);
    return this.service.verify(id);
  }
  @Post("internal/withdrawals/:id/retry") retry(
    @Param("id", ParseUUIDPipe) id: string,
    @Headers("authorization") auth?: string,
    @Headers("x-manager-id") actor?: string,
  ) {
    this.manager(auth, actor);
    return this.service.process(id);
  }
  @Post("internal/withdrawals/recover") recover(
    @Headers("authorization") auth?: string,
    @Headers("x-manager-id") actor?: string,
  ) {
    this.manager(auth, actor);
    return this.service.recover();
  }
  @Post("internal/adjustments")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  adjustment(
    @Body() dto: AdjustmentDto,
    @Headers("idempotency-key") key?: string,
    @Headers("authorization") auth?: string,
    @Headers("x-manager-id") actor?: string,
  ) {
    this.manager(auth, actor);
    return this.serviceAdjustment(dto, actor!, key);
  }
  private manager(auth?: string, actor?: string) {
    if (
      !process.env.MANAGER_TOKEN ||
      auth !== `Bearer ${process.env.MANAGER_TOKEN}` ||
      !actor ||
      !isUuid(actor)
    )
      throw new UnauthorizedException({
        code: "MANAGER_AUTH_REQUIRED",
        message: "Manager credentials required",
      });
  }
  private serviceAdjustment(dto: AdjustmentDto, actor: string, key?: string) {
    return this.service.adjustment(dto, actor, key);
  }
}
function isUuid(v: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v,
  );
}
function validIranIban(v: string) {
  if (!/^IR\d{24}$/.test(v)) return false;
  const expanded =
    v.slice(4) +
    v.slice(0, 4).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (const ch of expanded) rem = (rem * 10 + Number(ch)) % 97;
  return rem === 1;
}
