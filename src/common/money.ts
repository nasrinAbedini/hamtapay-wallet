import { BadRequestException } from "@nestjs/common";
export function amount(value: string, currency: string): string {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(value))
    throw new BadRequestException({
      code: "INVALID_AMOUNT",
      message:
        "Amount must be a positive decimal string with at most six fractional digits",
    });
  if (currency === "IRR" && value.includes("."))
    throw new BadRequestException({
      code: "INVALID_AMOUNT",
      message: "IRR amount must be an integer",
    });
  if (
    !["IRR", "USDT"].includes(currency) ||
    (BigInt(value.split(".")[0]) === 0n && /^0(?:\.0+)?$/.test(value))
  )
    throw new BadRequestException({
      code: "INVALID_AMOUNT",
      message: "Amount must be positive and currency supported",
    });
  return value;
}
export function toUnits(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}
export function normalizeAmount(value: string): string {
  const [whole, fraction = ""] = value.split(".");
  return `${whole}.${fraction.padEnd(6, "0")}`;
}
export function hashRequest(value: unknown): string {
  return require("node:crypto")
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}
