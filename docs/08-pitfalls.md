# 8. Pitfalls

Things that cost us, or others, real time.

## Encoding

- **Keccak, not SHA-3.** Padding byte `0x01`, not `0x06`, for both keccak256 and
  keccak512. Python's `hashlib.sha3_256` is the wrong function; use pycryptodome's
  `keccak` or an Ethereum library.
- **Endianness differs by field.** The nonce is little-endian in the seed, dataset words
  are little-endian, the Merkle leaf index is **big-endian**, and the final result is
  compared to the target as a big-endian number.
- **Large nonces in JavaScript.** Nonces go up to 2^64 - 1. A JavaScript `number` silently
  rounds above 2^53. Pass them as decimal strings or `BigInt`, everywhere, including JSON.
- **The challenge replaces the header hash, nothing else.** Everything after
  `keccak512(challenge || nonce)` is textbook Ethash. If an Ethash test vector passes with
  a header hash, your code will pass with a challenge.

## Merkle trees

- **Two conventions.** The DAG tree is positional (index in the leaf, left/right by
  position). The collection and card proofs are OpenZeppelin sorted pairs. Using one
  library for both fails.
- **Padding leaves are not constant.** They hash their own index, so they differ from
  each other and cannot be precomputed once per level.

## Kernel

- **Padded lanes must participate in shuffles** (see [docs/03](03-kernel.md)).
- **A found flag separate from the index**, because every uint64 is a valid index.
- **Self-check against an independent implementation on every start**, including nonces
  around 2^32 and 2^64 - 1. A kernel that is fast and wrong looks exactly like bad luck.
- **Count unique nonces for MH/s**, not threads.

## Mining

- **Pick the recipient before mining a mint.** It is inside the challenge.
- **A found mint is not a reservation.** Someone else's mint can land first; that work
  cannot be reused as a level-up.
- **Work is tied to a deployment.** The chain ID and NFT address are in the challenge,
  so work mined for one deployment is worthless on any other. Build jobs with `job.mjs`,
  which reads the live deployment from the site.
- **The dataset must match the card's epoch.** A wrong epoch produces valid-looking
  hashes that the contract rejects. `search.py` compares `dagRoot` before it starts.
- **Save solutions before doing anything else with them.** `search.py` writes the JSON
  first. If sending fails (gas too high, RPC down) run `prepare.mjs` again later; a
  level-up solution stays valid indefinitely, a mint until someone else mints the card.

## Rentals

- **Measure a rented GPU with `--bench` first.** Real bandwidth can differ from the
  datasheet, and the bench is what predicts your hash rate.
- **Generate the dataset on the rented machine** rather than uploading 1.2 GB: with many
  cores it takes well under a minute, and the transfer is often the slower, billed part.
  Keep `tree.bin` locally if that is where you build proofs.
