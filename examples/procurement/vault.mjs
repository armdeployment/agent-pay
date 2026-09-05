/**
 * The tenant vault — the only process in this demo that holds a private key.
 *
 * agent-pay never sees it. The library hands this service an offer it has
 * already approved and gets back an opaque x402 payload, which is what keeps
 * the library zero-dependency and rail-agnostic: everything chain-shaped
 * (EIP-712 domains, EIP-3009 authorizations, secp256k1) lives here.
 *
 * A production vault would be an HSM, KMS, or a custody provider. The
 * interface it exposes is the same three fields either way.
 */
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { toHex } from "viem";
import { randomBytes } from "node:crypto";

const WALLET_FILE = new URL(".demo-wallet.json", import.meta.url).pathname;

/** One wallet, generated on first run and reused, so a funded demo stays funded. */
function loadAccount() {
  if (!existsSync(WALLET_FILE)) {
    writeFileSync(WALLET_FILE, JSON.stringify({ privateKey: generatePrivateKey() }, null, 2), {
      mode: 0o600,
    });
  }
  return privateKeyToAccount(JSON.parse(readFileSync(WALLET_FILE, "utf8")).privateKey);
}

export const account = loadAccount();

/** Chain id per x402 network name. The vault knows chains; the library does not. */
const CHAIN_IDS = { "base-sepolia": 84532, "eip155:84532": 84532, base: 8453 };

/**
 * Signs an EIP-3009 `transferWithAuthorization` — a signature, not a
 * transaction. Nothing is broadcast here and no gas is spent: the payee (or
 * its facilitator) submits it, which is why the buying agent needs no ETH,
 * no RPC node, and no chain client.
 */
export async function signExact(req) {
  const chainId = CHAIN_IDS[req.network];
  if (!chainId) throw new Error(`vault does not hold a key for network '${req.network}'`);

  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: account.address,
    to: req.payTo,
    value: BigInt(req.amount),
    validAfter: BigInt(now - 60), // clock skew between us and the payee
    validBefore: BigInt(now + (req.maxTimeoutSeconds ?? 60)),
    nonce: toHex(randomBytes(32)),
  };

  const signature = await account.signTypedData({
    domain: {
      // Domain name/version come from the token contract itself. The demo
      // reads them off-chain in demo.mjs and passes them through `extra`,
      // exactly as x402 sellers advertise them.
      name: req.extra?.name ?? "USDC",
      version: req.extra?.version ?? "2",
      chainId,
      verifyingContract: req.asset,
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
    message: authorization,
  });

  return {
    signature,
    authorization: {
      ...authorization,
      value: authorization.value.toString(),
      validAfter: authorization.validAfter.toString(),
      validBefore: authorization.validBefore.toString(),
    },
  };
}

/** The HTTP surface agent-pay's `vaultSigner` talks to. */
export function startVault(port = 8790, token = "demo-vault-token") {
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end("unauthorized");
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const payload = await signExact(JSON.parse(body));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ payload }));
    } catch (err) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(err.message ?? err) }));
    }
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}
