/**
 * agent-pay — let an agent buy things over HTTP.
 *
 * Lets an agent buy things: paid APIs, another agent's service, a seller's
 * endpoint. The wire protocol is x402 (HTTP 402 + `X-PAYMENT`), so a purchase
 * is an ordinary HTTP request that got a price attached:
 *
 *   1. agent requests a resource        → 402 + payment requirements (JSON)
 *   2. ARM gates it against the grant   → allow / refuse, with a reason
 *   3. the tenant vault signs           → an authorization payload
 *   4. agent replays with `X-PAYMENT`   → 200 + `X-PAYMENT-RESPONSE` receipt
 *
 * No chain client, no RPC node, no gas, and no private key in this process.
 * Step 3 is the ONLY chain-aware step and it happens behind the vault's HTTP
 * signer, which is what makes this connector rail-agnostic: EVM stablecoins
 * (USDC/USDT on Base et al) and Solana are what x402 facilitators settle
 * today; adding a rail is a vault change, not a change here.
 *
 * SECURITY — the payee is not a source of truth. A 402 response is written by
 * whoever we are about to pay, so nothing in it is trusted for valuation. The
 * asset's `decimals` and `usdPerUnit` come from the ARM-minted grant only
 * (`AssetTerms`); an asset the grant does not list cannot be paid, however
 * convincingly the response describes it. Without that rule a seller quotes
 * "1000" of a token it claims has 18 decimals and drains a $5 cap.
 *
 * Zero dependencies, and deliberately not coupled to ARM: the budget decision
 * arrives as a `PaymentGrant` that some authority upstream minted, and the
 * spend goes back out as a `PaymentReceipt`. Inside ARM that authority is the
 * control plane; standalone it can be a config file. This library only
 * enforces and reports.
 */

/** Thrown when a payment path is reached that has no working configuration. */
export class NotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotConfiguredError";
  }
}

/** What one unit of an allowed asset is worth, per the control plane. */
export interface AssetTerms {
  /** Chain id as x402 names it, e.g. "base", "base-sepolia", "solana". */
  network: string;
  /** Contract/mint address of the asset, lowercased for comparison. */
  asset: string;
  /** Atomic-unit exponent. USDC/USDT are 6. Never read from the payee. */
  decimals: number;
  /**
   * USD per whole unit. 1 for a USD stablecoin. Required — defaulting it to 1
   * would price 1 ETH at one dollar and walk straight through a $5 cap.
   */
  usdPerUnit: number;
}

/**
 * A short-lived spend authorization minted by the control plane, carrying the
 * budget decision with it. The data plane enforces, it does not decide.
 */
export interface PaymentGrant {
  agentId: string;
  tenantId: string;
  /** Ceiling for a single purchase. */
  maxPerCallUsdCents: number;
  /** What is left of this agent's budget window. */
  remainingUsdCents: number;
  /** Hostnames the agent may pay. Exact host match, no wildcards. */
  allowedPayeeHosts: string[];
  /** Assets this agent may spend, with their authoritative valuation. */
  allowedAssets: AssetTerms[];
  /** ISO timestamp. Expired grants are refused, not renewed here. */
  expiresAt: string;
  /**
   * Purchases at or above this trip a human approval in the control plane.
   * Absent = no purchase in this grant needs one; the grant already is the
   * approval.
   */
  humanApprovalAboveUsdCents?: number;
}

