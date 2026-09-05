/**
 * Acme Manufacturing's procurement agent buys a copper quote.
 *
 * Everything here is real: real HTTP between three processes' worth of
 * servers, the real x402 wire format, a real secp256k1 key in the vault, real
 * EIP-712/EIP-3009 signatures, the real USDC contract's domain read off Base
 * Sepolia, and a real x402 facilitator asked to verify what was signed.
 *
 * The only thing that does not happen is settlement, and only because the
 * demo wallet starts with no testnet USDC. Fund it and the last step settles
 * on Base Sepolia for free. The address is printed at the bottom.
 *
 *   node demo.mjs
 */
import { payAndFetch, vaultSigner } from "../../dist/index.js";
import { startVault, account } from "./vault.mjs";
import { startSeller } from "./seller.mjs";

const RPC = process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // Base Sepolia USDC
const NETWORK = "base-sepolia";

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  no: (s) => `\x1b[33m${s}\x1b[0m`,
  err: (s) => `\x1b[31m${s}\x1b[0m`,
};

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await res.json()).result;
}

/** Reads the token's real EIP-712 domain rather than assuming it. */
async function readDomain() {
  const str = async (selector) => {
    const hex = (await rpc("eth_call", [{ to: USDC, data: selector }, "latest"])).slice(2);
    const off = parseInt(hex.slice(0, 64), 16) * 2;
    const len = parseInt(hex.slice(off, off + 64), 16) * 2;
    return Buffer.from(hex.slice(off + 64, off + 64 + len), "hex").toString();
  };
  return { name: await str("0x06fdde03"), version: await str("0x54fd4d50") };
}

async function usdcBalance(address) {
  const data = `0x70a08231${address.slice(2).toLowerCase().padStart(64, "0")}`;
  return BigInt((await rpc("eth_call", [{ to: USDC, data }, "latest"])) ?? "0x0");
}

// ── The grant: what Acme's finance team gave this agent ────────────────────
// In ARM this is minted by the control plane against real budgets and
// approvals. Standalone it is just this object.
const grant = {
  agentId: "agt_procurement_01",
  tenantId: "acme",
  maxPerCallUsdCents: 5_000, // $50.00 a purchase
  remainingUsdCents: 20_000, // $200.00 left this month
  allowedPayeeHosts: ["localhost:8791"], // Northwind Metals, and nobody else
  allowedAssets: [{ network: NETWORK, asset: USDC, decimals: 6, usdPerUnit: 1 }],
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  humanApprovalAboveUsdCents: 1_000, // $10+ goes to a person
};

let verifications = [];
let settlements = [];

async function buy(label, url, activeGrant = grant) {
  const signer = vaultSigner("http://localhost:8790", "demo-vault-token", "production");
  process.stdout.write(`\n${c.b(label)}\n  ${c.dim(url)}\n`);
  const { response, receipt, refusal } = await payAndFetch(url, {}, activeGrant, { signer });

  if (refusal) {
    console.log(
      `  ${c.no("REFUSED")}  ${refusal.reason}${refusal.detail ? ` — ${refusal.detail}` : ""}`,
    );
    console.log(`  ${c.dim("nothing was signed; no key material was touched")}`);
    return { spentCents: 0 };
  }
  if (receipt?.paid) {
    console.log(
      `  ${c.ok("PAID")}     $${(receipt.usdCents / 100).toFixed(2)} → ${receipt.payTo.slice(0, 10)}…`,
    );
    console.log(`  ${c.dim(`settlement: ${receipt.transaction}`)}`);
    console.log(`  goods:    ${JSON.stringify(await response.json())}`);
    return { spentCents: receipt.usdCents };
  }
  const body = await response.json().catch(() => ({}));
  console.log(`  ${c.err("PAYMENT DECLINED BY SELLER")}  ${body.error ?? response.status}`);
  console.log(`  ${c.dim("agent-pay gated and signed correctly; the seller would not settle")}`);
  return { spentCents: 0 };
}

const main = async () => {
  console.log(c.b("\n═══ agent-pay — Acme procurement agent, Base Sepolia ═══"));
  const domain = await readDomain();
  console.log(
    `\nUSDC ${USDC}\n  EIP-712 domain read from chain: name=${c.b(domain.name)} version=${c.b(domain.version)}`,
  );
  console.log(`Vault wallet: ${c.b(account.address)}`);
  const balance = await usdcBalance(account.address);
  console.log(`  testnet USDC balance: ${c.b((Number(balance) / 1e6).toFixed(6))}`);

  const vault = await startVault(8790);
  const seller = await startSeller({
    port: 8791,
    payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    asset: USDC,
    network: NETWORK,
    domain,
    onVerify: (v) => verifications.push(v),
    onSettle: (s) => settlements.push(s),
  });
  // A supplier Acme has no relationship with.
  const rogue = await startSeller({
    port: 8792,
    payTo: "0x000000000000000000000000000000000000dEaD",
    asset: USDC,
    network: NETWORK,
    domain,
  });

  console.log(c.dim("\nvault :8790   northwind :8791   unknown-supplier :8792"));

  await buy("1. Buy today's copper quote — $0.02", "http://localhost:8791/quote/copper");

  await buy(
    "2. Same quote from a supplier finance never approved — $0.02",
    "http://127.0.0.1:8792/quote/copper",
  );

  await buy(
    "3. An independent assay report — $25.00, over the $10 approval line",
    "http://localhost:8791/report/assay",
  );

  await buy(
    "4. The bulk 10-year dataset — $75.00, over the $50 per-purchase cap",
    "http://localhost:8791/dataset/history",
  );

  await buy(
    "5. Seller offers a discount in its own token, quoted as 18-decimal",
    "http://localhost:8791/quote/copper-promo",
  );

  await buy(
    "6. Same $0.02 quote, but the month's budget is down to $0.01",
    "http://localhost:8791/quote/copper",
    { ...grant, remainingUsdCents: 1 },
  );

  // ── What the facilitator actually said ──────────────────────────────────
  console.log(c.b("\n─── real verification of what the vault signed ───"));
  for (const v of verifications) {
    console.log(`\n  ${v.path}`);
    console.log(
      `    local EIP-712 recovery : ${v.local.ok ? c.ok("VALID") : c.err(v.local.reason)}` +
        (v.local.ok ? c.dim(`  (recovered ${v.local.signer})`) : ""),
    );
    const live = v.live;
    const verdict = live.unreachable
      ? c.no(`unreachable — ${live.unreachable}`)
      : live.isValid
        ? c.ok("VALID")
        : c.no(`${live.invalidReason}`);
    console.log(`    live x402 facilitator  : ${verdict}`);
  }

  for (const s of settlements) {
    const t = s.settled;
    console.log(
      `\n  settlement ${s.path}: ` +
        (t.success
          ? `${c.ok("SETTLED")} ${c.dim(`https://sepolia.basescan.org/tx/${t.transaction}`)}`
          : c.no(t.errorReason ?? t.unreachable ?? "declined")),
    );
  }

  if (balance === 0n) {
    console.log(
      c.b("\n─── to make step 1 settle for real ───") +
        `\n  The signature is valid; the wallet just holds no testnet USDC, so the` +
        `\n  facilitator declines. Fund it (free, testnet only) at:` +
        `\n\n    ${c.b("https://faucet.circle.com")}  → Base Sepolia → ${account.address}` +
        `\n\n  Then re-run. The faucet needs a human (sign-in + captcha).\n`,
    );
  }

  vault.close();
  seller.close();
  rogue.close();
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
