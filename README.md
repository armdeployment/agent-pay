<div align="center">

# agent-pay

**Let an AI agent buy things.**

Paid APIs, data feeds, another company's agent, a seller's endpoint — over
ordinary HTTP, with spend caps you set and no private keys in your process.

[![CI](https://github.com/armdeployment/agent-pay/actions/workflows/ci.yml/badge.svg)](https://github.com/armdeployment/agent-pay/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

</div>

---

## The idea

Your agent requests a URL. If it costs money, the URL says so — `402 Payment
Required`, with a price attached. `agent-pay` checks that price against the
agent's budget, has your vault sign for it, and replays the request.

```ts
import { payAndFetch, defaultSigner } from "agent-pay";

const { response, receipt, refusal } = await payAndFetch(
  "https://api.seller.example/report",
  { method: "GET" },
  grant,
  { signer: defaultSigner() },
);

if (refusal) console.error(`refused: ${refusal.reason}`); // over_per_call_cap, payee_not_allowed, …
if (receipt) console.log(`paid ${receipt.usdCents}c → ${receipt.transaction}`);
```

A free URL comes back untouched. Your agent's code doesn't need to know which
URLs cost money and which don't.

The wire protocol is [x402](https://x402.org) — HTTP 402 plus an `X-PAYMENT`
header — so any x402 seller, API, or agent is already a counterparty. Money
settles as stablecoin because that is what lets one machine pay another in a
couple of seconds for a fraction of a cent, with no invoice, no account, and no
card on file at the seller.

## Nobody has to understand any of that

That is the point. There is no seed phrase in this library, because there are
no keys in it. Signing happens behind an HTTP call to a vault you control.
Whoever sets this up sees three things, all in dollars:

1. **A funded account.** Topped up by card or transfer.
2. **Caps.** Per purchase, per month, and the amount above which a human
   approves it instead.
3. **An allowlist.** The hostnames an agent is allowed to pay.

Those three become a `PaymentGrant`, and that is the only thing this library
takes an opinion on.

## Install

```bash
npm install agent-pay
```

Zero runtime dependencies. Node 20+.

```bash
ARM_PAY_SIGNER_URL=https://vault.internal/sign   # your vault's signing endpoint
ARM_PAY_SIGNER_TOKEN=…                           # bearer token for it
```

With no signer configured, `defaultSigner()` returns clearly-marked simulated
payloads in development and **refuses outright in production** — a signature
that fails at settlement surfaces as an opaque seller error hours later, which
is the worst way to find out you were misconfigured.

## The grant

```ts
const grant: PaymentGrant = {
  agentId: "agt_01",
  tenantId: "tn_01",
  maxPerCallUsdCents: 500, // $5 a purchase
  remainingUsdCents: 20_000, // $200 left this month
  allowedPayeeHosts: ["api.seller.example"],
  allowedAssets: [
    {
      network: "base",
      asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC
      decimals: 6,
      usdPerUnit: 1,
    },
  ],
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  humanApprovalAboveUsdCents: 5_000, // $50+ goes to a person
};
```

Mint it short-lived, from wherever your budgets actually live. `gateOffer` is a
pure function of `(offer, grant, url)`, so you can test your own policy against
it without a network.

## What stops this going wrong

| Concern                         | How it is handled                                                                       |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| Keys get stolen                 | There are none here. Signing is an injected `PaymentSigner` behind your vault.          |
| An agent overspends             | Every purchase is gated: per-call cap, remaining budget, grant expiry.                  |
| An agent pays the wrong party   | Payee allowlist, matched against the URL **you** requested — not against the reply.     |
| A seller inflates its own price | Assets are valued from the grant's terms. A 402 body cannot price its own invoice.      |
| A big purchase slips through    | `humanApprovalAboveUsdCents` refuses it and hands it to your approval flow.             |
| Rounding                        | Integer maths on `BigInt` atomic units, rounded **up**. A cap is never lost to a float. |
| Nothing is configured           | Production refuses to sign rather than producing a payload that fails later.            |

The price-spoofing one is worth spelling out, because it is the attack you
would otherwise walk into: a 402 response is written by whoever you are about
to pay. If you take `decimals` from it, a seller quotes `1000` of a token it
claims has 18 decimals and drains a $5 cap. So valuation comes from the grant's
`allowedAssets` and nowhere else, and an asset the grant doesn't list cannot be
paid at all, however convincingly the response describes it.

## Rails

x402 settles on EVM stablecoins (Base and friends) and Solana today. This
library is rail-agnostic on purpose — it validates and gates, your vault signs
— so a new rail is a change behind the `PaymentSigner` interface, not a change
here.

Bitcoin and XRP are deliberately not wired up: neither is an x402 settlement
rail, and BTC's block time makes per-call agent purchases impractical. Both
would need a settlement adapter behind the same interface. Open an issue if you
need one.

## API

| Export                 | What it does                                                       |
| ---------------------- | ------------------------------------------------------------------ |
| `payAndFetch`          | Fetch a URL, paying if it answers 402. Returns response + receipt. |
| `gateOffer`            | Pure allow/refuse for one offer against a grant. The money rule.   |
| `selectOffer`          | First offer in a 402 body the grant permits.                       |
| `parsePaymentRequired` | Parse a 402 body; `null` on anything malformed.                    |
| `atomicToUsdCents`     | Price atomic units in cents, `BigInt` maths, rounded up.           |
| `vaultSigner`          | Signer backed by your vault's HTTP endpoint.                       |
| `defaultSigner`        | `vaultSigner` wired from the environment.                          |

## Development

```bash
npm install
npm test
npm run typecheck
```

## Where this came from

Built for [ARM](https://github.com/armdeployment/arm), an HR-style control
plane for AI agents, as its `pay` connector strategy — but it has no ARM
dependency and is useful on its own. Inside ARM the grant is minted by the
control plane against real budgets and approvals, and the receipt flows back to
the spend ledger.

Apache-2.0.
