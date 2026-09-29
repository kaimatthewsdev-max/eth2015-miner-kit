# 1. How the work works

Short version: **it is Ethash.** The same Hashimoto loop Ethereum miners ran from 2015 to
2022, over the same datasets, with one change: the 32-byte header hash is replaced by a
per-card challenge. If you have written or tuned an Ethash kernel before, you already know
90% of this.

The authoritative specification is [eth2015.com/llm.txt](https://eth2015.com/llm.txt),
Part 2. This page is the mental model.

## The job

For each card you need three things:

| Input | Where it comes from |
| --- | --- |
| `challenge` | `challengeFor(action, tokenId, recipient)` on the NFT contract, which you should also derive yourself (below) |
| `difficulty` | `requiredDifficulty(record.difficulty)`: the difficulty of the card's original 2015 block |
| `epoch` | `record.epoch` = deployment block / 30,000. Selects the dataset. |

```
DOMAIN    = keccak256("ETH2015_ACTION_WORK_V3")
challenge = keccak256(abi.encode(DOMAIN, chainId, nftAddress, collectionRoot,
                                 tokenId, boundRecipient, action))
action    = 0 mint, 1 level-up;  boundRecipient = recipient for a mint, address(0) for a level-up
```

Two consequences shape how you mine:

- **A mint solution is bound to its recipient.** Pick the address before you start. Nobody
  can steal your solution from the mempool and redirect the card, but you also cannot
  change your mind after finding it. Any address may *send* it and pay the gas.
- **A level-up challenge never changes.** It does not depend on who owns the card or its
  level. Every distinct solution adds one level, forever, so level-up mining is not a race
  and a found solution never expires. It is the natural thing to point spare hash rate at.

`tools/job.mjs` does all of this, checks the contract agrees with the derived challenge, and
writes a job file.

## The search

```
seed   = keccak512(challenge || uint64_le(nonce))          64 bytes
mix    = seed words repeated to 32 x uint32                 128 bytes
repeat 64 times:
    page  = fnv(i ^ seed[0], mix[i % 32]) % pageCount      pick one 128-byte page
    mix   = fnv(mix, dataset[page])                         word by word
digest = mix folded 4:1 with fnv                            32 bytes
result = keccak256(seed || digest)
accept if result <= 2^256 / difficulty
```

Each hash does two Keccaks (cheap) and **64 dependent random reads of 128 bytes** from a
1.1 to 1.3 GB dataset (expensive). Each read's address depends on the previous one, so a
single hash cannot be sped up; you win by keeping many hashes' reads in flight at once and
by making each read a clean 128-byte memory transaction. That is the whole game, and the
subject of [docs/03](03-kernel.md).

## How long

Average hashes needed = difficulty. Card difficulties run from 1.46 trillion (early
August 2015) to 9.44 trillion; the median card is about 7.3 trillion.

```
hours = difficulty / hashes_per_second / 3600
```

At 225 MH/s (an RTX 5090 with this kit) that is 1.8 hours for the easiest card and about
9 hours for a median one. Mining is memoryless: every nonce has the same chance, nothing
accumulates, and stopping loses nothing. A solution can arrive in minutes or take several
times the average.
