# dscrt-contracts

The contracts behind [dSCRT](https://github.com/Nieuport-Labs), liquid staking for SCRT on
Secret Network, plus the scripts that build, deploy and upgrade them.

Deposit SCRT, receive a non-rebasing derivative that appreciates against it. The point is
that SCRT has a 21-day unbonding period: staking it means losing access for three weeks, and
a liquid derivative gives that capital back.

## What is here

| Path | |
|---|---|
| `contracts/lst-core/` | The protocol. Deposits, the withdrawal queue, the exchange rate, fees |
| `contracts/lst-token/` | The dSCRT SNIP-20 — a **submodule** of `scrtlabs/snip20-reference-impl` at `snip-25` |
| `packages/lst-types/` | Message and response types shared by the contracts |
| `scripts/` | Build, deploy, upgrade, devnet, and the governance probes |
| `tests/e2e/` | Against a real chain, for what a mock querier cannot reach |
| `devnet/` | LocalSecret genesis with 4 validators and a short unbonding period |
| `docs/` | Runbook, governance findings, governance proposals |

The frontend and the upkeep bot are separate:
[dscrt-app](https://github.com/Nieuport-Labs/dscrt-app) ·
[dscrt-keeper](https://github.com/Nieuport-Labs/dscrt-keeper).

Clone with the submodule:

```bash
git clone --recurse-submodules https://github.com/Nieuport-Labs/dscrt-contracts.git
```

## Build and test

```bash
npm run build       # wasm, inside the pinned optimizer image
npm run check       # fmt, clippy, unit tests
npm run devnet:up   # LocalSecret
npm run test:e2e    # the full deposit -> window -> unbond -> claim cycle
```

The wasm is **always** compiled inside `secret-contract-optimizer`, never with the host
toolchain: Rust ≥ 1.82 enables wasm proposals that Secret rejects, and pinning the image is
what makes an artifact hash reproducible from a tagged commit. That matters now that a
governance proposal names a hash people are asked to vote on.

## Upgrades belong to the network

Both contracts have had `set-contract-governance` called on them. The admin key remains, but
it is a **relay, not an authority**: it can submit the migration a passed proposal named, and
nothing else. Verified negatively — without a matching proposal the admin's own migration is
refused.

```bash
node scripts/upgrade.mjs --network pulsar-3 --dry-run   # uploads, prints the code id, stops
# then: pass MsgContractGovernanceProposal naming the contract and that code id
# then: the admin submits the migrate transaction
```

`upgrade.mjs` refuses to go further than the upload once governance is required, rather than
paying for a migration the chain will reject. When it can migrate, it snapshots the protocol
first and **refuses to call the upgrade a success** unless every figure that had to survive
did — because `MsgMigrateContract` returning `Ok` says nothing about whether the storage the
old code wrote is still readable by the new one.

The proposal approves *which code runs*, not what arguments it runs with — the admin supplies
the `MigrateMsg`. That is why `MigrateMsg` is empty, and why anything the network decides has
to ship inside the code it voted for.

## What the manager can do, and cannot

Immediately, without a vote: validator weights, the performance fee within its ceiling,
rebalancing, and pausing **deposits**. That is all of it.

There is no message that changes the manager, the treasury, the ceilings or the allowlist —
those were never in the contract. Claims and withdrawal requests are deliberately not
pausable, so the worst a rogue manager achieves is turning away new money.

## Status

Live on **pulsar-3**. No mainnet deployment, no external audit. Do not put real funds
anywhere near this yet.

## Gas

`scripts/gas-probe.mjs` measures the real cost against a devnet. The clients declare their own
limits and live in their own repositories, so point it at them if you want those checked too:

```bash
node scripts/gas-probe.mjs --app ../dscrt-app --keeper ../dscrt-keeper
```

Without those it measures and prints, and says plainly that it checked nothing — a scrape
that cannot find its target would otherwise validate whatever it last saw and report success.

## History

Extracted from `jirkacepelka/SteakSCRT`, which held all three components and is now archived.
This repository starts fresh; the original keeps the full history.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
