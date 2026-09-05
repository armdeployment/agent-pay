import { describe, it, expect } from "vitest";
import {
  atomicToUsdCents,
  gateOffer,
  parsePaymentRequired,
  payAndFetch,
  vaultSigner,
  NotConfiguredError,
  type PaymentGrant,
  walletBalance,
  explorerTxUrl,
  type PaymentOffer,
} from "../src/index.js";

const USDC_BASE = {
  network: "base",
  asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  decimals: 6,
  usdPerUnit: 1,
};

const grant: PaymentGrant = {
  agentId: "agt_01",
  tenantId: "tn_01",
  maxPerCallUsdCents: 500, // $5.00
  remainingUsdCents: 2_000,
  allowedPayeeHosts: ["api.seller.example"],
  allowedAssets: [USDC_BASE],
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
};

const offer: PaymentOffer = {
  scheme: "exact",
  network: "base",
  maxAmountRequired: "10000", // 0.01 USDC = 1 cent
  payTo: "0xseller",
  asset: USDC_BASE.asset,
  resource: "https://api.seller.example/data",
};

const URL_OK = "https://api.seller.example/data";

describe("valuation", () => {
  it("prices atomic units in cents, rounding up", () => {
    expect(atomicToUsdCents("10000", USDC_BASE)).toBe(1);
    expect(atomicToUsdCents("1", USDC_BASE)).toBe(1); // 0.0001c rounds up, never down
    expect(atomicToUsdCents("1500000", USDC_BASE)).toBe(150);
  });
  it("stays exact on amounts a float would lose", () => {
    const eth = { network: "base", asset: "0xeth", decimals: 18, usdPerUnit: 3000 };
    expect(atomicToUsdCents("1000000000000000000", eth)).toBe(300_000);
  });
  it("returns null rather than a zero price for junk", () => {
    expect(atomicToUsdCents("-5", USDC_BASE)).toBeNull();
    expect(atomicToUsdCents("1e6", USDC_BASE)).toBeNull();
    expect(atomicToUsdCents("100", { ...USDC_BASE, usdPerUnit: 0 })).toBeNull();
  });
});

describe("gate", () => {
  it("allows an offer inside the grant", () => {
    expect(gateOffer(offer, grant, URL_OK)).toEqual({ allowed: true, usdCents: 1 });
  });
  it("refuses a payee host the grant does not list", () => {
    const d = gateOffer(offer, grant, "https://evil.example/data");
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("payee_not_allowed");
  });
  it("refuses an asset the grant does not list", () => {
    const d = gateOffer({ ...offer, asset: "0xshitcoin" }, grant, URL_OK);
    expect(d.reason).toBe("asset_not_allowed");
  });
  it("values the asset from the grant, never from the payee", () => {
    // The seller quotes 1 unit of an 18-decimal token whose real price is
    // $3000. Priced by the grant's terms (6 decimals, $1) it is 1 cent and
    // allowed; the seller cannot restate decimals to escape the cap, and a
    // token the grant does not price cannot be paid at all.
    const spoofed = { ...offer, extra: { decimals: 18, usdPerUnit: 3000 } };
    expect(gateOffer(spoofed, grant, URL_OK)).toEqual({ allowed: true, usdCents: 1 });
  });
  it("refuses over the per-call cap", () => {
    const d = gateOffer({ ...offer, maxAmountRequired: "6000000" }, grant, URL_OK); // $6
    expect(d.reason).toBe("over_per_call_cap");
  });
  it("refuses over the remaining budget", () => {
    const poor = { ...grant, remainingUsdCents: 50, maxPerCallUsdCents: 5_000 };
    const d = gateOffer({ ...offer, maxAmountRequired: "1000000" }, poor, URL_OK); // $1
    expect(d.reason).toBe("over_remaining_budget");
  });
  it("refuses an expired grant", () => {
    const stale = { ...grant, expiresAt: new Date(Date.now() - 1000).toISOString() };
    expect(gateOffer(offer, stale, URL_OK).reason).toBe("grant_expired");
  });
  it("escalates above the human-approval threshold instead of paying", () => {
    const g = { ...grant, humanApprovalAboveUsdCents: 100 };
    const d = gateOffer({ ...offer, maxAmountRequired: "2000000" }, g, URL_OK); // $2
    expect(d.reason).toBe("needs_human_approval");
  });
  it("refuses a scheme it cannot settle", () => {
    expect(gateOffer({ ...offer, scheme: "upto" }, grant, URL_OK).reason).toBe(
      "unsupported_scheme",
    );
  });
});

describe("402 parsing", () => {
  it("reads a well-formed body", () => {
    const p = parsePaymentRequired({ x402Version: 1, accepts: [offer] });
    expect(p?.accepts).toHaveLength(1);
  });
  it("returns null when no offer survives validation", () => {
    expect(parsePaymentRequired({ accepts: [{ scheme: "exact" }] })).toBeNull();
    expect(parsePaymentRequired("nope")).toBeNull();
  });
});

