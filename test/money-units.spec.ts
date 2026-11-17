import { rialToToman, tomanToRial } from "../src/common/money";
import { PayoutAdapter } from "../src/integrations/payout.adapter";
import { PspAdapter } from "../src/integrations/psp.adapter";

describe("Toman and Rial unit conversion", () => {
  it("converts 100,000 Toman to 1,000,000 Rial and back exactly", () => {
    expect(tomanToRial("100000")).toBe("1000000");
    expect(rialToToman("1000000")).toBe("100000");
  });

  it("uses exact integer arithmetic beyond JavaScript safe integer precision", () => {
    const toman = "90071992547409931234567890";
    const rial = "900719925474099312345678900";
    expect(tomanToRial(toman)).toBe(rial);
    expect(rialToToman(rial)).toBe(toman);
  });

  it.each(["-1", "1.5", "01", "1e3", ""])(
    "rejects unsupported Toman input %s",
    (value) => expect(() => tomanToRial(value)).toThrow(),
  );

  it.each(["-10", "1.5", "01", "1000001", ""])(
    "rejects unsupported Rial input %s",
    (value) => expect(() => rialToToman(value)).toThrow(),
  );
});

describe("provider monetary boundaries", () => {
  let requestBody: Record<string, unknown> | undefined;
  let responseAmount = "1000000";
  let fetchMock: jest.SpyInstance;
  let previousPspUrl: string | undefined;
  let previousPayoutUrl: string | undefined;

  beforeAll(() => {
    previousPspUrl = process.env.PSP_BASE_URL;
    previousPayoutUrl = process.env.PAYOUT_BASE_URL;
    process.env.PSP_BASE_URL = "http://simulator.test";
    process.env.PAYOUT_BASE_URL = "http://simulator.test";
    fetchMock = jest.spyOn(globalThis, "fetch");
  });

  beforeEach(() => {
    requestBody = undefined;
    responseAmount = "1000000";
    fetchMock.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      requestBody = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined;
      let result: Record<string, unknown>;
      switch (url.pathname) {
        case "/psp/payments":
          result = {
            code: 100,
            token: "psp-token",
            paymentUrl: "https://example.test/pay",
            amount: requestBody?.amount,
          };
          break;
        case "/psp/verify":
          result = {
            code: 100,
            status: "OK",
            amount: responseAmount,
            refId: "ref",
          };
          break;
        case "/psp/payments/psp-token":
          result = {
            token: "psp-token",
            orderId: "order",
            status: "PAID",
            amount: responseAmount,
          };
          break;
        case "/payout/transfers":
          result = {
            requestId: "payout-id",
            status: "PROCESSING",
            amount: responseAmount,
            currency: "IRR",
            destination: "IR00",
          };
          break;
        case "/payout/transfers/payout-id":
          result = {
            requestId: "payout-id",
            status: "PROCESSING",
            amount: responseAmount,
            currency: "IRR",
            destination: "IR00",
          };
          break;
        default:
          return new Response(JSON.stringify({ error: "not found" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          });
      }
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
  });

  afterAll(() => {
    fetchMock.mockRestore();
    if (previousPspUrl === undefined) delete process.env.PSP_BASE_URL;
    else process.env.PSP_BASE_URL = previousPspUrl;
    if (previousPayoutUrl === undefined) delete process.env.PAYOUT_BASE_URL;
    else process.env.PAYOUT_BASE_URL = previousPayoutUrl;
  });

  it.each([
    ["100000", "1000000"],
    ["250001", "2500010"],
  ])("sends a %s Toman deposit as %s Rial", async (toman, rial) => {
    const result = await new PspAdapter().create({
      orderId: "order",
      amount: toman,
      callbackUrl: "https://example.test/callback",
    });
    expect(requestBody?.amount).toBe(rial);
    expect(result.amount).toBe(toman);
  });

  it.each([
    ["100000", "1000000"],
    ["250001", "2500010"],
  ])("sends %s Toman as %s Rial and returns Toman", async (toman, rial) => {
    responseAmount = rial;
    const payout = await new PayoutAdapter().submit({
      requestId: "payout-id",
      amount: toman,
      currency: "IRR",
      destination: "IR00",
    });
    expect(requestBody?.amount).toBe(rial);
    expect(payout.amount).toBe(toman);
  });

  it("converts incoming PSP status and verification amounts to Toman", async () => {
    const psp = new PspAdapter();
    expect((await psp.paymentStatus("psp-token")).amount).toBe("100000");
    expect((await psp.verify("psp-token")).amount).toBe("100000");
    expect(psp.callbackAmountToToman("1000000")).toBe("100000");
    expect(psp.callbackAmountToToman("900000")).toBe("90000");
  });

  it("converts payout status Rial amounts back to Toman", async () => {
    const status = await new PayoutAdapter().status("payout-id");
    expect(status?.amount).toBe("100000");
  });

  it("rejects a mismatched incoming payout amount", async () => {
    responseAmount = "900000";
    await expect(
      new PayoutAdapter().submit({
        requestId: "payout-id",
        amount: "100000",
        currency: "IRR",
        destination: "IR00",
      }),
    ).rejects.toMatchObject({ response: { code: "PAYOUT_INVALID_RESPONSE" } });
  });
});