/** One priced offer from a 402 response (x402 `accepts[]` entry). */
export interface PaymentOffer {
  scheme: string;
  network: string;
  /** Price in atomic units of `asset`, as a decimal string. */
  maxAmountRequired: string;
  payTo: string;
  asset: string;
  resource?: string;
  description?: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

/** The parsed 402 body. */
export interface PaymentRequired {
  x402Version: number;
  accepts: PaymentOffer[];
  error?: string;
}

/** Why a purchase was refused. Every refusal names a rule, never "denied". */
export type RefusalReason =
  | "grant_expired"
  | "no_acceptable_offer"
  | "payee_not_allowed"
  | "asset_not_allowed"
  | "over_per_call_cap"
  | "over_remaining_budget"
  | "needs_human_approval"
  | "unsupported_scheme"
  | "malformed_offer";

export interface GateDecision {
  allowed: boolean;
  reason?: RefusalReason;
  detail?: string;
  /** Price of the gated offer, once it could be valued. */
  usdCents?: number;
}

/** What actually happened, for the control-plane spend ledger. */
export interface PaymentReceipt {
  paid: boolean;
  usdCents: number;
  network: string;
  asset: string;
  payTo: string;
  resource: string;
  /** Settlement id from `X-PAYMENT-RESPONSE`, when the payee returned one. */
  transaction?: string;
  /** Set when the signer was simulated — never a real settlement. */
  simulated?: boolean;
}

/**
 * Signs one offer. Implemented by the tenant vault, which holds the key
 * material and knows the chain; this connector only hands it an offer it has
 * already approved and gets back an opaque x402 payload.
 */
export type PaymentSigner = (
  offer: PaymentOffer,
  grant: PaymentGrant,
) => Promise<{ payload: unknown; simulated?: boolean }>;

/** Injected in tests so the 402 dance runs without a live payee. */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

// ── Valuation ──────────────────────────────────────────────────────────────

/**
 * Prices an atomic amount in USD cents, rounding UP.
 *
 * Integer maths throughout: token amounts are 256-bit and a float divide
 * silently loses the low digits of a large one. Rounding up is the safe
 * direction for a spend gate — the cap is never exceeded by a rounding error.
 * Returns null on anything unparseable rather than a zero price.
 */
export function atomicToUsdCents(atomic: string, terms: AssetTerms): number | null {
  if (!/^\d+$/.test(atomic)) return null;
  if (!Number.isInteger(terms.decimals) || terms.decimals < 0 || terms.decimals > 36) return null;
  if (!(terms.usdPerUnit > 0) || !Number.isFinite(terms.usdPerUnit)) return null;
  // usdPerUnit carried as micro-dollars so the rate itself stays integral.
  const rateMicros = BigInt(Math.round(terms.usdPerUnit * 1_000_000));
  const numerator = BigInt(atomic) * rateMicros * 100n;
  const denominator = 10n ** BigInt(terms.decimals) * 1_000_000n;
  const cents = (numerator + denominator - 1n) / denominator; // ceil
  return cents > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(cents);
}

// ── Parsing ────────────────────────────────────────────────────────────────

/**
 * Reads a 402 body into offers. Anything malformed yields null: a purchase
 * built from a half-understood price is worse than a failed request.
 */
export function parsePaymentRequired(body: unknown): PaymentRequired | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.accepts)) return null;
  const accepts: PaymentOffer[] = [];
  for (const raw of b.accepts) {
    if (typeof raw !== "object" || raw === null) continue;
    const o = raw as Record<string, unknown>;
    if (
      typeof o.scheme !== "string" ||
      typeof o.network !== "string" ||
      typeof o.maxAmountRequired !== "string" ||
      typeof o.payTo !== "string" ||
      typeof o.asset !== "string"
    ) {
      continue;
    }
    accepts.push(o as unknown as PaymentOffer);
  }
  if (accepts.length === 0) return null;
  return {
    x402Version: typeof b.x402Version === "number" ? b.x402Version : 1,
    accepts,
    ...(typeof b.error === "string" ? { error: b.error } : {}),
  };
}

// ── The gate ───────────────────────────────────────────────────────────────

/** Only `exact` is settled today; other schemes are refused, not guessed at. */
const SUPPORTED_SCHEMES = new Set(["exact"]);

/**
 * Decides one offer against the grant. Pure — this is the money rule, and it
 * is a function of its arguments so a test can hold every branch.
 *
 * `resourceUrl` is the URL the agent actually requested. The host allowlist is
 * checked against it rather than against `offer.resource`, which the payee
 * controls and could point anywhere.
 */
export function gateOffer(
  offer: PaymentOffer,
  grant: PaymentGrant,
  resourceUrl: string,
  now: Date = new Date(),
): GateDecision {
  if (Date.parse(grant.expiresAt) <= now.getTime()) {
    return { allowed: false, reason: "grant_expired", detail: `grant expired ${grant.expiresAt}` };
  }
  if (!SUPPORTED_SCHEMES.has(offer.scheme)) {
    return { allowed: false, reason: "unsupported_scheme", detail: offer.scheme };
  }
  let host: string;
  try {
    host = new URL(resourceUrl).host;
  } catch {
    return { allowed: false, reason: "malformed_offer", detail: `bad resource url ${resourceUrl}` };
  }
  if (!grant.allowedPayeeHosts.includes(host)) {
    return { allowed: false, reason: "payee_not_allowed", detail: host };
  }
  const terms = grant.allowedAssets.find(
    (a) => a.network === offer.network && a.asset.toLowerCase() === offer.asset.toLowerCase(),
  );
  if (!terms) {
    return {
      allowed: false,
      reason: "asset_not_allowed",
      detail: `${offer.network}:${offer.asset}`,
    };
  }
  const usdCents = atomicToUsdCents(offer.maxAmountRequired, terms);
  if (usdCents === null) {
    return { allowed: false, reason: "malformed_offer", detail: offer.maxAmountRequired };
  }
  if (usdCents > grant.maxPerCallUsdCents) {
    return { allowed: false, reason: "over_per_call_cap", detail: `${usdCents}c`, usdCents };
  }
  if (usdCents > grant.remainingUsdCents) {
    return { allowed: false, reason: "over_remaining_budget", detail: `${usdCents}c`, usdCents };
  }
  if (
    grant.humanApprovalAboveUsdCents !== undefined &&
    usdCents >= grant.humanApprovalAboveUsdCents
  ) {
    return { allowed: false, reason: "needs_human_approval", detail: `${usdCents}c`, usdCents };
  }
  return { allowed: true, usdCents };
}