describe("payAndFetch", () => {
  const json402 = () =>
    new Response(JSON.stringify({ x402Version: 1, accepts: [offer] }), { status: 402 });

  it("passes a free endpoint straight through, unpaid", async () => {
    const r = await payAndFetch(URL_OK, {}, grant, {
      signer: async () => ({ payload: {} }),
      fetcher: async () => new Response("free", { status: 200 }),
    });
    expect(r.receipt).toBeUndefined();
    expect(await r.response.text()).toBe("free");
  });

  it("pays, replays with X-PAYMENT, and records the settlement", async () => {
    const seen: (string | null)[] = [];
    const fetcher = async (_u: string, init?: RequestInit) => {
      const header = new Headers(init?.headers).get("X-PAYMENT");
      seen.push(header);
      if (!header) return json402();
      return new Response("data", {
        status: 200,
        headers: {
          "X-PAYMENT-RESPONSE": Buffer.from(JSON.stringify({ transaction: "0xabc" })).toString(
            "base64",
          ),
        },
      });
    };
    const r = await payAndFetch(URL_OK, {}, grant, {
      signer: async () => ({ payload: { sig: "0xsigned" } }),
      fetcher,
    });
    expect(seen[0]).toBeNull();
    const replayed = JSON.parse(Buffer.from(seen[1] ?? "", "base64").toString("utf8"));
    expect(replayed.payload).toEqual({ sig: "0xsigned" });
    expect(r.receipt).toMatchObject({ paid: true, usdCents: 1, transaction: "0xabc" });
  });

  it("never signs a refused purchase", async () => {
    let signed = false;
    const r = await payAndFetch("https://evil.example/x", {}, grant, {
      signer: async () => {
        signed = true;
        return { payload: {} };
      },
      fetcher: async () => json402(),
    });
    expect(signed).toBe(false);
    expect(r.refusal?.reason).toBe("payee_not_allowed");
    expect(r.receipt).toBeUndefined();
  });
});

describe("vault signer", () => {
  it("REFUSES in production rather than fabricating a signature", async () => {
    const signer = vaultSigner(undefined, undefined, "production");
    await expect(signer(offer, grant)).rejects.toBeInstanceOf(NotConfiguredError);
  });
  it("marks the development fallback as simulated", async () => {
    const out = await vaultSigner(undefined, undefined, "development")(offer, grant);
    expect(out.simulated).toBe(true);
  });
  it("sends the vault an amount it did not have to re-derive", async () => {
    let body: Record<string, unknown> = {};
    const signer = vaultSigner(
      "https://vault.local/sign",
      "tok",
      "production",
      async (_u, init) => {
        body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ payload: { sig: "ok" } }), { status: 200 });
      },
    );
    await signer(offer, grant);
    expect(body).toMatchObject({ amount: "10000", network: "base", payTo: "0xseller" });
  });
  it("throws when the vault refuses", async () => {
    const signer = vaultSigner(
      "https://vault.local/sign",
      "tok",
      "production",
      async () => new Response("no", { status: 403 }),
    );
    await expect(signer(offer, grant)).rejects.toBeInstanceOf(NotConfiguredError);
  });
});

describe("looking at the money", () => {
  const balanceReply = (atomicHex: string) => async () =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: atomicHex }));

  it("reads a balance and prices it the same way the gate does", async () => {
    // 19.98 USDC. Derived, not hand-converted — a hand-typed hex literal is a
    // second thing that can be wrong, and it was.
    const view = await walletBalance("0xD371Bb256018B09456df3Ca3b0dF38dC6C645860", USDC_BASE, {
      symbol: "USDC",
      fetcher: balanceReply(`0x${(19_980_000).toString(16)}`),
    });
    expect(view.atomic).toBe(19_980_000n);
    expect(view.usdCents).toBe(1998);
    expect(view.formatted).toBe("19.980000 USDC");
  });

  it("calls balanceOf on the token with the owner left-padded", async () => {
    let sent: any;
    await walletBalance("0xD371Bb256018B09456df3Ca3b0dF38dC6C645860", USDC_BASE, {
      fetcher: async (_u, init) => {
        sent = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ result: "0x0" }));
      },
    }).catch(() => {});
    expect(sent.method).toBe("eth_call");
    expect(sent.params[0].to).toBe(USDC_BASE.asset);
    expect(sent.params[0].data).toBe(
      "0x70a08231000000000000000000000000d371bb256018b09456df3ca3b0df38dc6c645860",
    );
  });

  it("points at the public explorer for the rail", async () => {
    const view = await walletBalance("0xabc", USDC_BASE, { fetcher: balanceReply("0x1") });
    expect(view.explorerUrl).toBe("https://basescan.org/address/0xabc"); // USDC_BASE is mainnet
    const testnet = await walletBalance(
      "0xabc",
      { ...USDC_BASE, network: "base-sepolia" },
      {
        fetcher: balanceReply("0x1"),
      },
    );
    expect(testnet.explorerUrl).toBe("https://sepolia.basescan.org/address/0xabc");
    expect(explorerTxUrl("base-sepolia", "0xdead")).toBe("https://sepolia.basescan.org/tx/0xdead");
    expect(explorerTxUrl("solana", "sig")).toBeNull();
  });

  it("REFUSES a rail it cannot read rather than reporting zero", async () => {
    await expect(
      walletBalance("0xabc", { ...USDC_BASE, network: "xrpl:1" }, {}),
    ).rejects.toBeInstanceOf(NotConfiguredError);
  });

  it("REFUSES an empty RPC result rather than reporting zero", async () => {
    await expect(
      walletBalance("0xabc", USDC_BASE, { fetcher: async () => new Response(JSON.stringify({})) }),
    ).rejects.toBeInstanceOf(NotConfiguredError);
  });
});
