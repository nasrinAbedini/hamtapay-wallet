import { Injectable } from "@nestjs/common";
import { ApiError } from "../common/errors";
import { rialToToman, tomanToRial } from "../common/money";

type ProviderJson = Record<string, unknown>;

@Injectable()
export class PspAdapter {
  private get baseUrl() {
    return (
      process.env.PSP_BASE_URL ??
      process.env.SIMULATOR_BASE_URL ??
      process.env.PSP_URL
    );
  }

  private async request(
    path: string,
    method: "GET" | "POST",
    body?: unknown,
  ): Promise<ProviderJson | string> {
    if (!this.baseUrl) throw new ApiError("PSP_UNAVAILABLE", 503);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Number(process.env.PROVIDER_TIMEOUT_MS ?? 8000),
    );
    try {
      const response = await fetch(new URL(path, this.baseUrl), {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      const contentType = response.headers.get("content-type") ?? "";
      const data = contentType.includes("text/csv")
        ? await response.text()
        : ((await response.json().catch(() => null)) as ProviderJson | null);
      if (!response.ok) {
        throw new ApiError(
          response.status >= 500 ? "PSP_UNAVAILABLE" : "PSP_ERROR",
          response.status >= 500 ? 503 : 502,
          typeof data === "object" && data && typeof data.message === "string"
            ? data.message
            : "PSP request failed",
        );
      }
      if (
        data === null ||
        (typeof data !== "object" && typeof data !== "string")
      )
        throw new ApiError("PSP_INVALID_RESPONSE", 502);
      return data;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof Error && error.name === "AbortError")
        throw new ApiError("PSP_TIMEOUT", 504);
      throw new ApiError("PSP_UNAVAILABLE", 503);
    } finally {
      clearTimeout(timeout);
    }
  }

  async create(payload: {
    orderId: string;
    amount: string;
    callbackUrl: string;
  }): Promise<ProviderJson> {
    const result = (await this.request("/psp/payments", "POST", {
      amount: tomanToRial(payload.amount),
      callbackUrl: payload.callbackUrl,
      orderId: payload.orderId,
    })) as ProviderJson;
    const internal = this.toInternalAmount(result);
    if (internal.amount !== undefined && internal.amount !== payload.amount)
      throw new ApiError("PSP_INVALID_RESPONSE", 502);
    return internal;
  }

  verify(token: string) {
    return this.request("/psp/verify", "POST", { token }).then((result) =>
      this.toInternalAmount(result as ProviderJson),
    );
  }

  paymentStatus(token: string) {
    return this.request(
      `/psp/payments/${encodeURIComponent(token)}`,
      "GET",
    ).then((result) => this.toInternalAmount(result as ProviderJson));
  }

  callbackAmountToToman(value: string) {
    try {
      return rialToToman(value);
    } catch {
      throw new ApiError("PAYMENT_MISMATCH", 422);
    }
  }

  private toInternalAmount(result: ProviderJson): ProviderJson {
    if (typeof result.amount !== "string") return result;
    try {
      return { ...result, amount: rialToToman(result.amount) };
    } catch {
      throw new ApiError("PSP_INVALID_RESPONSE", 502);
    }
  }

  async settlement(date: string): Promise<string> {
    const report = await this.request(
      `/psp/settlement?date=${encodeURIComponent(date)}`,
      "GET",
    );
    if (typeof report !== "string")
      throw new ApiError("PSP_INVALID_RESPONSE", 502);
    return report;
  }
}
