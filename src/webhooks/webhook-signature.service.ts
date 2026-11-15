import { Injectable } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";

@Injectable()
export class WebhookSignatureService {
  verify(rawBody: Buffer | undefined, signature: string | undefined): boolean {
    const secret = process.env.WEBHOOK_SECRET;
    if (!secret || !rawBody || !signature || !/^[\da-f]{64}$/i.test(signature))
      return false;
    const expected = createHmac("sha256", secret).update(rawBody).digest();
    const actual = Buffer.from(signature, "hex");
    return (
      actual.length === expected.length && timingSafeEqual(expected, actual)
    );
  }
}
