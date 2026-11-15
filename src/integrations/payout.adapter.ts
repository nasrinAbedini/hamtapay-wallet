import { Injectable } from "@nestjs/common";
import { ApiError } from "../common/errors";

export type PayoutResult = {
  requestId: string;
  trackingId?: string;
  status: string;
  reason?: string | null;
  amount: string;
  currency: string;
  destination: string;
  updatedAt?: string;
};

@Injectable()
export class PayoutAdapter {
  private get baseUrl() {
    return (
      process.env.PAYOUT_BASE_URL ??
      process.env.SIMULATOR_BASE_URL ??
      process.env.PAYOUT_URL
    );
  }

  private async request(
    path: string,
    method: "GET" | "POST",
    body?: unknown,
    notFoundIsUnknown = false,
  ): Promise<Record<string, unknown> | null> {
    if (!this.baseUrl) throw new ApiError("PAYOUT_UNAVAILABLE", 503);
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
      if (notFoundIsUnknown && response.status === 404) return null;
      const data = (await response.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      if (!response.ok) {
        throw new ApiError(
          response.status >= 500 ? "PAYOUT_UNKNOWN" : "PAYOUT_ERROR",
          response.status >= 500 ? 504 : 502,
          typeof data?.error === "string"
            ? data.error
            : "Payout request failed",
        );
      }
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new ApiError("PAYOUT_INVALID_RESPONSE", 502);
      return data;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof Error && error.name === "AbortError")
        throw new ApiError("PAYOUT_UNKNOWN", 504);
      throw new ApiError("PAYOUT_UNKNOWN", 504);
    } finally {
      clearTimeout(timeout);
    }
  }

  async submit(p: {
    requestId: string;
    amount: string;
    currency: string;
    destination: string;
  }): Promise<PayoutResult> {
    const result = await this.request("/payout/transfers", "POST", {
      requestId: p.requestId,
      type: "IBAN",
      destination: p.destination,
      amount: p.amount,
      currency: p.currency,
    });
    return this.validate(result, p);
  }

  async status(requestId: string): Promise<PayoutResult | null> {
    const result = await this.request(
      `/payout/transfers/${encodeURIComponent(requestId)}`,
      "GET",
      undefined,
      true,
    );
    if (!result) return null;
    if (result.requestId !== requestId || typeof result.status !== "string")
      throw new ApiError("PAYOUT_INVALID_RESPONSE", 502);
    return result as PayoutResult;
  }

  private validate(
    result: Record<string, unknown> | null,
    expected: {
      requestId: string;
      amount: string;
      currency: string;
      destination: string;
    },
  ): PayoutResult {
    if (
      !result ||
      result.requestId !== expected.requestId ||
      result.amount !== expected.amount ||
      result.currency !== expected.currency ||
      result.destination !== expected.destination ||
      typeof result.status !== "string"
    )
      throw new ApiError("PAYOUT_INVALID_RESPONSE", 502);
    return result as PayoutResult;
  }
}