/** First offer the grant permits, with the refusal of the last one if none do. */
export function selectOffer(
  reqs: PaymentRequired,
  grant: PaymentGrant,
  resourceUrl: string,
  now?: Date,
): { offer: PaymentOffer; usdCents: number } | { offer: null; decision: GateDecision } {
  let last: GateDecision = { allowed: false, reason: "no_acceptable_offer" };
  for (const offer of reqs.accepts) {
    const decision = gateOffer(offer, grant, resourceUrl, now);
    if (decision.allowed) return { offer, usdCents: decision.usdCents ?? 0 };
    last = decision;
  }
  return { offer: null, decision: last };
}

// ── The vault signer ───────────────────────────────────────────────────────

/**
 * Asks the tenant vault to sign an approved offer.
 *
 * The vault holds the key and speaks the chain; ARM never sees key material,
 * which is also why the human setting this up never sees a seed phrase. When
 * no vault is configured this returns a clearly-marked simulated payload in
 * development and REFUSES in production — a fake signature that fails at the
 * payee is the worst kind of success.
 */
export function vaultSigner(
  signerUrl: string | undefined,
  signerToken: string | undefined,
  nodeEnv: string,
  fetcher: Fetcher = fetch,
): PaymentSigner {
  return async (offer, grant) => {
    if (!signerUrl) {
      if (nodeEnv === "production") {
        throw new NotConfiguredError(
          "No payment signer configured (ARM_PAY_SIGNER_URL). Refusing to fabricate an " +
            `x402 payload for agent '${grant.agentId}': it would be rejected at settlement ` +
            "and surface as an opaque payee error rather than a configuration one.",
        );
      }
      return { payload: { simulated: true, offer: offer.resource ?? null }, simulated: true };
    }
    const res = await fetcher(signerUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(signerToken ? { authorization: `Bearer ${signerToken}` } : {}),
      },
      body: JSON.stringify({
        agentId: grant.agentId,
        tenantId: grant.tenantId,
        scheme: offer.scheme,
        network: offer.network,
        asset: offer.asset,
        payTo: offer.payTo,
        amount: offer.maxAmountRequired,
        maxTimeoutSeconds: offer.maxTimeoutSeconds ?? 60,
        extra: offer.extra ?? {},
      }),
    });
    if (!res.ok) {
      throw new NotConfiguredError(
        `Tenant vault refused to sign (${res.status}) for agent '${grant.agentId}'.`,
      );
    }
    const body = (await res.json()) as { payload?: unknown };
    if (body.payload === undefined) {
      throw new NotConfiguredError("Vault signer returned no payload.");
    }
    return { payload: body.payload };
  };
}

// ── The purchase ───────────────────────────────────────────────────────────

export interface PayResult {
  response: Response;
  /** Present only when a payment was actually attempted. */
  receipt?: PaymentReceipt;
  /** Present when the request was priced and refused. */
  refusal?: GateDecision;
}

/**
 * Fetches a URL, paying for it if it answers 402.
 *
 * A non-402 response comes back untouched — free endpoints stay free, and the
 * agent calling this needs no idea whether a given URL costs money.
 */
export async function payAndFetch(
  url: string,
  init: RequestInit,
  grant: PaymentGrant,
  deps: { signer: PaymentSigner; fetcher?: Fetcher; now?: Date },
): Promise<PayResult> {
  const fetcher = deps.fetcher ?? fetch;
  const first = await fetcher(url, init);
  if (first.status !== 402) return { response: first };

  const reqs = parsePaymentRequired(
    await first
      .clone()
      .json()
      .catch(() => null),
  );
  if (!reqs) {
    return {
      response: first,
      refusal: { allowed: false, reason: "malformed_offer", detail: "unparseable 402 body" },
    };
  }

  const picked = selectOffer(reqs, grant, url, deps.now);
  if (picked.offer === null) return { response: first, refusal: picked.decision };

  const { payload, simulated } = await deps.signer(picked.offer, grant);
  const header = Buffer.from(
    JSON.stringify({
      x402Version: reqs.x402Version,
      scheme: picked.offer.scheme,
      network: picked.offer.network,
      payload,
    }),
  ).toString("base64");

  const paidHeaders = new Headers(init.headers);
  paidHeaders.set("X-PAYMENT", header);
  const second = await fetcher(url, { ...init, headers: paidHeaders });

  const receipt: PaymentReceipt = {
    paid: second.ok,
    usdCents: picked.usdCents,
    network: picked.offer.network,
    asset: picked.offer.asset,
    payTo: picked.offer.payTo,
    resource: url,
    ...(simulated ? { simulated: true } : {}),
  };
  const settlement = second.headers.get("X-PAYMENT-RESPONSE");
  if (settlement) {
    try {
      const decoded = JSON.parse(Buffer.from(settlement, "base64").toString("utf8")) as {
        transaction?: string;
      };
      if (typeof decoded.transaction === "string") receipt.transaction = decoded.transaction;
    } catch {
      // A payee that returns an unreadable receipt still took the money; the
      // receipt records the spend without a settlement id rather than dropping it.
    }
  }
  return { response: second, receipt };
}

