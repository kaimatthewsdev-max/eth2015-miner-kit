# 6. Proof and submission

Finding the nonce is most of the work but not all of it. The contract does not have the
1.2 GB dataset, so you send the 64 pages your hash touched plus a Merkle proof that each
one really is that page of the dataset. The contract then re-runs Hashimoto itself.

`tools/prepare.mjs` does all of this. What it is doing, and what we learned:

## The witness

`ethash-tool -mode witness` reads `dag.bin` and `tree.bin` for the winning nonce and
returns the 64 pages (8,192 bytes, in access order) and each page's branch (24 sibling
hashes at epoch 1). `prepare.mjs` then replays Hashimoto from those pages alone and walks
every branch up to `dagRoot` before building anything, so a wrong dataset is caught on
your machine and not by a reverted transaction.

The tree is **positional**, not sorted:

```
leaf(i)  = keccak256(0x00 || uint32_be(i) || page_i)      real page
leaf(i)  = keccak256(0x02 || uint32_be(i))                padding, i >= pageCount
node     = keccak256(0x01 || left || right)               left/right by position
```

A sorted-pair Merkle library (like OpenZeppelin's) will not verify it. The collection and
card proofs, on the other hand, *are* sorted pairs. Two tree conventions in one
transaction; keep them apart.

## The multiproof

Sending 64 separate branches would be 64 x 24 = 1,536 hashes. Many branches share nodes
near the root, so the contract takes one positional multiproof instead: the pages sorted
by index (`order`, 64 bytes) and only the sibling hashes that cannot be computed from the
pages themselves (`dagProof`). In practice that is **about 1,030 to 1,050 hashes**, a third
less. The packing algorithm is in `tools/lib.mjs` (`packProof`) and llm.txt section 7.

## Gas

Measured by simulation against the Sepolia deployment with this kit:

| Action | Gas | Calldata |
| --- | ---: | ---: |
| Mint (card 1, epoch 1) | 1,825,682 | 42,660 bytes |
| Level-up (card 3432, epoch 16) | 1,755,848 | 42,948 bytes |

These transactions sit close to the EIP-7623 calldata floor (40 gas per nonzero calldata
byte), so the cost is mostly calldata, not computation. At 0.2 gwei a mint is about
0.00036 ETH. `prepare.mjs` suggests a gas limit 20% above the estimate.

## Sending

- **Simulate right before sending.** `prepare.mjs` runs `eth_call` and `eth_estimateGas`
  from the sender; a card minted by someone else, a used level-up nonce or a bad proof
  shows up as a named error (`AlreadyMinted`, `WorkAlreadyUsed`, `InvalidDagProof`...).
- **A mint is a race.** A solution does not reserve the card. If two mints for the same
  card are in flight, the later one reverts and still pays gas. Send as soon as you find
  one. While mining a mint, `search.py` checks every 10 minutes whether the card has been
  minted meanwhile and stops if so, rather than spending hours on work that can no longer
  be used.
- **A mint solution cannot become a level-up.** The challenge includes the action. If you
  lose the race, that work is spent.
- **Keep unused level-up solutions.** They stay valid through transfers and other
  level-ups. Only an exact repeat of an accepted nonce is refused.
- **Check the receipt.** State can change between simulation and inclusion. Success means
  the receipt contains a `WorkAccepted` event.
- **Public RPCs throttle bursts.** Sending dozens of transactions at once from one script
  got rate-limited on public Sepolia endpoints. Pace them and poll the account nonce rather
  than waiting on each receipt in parallel.

## Golden cards

Every mint, and every level-up of a card that is not golden, rolls a 1 in 100 chance from
the hash of the next block. Check `finish(tokenId)` a block or two later: `2` means it won
and needs claiming, which anyone may do:

```bash
cast call <nft> "finish(uint256)(uint8,uint256)" <token> --rpc-url <rpc>
cast send <nft> "claimGolden(uint256)" <token> --rpc-url <rpc> --ledger
```

An unclaimed win lapses after 8,191 blocks (about 27 hours). The card's next level-up also
claims it.
