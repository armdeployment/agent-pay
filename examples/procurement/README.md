# Example: a procurement agent buying a supplier quote

A complete, runnable purchase on **Base Sepolia** — no real money.

```bash
npm install && npm run demo
```

Acme Manufacturing's procurement agent needs a live copper price from its
supplier, Northwind Metals, who sells quotes at $0.02 a call. There is no
contract, no account, and no card on file — the agent just requests the URL and
pays for what it gets.

Acme's finance team gave the agent a grant: **$50 max per purchase**, **$200
this month**, **only Northwind may be paid**, and **anything over $10 goes to a
human**. Everything the demo does is that grant meeting reality.

## What is actually real here

| Piece                    | Real?                                                                |
| ------------------------ | -------------------------------------------------------------------- |
| HTTP + x402 wire format  | Yes — real servers, real 402s, real `X-PAYMENT` headers              |
| The signing key          | Yes — secp256k1, generated on first run into `.demo-wallet.json`     |
| EIP-712 / EIP-3009       | Yes — signed by the vault, recovered and checked by the seller       |
| The USDC contract domain | Yes — `name`/`version` read off Base Sepolia at startup              |
| Payment verification     | Yes — the live `x402.org` facilitator is asked to verify the payload |
| On-chain settlement      | Only once you fund the wallet (see below)                            |

## The three processes

```
agent (agent-pay)  ──HTTP──▶  Northwind seller :8791  ──▶ x402 facilitator
       │                                                   (verify / settle)
       └──HTTP──▶ vault :8790   ← the only process holding a private key
```

That split is the point. `agent-pay` has no key, no chain client, and no
dependencies; the vault has all three. Swapping Base for XRPL or Solana is a
change inside the vault.

## What you should see

| #   | Scenario                               | Outcome                               |
| --- | -------------------------------------- | ------------------------------------- |
| 1   | Copper quote, $0.02                    | signed, verified, settles when funded |
| 2   | Same quote from an unapproved supplier | `payee_not_allowed` — never signed    |
| 3   | Assay report, $25                      | `needs_human_approval`                |
| 4   | Bulk dataset, $75                      | `over_per_call_cap`                   |
| 5   | Seller's own token, quoted 18-decimal  | `asset_not_allowed`                   |
| 6   | Budget down to $0.01                   | `over_remaining_budget`               |

Scenario 5 is the one worth staring at. The seller offers a "discount" priced
in a token it describes as 18-decimal and worth $3000 a unit. Nothing in that
description is consulted: the asset is not in the grant, so it cannot be paid,
and a seller therefore has no way to price its own invoice.

Note that refusals happen **before** the vault is called. A purchase outside
the grant never becomes a signature.

## A real settlement

With the wallet funded, scenario 1 completes for real on Base Sepolia:

```
1. Buy today's copper quote — $0.02
  PAID     $0.02 → 0x209693Bc…
  settlement: 0x21ff3f6dfd80222b94e499b79dc87501959460897ce59c54820cda552fae0b5b
  goods:    {"commodity":"copper","unit":"USD/tonne","price":9412.5,…}

  local EIP-712 recovery : VALID  (recovered 0xD371…5860)
  live x402 facilitator  : VALID
  settlement /quote/copper: SETTLED
```

[On-chain](https://sepolia.basescan.org/tx/0x21ff3f6dfd80222b94e499b79dc87501959460897ce59c54820cda552fae0b5b):
one ERC-20 `Transfer` of 0.02 USDC from the agent's wallet to Northwind, in
block 46434328. The payer's balance went 20 → 19.98.

The line worth staring at is the one that is missing. The agent's wallet holds
**zero ETH**, and the transaction's `from` is the facilitator's address, not the
agent's — the facilitator paid the gas to redeem an authorization the agent
merely signed. That is why a buying agent needs no gas, no RPC node, and no
chain client, and why `agent-pay` can have no dependencies.

## Funding your own run

`.demo-wallet.json` is generated on first run and gitignored. Fund the printed
address with free Base Sepolia USDC at **<https://faucet.circle.com>** — pick
the **Base Sepolia** network, the drip is 20 USDC. Until it is funded the
facilitator verifies the signature and then honestly declines:

```
local EIP-712 recovery : VALID
live x402 facilitator  : invalid_exact_evm_insufficient_balance
```

It is a testnet key. Do not fund it with anything real.
