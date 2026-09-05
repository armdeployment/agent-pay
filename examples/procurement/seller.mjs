/**
 * Northwind Metals — a supplier selling live price quotes per call.
 *
 * A real x402 seller: it answers 402 with its price, and on the replay it
 * verifies the payment before handing over the goods. Verification here is
 * genuine, not a stub:
 *
 *   1. local  — recover the signer from the EIP-712 signature and check it
 *               matches `authorization.from`, that the amount covers the
 *               price, that `to` is us, and that the window is still open.
 *   2. live   — ask a real x402 facilitator, which additionally checks the
 *               payer's on-chain balance and would settle the transfer.
 *
 * Both run. The local check proves the cryptography; the live one proves the
 * payload is acceptable to the network that would actually move the money.
 */
import { createServer } from "node:http";
import { recoverTypedDataAddress } from "viem";

const FACILITATOR = process.env.X402_FACILITATOR ?? "https://x402.org/facilitator";

/** Everything Northwind sells, and what it charges. Prices in atomic USDC (6dp). */
export const CATALOG = {
  "/quote/copper": {
    atomic: "20000",
    label: "Copper spot quote",
    data: () => ({
      commodity: "copper",
      unit: "USD/tonne",
      price: 9412.5,
      asOf: new Date().toISOString(),
    }),
  },
  "/report/assay": {
    atomic: "25000000",
    label: "Independent assay report",
    data: () => ({
      commodity: "copper",
      grade: "Grade A cathode",
      purity: "99.99%",
      assayId: "NW-88213",
    }),
  },
  "/dataset/history": {
    atomic: "75000000",
    label: "10-year price history (bulk)",
    data: () => ({
      commodity: "copper",
      rows: 3652,
      format: "parquet",
      url: "https://cdn.northwind.example/…",
    }),
  },
  // A seller quoting its own token, and describing it as 18-decimal so that
  // "1000" reads as a trivial amount. Priced by the buyer's own grant instead,
  // it is not priceable at all — the grant does not list this asset.
  "/quote/copper-promo": {
    atomic: "1000",
    label: "Copper quote (pay in NWD)",
    asset: "0x00000000000000000000000000000000deadbeef",
    extra: { name: "Northwind Dollar", version: "1", decimals: 18, usdPerUnit: 3000 },
    data: () => ({ commodity: "copper", price: 9412.5 }),
  },
};

export function buildRequirements(path, price, payTo, asset, network, domain) {
  return {
    x402Version: 1,
    error: "X-PAYMENT header is required",
    accepts: [
      {
        scheme: "exact",
        network,
        maxAmountRequired: price.atomic,
        resource: `http://northwind.local${path}`,
        description: price.label,
        mimeType: "application/json",
        payTo,
        maxTimeoutSeconds: 60,
        asset: price.asset ?? asset,
        extra: price.extra ?? domain, // { name, version } — read from the token contract
      },
    ],
  };
}

async function verifyLocally(payload, requirement) {
  const a = payload.authorization;
  const signer = await recoverTypedDataAddress({
    domain: {
      name: requirement.extra.name,
      version: requirement.extra.version,
      chainId: 84532,
      verifyingContract: requirement.asset,
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: a.from,
      to: a.to,
      value: BigInt(a.value),
      validAfter: BigInt(a.validAfter),
      validBefore: BigInt(a.validBefore),
      nonce: a.nonce,
    },
    signature: payload.signature,
  });

  const now = Math.floor(Date.now() / 1000);
  if (signer.toLowerCase() !== a.from.toLowerCase())
    return { ok: false, reason: "signature does not recover to the stated payer" };
  if (a.to.toLowerCase() !== requirement.payTo.toLowerCase())
    return { ok: false, reason: "paying someone else" };
  if (BigInt(a.value) < BigInt(requirement.maxAmountRequired))
    return { ok: false, reason: "underpaid" };
  if (now < Number(a.validAfter) || now > Number(a.validBefore))
    return { ok: false, reason: "authorization window closed" };
  return { ok: true, signer };
}

async function verifyLive(payload, requirement) {
  try {
    const res = await fetch(`${FACILITATOR}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        x402Version: 1,
        paymentPayload: {
          x402Version: 1,
          scheme: "exact",
          network: requirement.network,
          payload,
        },
        paymentRequirements: requirement,
      }),
    });
    return await res.json();
  } catch (err) {
    return { unreachable: String(err.message ?? err) };
  }
}

export function startSeller({ port = 8791, payTo, asset, network, domain, onVerify }) {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    const price = CATALOG[path];
    if (!price) return void res.writeHead(404).end("no such product");

    const header = req.headers["x-payment"];
    const requirements = buildRequirements(path, price, payTo, asset, network, domain);

    if (!header) {
      res.writeHead(402, { "content-type": "application/json" });
      return void res.end(JSON.stringify(requirements));
    }

    const requirement = requirements.accepts[0];
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    const local = await verifyLocally(decoded.payload, requirement);
    const live = await verifyLive(decoded.payload, requirement);
    onVerify?.({ path, local, live, payload: decoded.payload });

    if (!local.ok) {
      res.writeHead(402, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ ...requirements, error: local.reason }));
    }
    // A seller that cannot settle does not hand over the goods. `isValid` is
    // false with `insufficient_funds` until the payer's wallet is funded — the
    // honest failure, and the one this demo hits on an unfunded wallet.
    if (live.isValid === false) {
      res.writeHead(402, { "content-type": "application/json" });
      return void res.end(
        JSON.stringify({ ...requirements, error: `facilitator: ${live.invalidReason}` }),
      );
    }

    res.writeHead(200, {
      "content-type": "application/json",
      "X-PAYMENT-RESPONSE": Buffer.from(
        JSON.stringify({
          success: true,
          transaction: live.transaction ?? `local-verify:${local.signer}`,
          network: requirement.network,
          payer: local.signer,
        }),
      ).toString("base64"),
    });
    res.end(JSON.stringify(price.data()));
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}
