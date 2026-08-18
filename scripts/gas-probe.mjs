#!/usr/bin/env node
/**
 * Measure what the user paths and the keeper's upkeep actually cost, and check that the
 * limits the app declares are enough.
 *
 * A Cosmos transaction is charged the fee it declares, not the gas it burns, so these
 * limits are a real cost to users rather than a safety net that is free to leave loose.
 * They should be sized from this script's output, not from caution — and re-run whenever
 * the pricing path changes, because deposits and withdrawals re-read every validator and
 * that cost scales with the set.
 *
 * Devnet only. Uses the public LocalSecret genesis key, which is not a secret.
 *
 *   node scripts/devnet.mjs up
 *   node scripts/deploy.mjs --network devnet
 *   node scripts/gas-probe.mjs
 */

import { existsSync, readFileSync } from "node:fs";
import { SecretNetworkClient, Wallet } from "secretjs";

const d = JSON.parse(readFileSync("deploy/devnet.json", "utf8"));

/*
 * The clients live in their own repositories now.
 *
 * This script used to read `app/src/lib/protocol.ts` and `keeper/src/client.ts` out of the
 * same tree. They moved, and a scrape that cannot find its target is worse than no scrape:
 * it would validate whatever it last saw and report success. So the paths are supplied, and
 * when they are not, the run measures and prints but explicitly claims nothing.
 *
 *   node scripts/gas-probe.mjs --app ../dscrt-app --keeper ../dscrt-keeper
 */
const argOf = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

function clientSource(name, envVar, relative) {
  const root = argOf(name) ?? process.env[envVar];
  if (!root) return null;
  const path = `${root}/${relative}`;
  if (!existsSync(path)) {
    throw new Error(`--${name} was given as ${root}, but ${path} does not exist.`);
  }
  return readFileSync(path, "utf8");
}

const app = clientSource("app", "DSCRT_APP", "src/lib/protocol.ts");

/** Generous enough that any path here goes through, for a run that is only measuring. */
const UNCHECKED_LIMIT = 1_500_000;

const num = (re) => Number(app.match(re)[1].replace(/_/g, ""));

const BASE = app && {
  deposit: num(/deposit: ([\d_]+), unbond/),
  unbond: num(/unbond: ([\d_]+) \} as const/),
};
const PER_VALIDATOR = app ? num(/GAS_PER_VALIDATOR = ([\d_]+)/) : null;
const MARGIN = app ? Number(app.match(/GAS_MARGIN = ([\d.]+)/)[1]) : null;
const PRICE = app ? Number(app.match(/GAS_PRICE = ([\d.]+)/)[1]) : 0.025;

const scaled = (action, n) =>
  app ? Math.ceil((BASE[action] + PER_VALIDATOR * n) * MARGIN) : UNCHECKED_LIMIT;
const GAS = { claim: app ? num(/claim: ([\d_]+)/) : UNCHECKED_LIMIT };

if (!app) {
  console.log(
    "No --app checkout given: measuring only.",
    "The limits the frontend declares are NOT being checked by this run.",
  );
}

const wallet = new Wallet(
  "push certain add next grape invite tobacco bubble text romance again lava crater pill genius vital fresh guard great patch knee series era tonight",
);
const client = new SecretNetworkClient({
  chainId: "secretdev-1",
  url: "http://localhost:1317",
  wallet,
  walletAddress: wallet.address,
});

const core = { contract_address: d.core.address, code_hash: d.core.codeHash };
const token = { contract_address: d.token.address, code_hash: d.token.codeHash };
const toBase64 = (s) => Buffer.from(s, "utf8").toString("base64");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const exec = (target, msg, gasLimit, funds = []) =>
  client.tx.compute.executeContract(
    { sender: wallet.address, ...target, msg, sent_funds: funds },
    { gasLimit, gasPriceInFeeDenom: PRICE },
  );

let failed = false;
function report(label, tx, gasLimit) {
  const ok = tx.code === 0;
  if (!ok) failed = true;
  const headroom = gasLimit / tx.gasUsed;
  if (headroom < 1.8 && ok) failed = true;
  console.log(
    `${label.padEnd(22)} used ${String(tx.gasUsed).padStart(7)} / ${String(gasLimit).padStart(7)}` +
      `  ${headroom.toFixed(1)}x  ${((gasLimit * PRICE) / 1e6).toFixed(5)} SCRT` +
      `  ${ok ? (headroom < 1.8 ? "TOO TIGHT" : "ok") : "FAILED " + tx.rawLog.slice(0, 70)}`,
  );
}

