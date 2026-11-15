import { Injectable } from "@nestjs/common";
import { ApiError } from "../common/errors";

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

  create(payload: { orderId: string; amount: string; callbackUrl: string }) {
    return this.request("/psp/payments", "POST", {
      amount: payload.amount,
      callbackUrl: payload.callbackUrl,
      orderId: payload.orderId,
    }) as Promise<ProviderJson>;
  }

  verify(token: string) {
    return this.request("/psp/verify", "POST", {
      token,
    }) as Promise<ProviderJson>;
  }

  paymentStatus(token: string) {
    return this.request(
      `/psp/payments/${encodeURIComponent(token)}`,
      "GET",
    ) as Promise<ProviderJson>;
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