/**
 * The signer you get when you have not wired one yourself: the vault named by
 * `ARM_PAY_SIGNER_URL`. Read on call, not at import, so a process that loads
 * its environment late still gets a working signer.
 */
export function defaultSigner(): PaymentSigner {
  return vaultSigner(
    process.env.ARM_PAY_SIGNER_URL,
    process.env.ARM_PAY_SIGNER_TOKEN,
    process.env.NODE_ENV ?? "development",
  );
}

// ── Looking at the money ───────────────────────────────────────────────────

/**
 * Where an agent's funds live and where to go and look at them.
 *
 * A wallet address is not an account with a provider — there is no dashboard
 * that comes with it. The balance is a question you ask the chain, and the
 * history is a public page. These two helpers are the answers, so that
 * "how much has my agent got left?" is a function call rather than a research
 * project.
 */
const EVM_RPC: Record<string, string> = {
  "base-sepolia": "https://sepolia.base.org",
  "eip155:84532": "https://sepolia.base.org",
  base: "https://mainnet.base.org",
  "eip155:8453": "https://mainnet.base.org",
};

const EVM_EXPLORER: Record<string, string> = {
  "base-sepolia": "https://sepolia.basescan.org",
  "eip155:84532": "https://sepolia.basescan.org",
  base: "https://basescan.org",
  "eip155:8453": "https://basescan.org",
};

export interface WalletView {
  address: string;
  /** Raw token units. */
  atomic: bigint;
  /** Priced by the same rules that gate a purchase, so the two agree. */
  usdCents: number;
  /** Human-readable, e.g. "19.98 USDC". */
  formatted: string;
  /** The public page showing this wallet and every transfer in or out. */
  explorerUrl: string;
}

/** Link to a transaction on the rail's public explorer, for a receipt. */
export function explorerTxUrl(network: string, transaction: string): string | null {
  const base = EVM_EXPLORER[network];
  return base ? `${base}/tx/${transaction}` : null;
}

/**
 * Reads an agent's balance straight from the chain.
 *
 * EVM rails only — one `eth_call` to the token's `balanceOf`, which is why
 * this needs no dependency and no API key. Other rails have different RPC
 * shapes; rather than pretend, this refuses and names what it would need.
 */
export async function walletBalance(
  address: string,
  terms: AssetTerms,
  opts: { rpcUrl?: string; symbol?: string; fetcher?: Fetcher } = {},
): Promise<WalletView> {
  const rpcUrl = opts.rpcUrl ?? EVM_RPC[terms.network];
  if (!rpcUrl) {
    throw new NotConfiguredError(
      `No built-in RPC for network '${terms.network}'. Pass \`rpcUrl\` for an EVM chain; ` +
        "non-EVM rails (Solana, XRPL, Stellar…) need their own balance call, which this " +
        "library does not speak.",
    );
  }
  const fetcher = opts.fetcher ?? fetch;
  const data = `0x70a08231${address.slice(2).toLowerCase().padStart(64, "0")}`;
  const res = await fetcher(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: terms.asset, data }, "latest"],
    }),
  });
  const body = (await res.json()) as { result?: string; error?: { message?: string } };
  if (!body.result || body.result === "0x") {
    throw new NotConfiguredError(
      `Balance read failed on ${terms.network}: ${body.error?.message ?? "empty result"}`,
    );
  }
  const atomic = BigInt(body.result);
  const whole = Number(atomic) / 10 ** terms.decimals;
  const explorer = EVM_EXPLORER[terms.network];
  return {
    address,
    atomic,
    usdCents: atomicToUsdCents(atomic.toString(), terms) ?? 0,
    formatted: `${whole.toFixed(Math.min(terms.decimals, 6))} ${opts.symbol ?? "tokens"}`,
    explorerUrl: explorer ? `${explorer}/address/${address}` : rpcUrl,
  };
}