const n = d.validators.length;
const depositGas = scaled("deposit", n);
const unbondGas = scaled("unbond", n);

console.log(`validators: ${n}   price: ${PRICE} uscrt`);
console.log(
  `at the contract's twenty-validator ceiling these would be ` +
    `${scaled("deposit", 20)} / ${scaled("unbond", 20)}\n`,
);

report(
  "deposit",
  await exec(core, { deposit: {} }, depositGas, [{ denom: "uscrt", amount: "10000000" }]),
  depositGas,
);

const send = (amount) => ({
  send: {
    recipient: d.core.address,
    recipient_code_hash: d.core.codeHash,
    amount,
    msg: toBase64(JSON.stringify({ unbond: {} })),
  },
});
report("unbond", await exec(token, send("3000000"), unbondGas), unbondGas);
report("unbond again", await exec(token, send("1000000"), unbondGas), unbondGas);

// Keeper paths, at the limit the keeper would size for this set — when a checkout of it was
// supplied. Otherwise measured against a loose limit and reported without a verdict.
const kc = clientSource("keeper", "DSCRT_KEEPER", "src/client.ts");
if (!kc) {
  console.log(
    "No --keeper checkout given: the keeper's declared limits are NOT being checked.",
  );
}
const knum = (re) => Number(kc.match(re)[1].replace(/_/g, ""));
const KEEPER_GAS = kc
  ? Math.ceil(
      (knum(/COMPOUND_BASE_GAS = ([\d_]+)/) + knum(/PER_VALIDATOR_GAS = ([\d_]+)/) * n) *
        Number(kc.match(/GAS_MARGIN = ([\d.]+)/)[1]),
    )
  : UNCHECKED_LIMIT;
report("sync (keeper)", await exec(core, { sync: { limit: 25 } }, KEEPER_GAS), KEEPER_GAS);
report("compound (keeper)", await exec(core, { compound: { limit: 25 } }, KEEPER_GAS), KEEPER_GAS);

/*
 * The worst case a user can land in.
 *
 * A deposit or withdrawal closes an overdue window on its way past, which adds an
 * undelegation plan and a staking message per validator on top of the ordinary cost. It is
 * rare — one caller in however many — but it is the one that has to fit, and measuring
 * only the common path is how a limit ends up too tight for the transaction that matters.
 */
console.log("\nwaiting for the window to go overdue, to measure the expensive path…");
while (true) {
  const open = (
    await client.query.compute.queryContract({
      ...core,
      query: { windows: { state: "open", start_after: null, limit: 1 } },
    })
  ).windows.windows[0];
  if (Math.floor(Date.now() / 1000) >= open.closes_at) break;
  await sleep(10_000);
}

report(
  "deposit + closes window",
  await exec(core, { deposit: {} }, depositGas, [{ denom: "uscrt", amount: "5000000" }]),
  depositGas,
);

console.log("\ndriving a window to maturity for the claim path…");
for (let i = 0; i < 40; i++) {
  await sleep(15_000);
  if ((await exec(core, { advance_window: {} }, KEEPER_GAS)).code === 0) break;
}
let matured = false;
for (let i = 0; i < 40; i++) {
  await sleep(15_000);
  const col = await exec(core, { collect_matured: { limit: 25 } }, KEEPER_GAS);
  const st = await client.query.compute.queryContract({
    ...core,
    query: { windows: { state: "matured" } },
  });
  if (col.code === 0 && JSON.stringify(st).includes("matured")) {
    matured = true;
    break;
  }
}

if (matured) {
  report("claim", await exec(core, { claim_matured: { window_ids: null } }, GAS.claim), GAS.claim);
} else {
  failed = true;
  console.log("claim NOT measured — the window never matured");
}

console.log(failed ? "\nFAIL — a limit is too tight or a path failed" : "\nevery limit holds");
process.exit(failed ? 1 : 0);
