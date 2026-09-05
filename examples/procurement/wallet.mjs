/**
 * "Where is my agent's money, and what has it been spending?"
 *
 *   npm run wallet
 *
 * Answers the three questions the dashboard would answer, if a wallet came
 * with one. It does not: an address is not an account with a provider.
 */
import { walletBalance, explorerTxUrl } from "../../dist/index.js";
import { account } from "./vault.mjs";

const USDC = {
  network: "base-sepolia",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  decimals: 6,
  usdPerUnit: 1,
};

const view = await walletBalance(account.address, USDC, { symbol: "USDC" });

console.log(`
  Your agent's account
  ────────────────────
  Address    ${view.address}
     ↑ this is where you send money. It is the account number.

  Balance    ${view.formatted}   ($${(view.usdCents / 100).toFixed(2)})

  To add money   send USDC on Base Sepolia to the address above.
                 Testnet: https://faucet.circle.com (free, 20 USDC)

  Every payment in and out, permanently, publicly:
  ${view.explorerUrl}
`);

if (process.argv[2]) {
  console.log(`  That receipt: ${explorerTxUrl(USDC.network, process.argv[2])}\n`);
}
