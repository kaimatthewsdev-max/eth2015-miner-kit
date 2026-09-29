# ETH2015 miner kit

Everything you need to build your own [ETH2015](https://eth2015.com/777777) miner, plus
what we learned building ours, so you can start at 225 MH/s on an RTX 5090 instead of the
30 to 75 MH/s our first versions managed.

ETH2015 turns the 6,187 contracts deployed on Ethereum in 2015 into NFTs. You cannot buy
a card: you earn it by redoing the Ethash proof of work of the block its contract was
deployed in, and the NFT contract checks that work on-chain. The browser miner on
eth2015.com works (a laptop manages about 0.6 MH/s), but a desktop GPU running native
code is where cards get mined in hours instead of months.

This kit gives you a working reference for each step. Use it as is, or read the lessons
and write your own.

| Step | What | Here |
| --- | --- | --- |
| 1 | Pick a card and get its challenge and difficulty | [`tools/job.mjs`](tools/job.mjs) |
| 2 | Build the Ethash dataset for the card's epoch (about 1.1 to 1.3 GB) | [`tools/ethash-tool`](tools/ethash-tool) (Go) |
| 3 | Search nonces on the GPU | [`cuda/ethash.cu`](cuda/ethash.cu) + [`miner/search.py`](miner/search.py) |
| 4 | Build the proof, simulate, send from your own wallet | [`tools/prepare.mjs`](tools/prepare.mjs) |

## The lessons (the head start)

1. **[How the work works](docs/01-the-work.md)**: standard Ethash Hashimoto with a
   per-card challenge in place of the block header. Existing Ethash kernels adapt easily.
2. **[Datasets and epochs](docs/02-dataset.md)**: 25 epochs, one dataset each, built once
   from a 16 MB cache. Which cards share a dataset, and how to check yours is right.
3. **[The kernel: 75 to 225 MH/s](docs/03-kernel.md)**: eight threads cooperating on each
   128-byte DAG page tripled throughput on the same GPU. Block size and unrolling did nothing.
4. **[Work size](docs/04-work-size.md)**: adaptive launches aimed at 500 ms. Fixed small
   batches left most of the GPU idle.
5. **[Hardware and rates](docs/05-hardware.md)**: measured MH/s for eight GPUs, and the
   bandwidth rule that predicts the rest.
6. **[Proof and submission](docs/06-proof-and-submit.md)**: the positional Merkle
   multiproof, gas, and the mint race.
7. **[Browser and WebGPU notes](docs/07-browser-webgpu.md)**: what carried over from CUDA
   to WGSL, and what did not.
8. **[Pitfalls](docs/08-pitfalls.md)**: the mistakes that cost us time.

The complete specification of the work and the transaction is published by the project at
[eth2015.com/llm.txt](https://eth2015.com/llm.txt). If this kit and that file ever
disagree, that file and the contract win.

## Quick start (Ubuntu, NVIDIA)

Needs an NVIDIA driver with CUDA 12 or 13, Python 3.10+, Node.js 20+ and Go 1.24+.

```bash
git clone https://github.com/kaimatthewsdev-max/eth2015-miner-kit && cd eth2015-miner-kit
npm ci
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt                 # cupy-cuda12x; swap for cupy-cuda13x on CUDA 13
(cd tools/ethash-tool && go build -o ethash-tool . && go test ./...)

# 1. a job: the card goes to --recipient, fixed into the work itself
node tools/job.mjs 42 --recipient 0xYourAddress

# 2. the dataset for the card's epoch (job.mjs prints the exact line)
tools/ethash-tool/ethash-tool -mode generate -epoch 1 -dir data/1 -workers $(nproc)

# 3. measure, then mine
python3 miner/search.py --dag data/1 --bench 30
python3 miner/search.py --job jobs/42-mint.json

# 4. proof, simulation, then send with your own wallet
node tools/prepare.mjs solutions/42-mint-<nonce>.json --from 0xYourSender
cast send <nft> --data "$(cat tx/42-mint-<nonce>.hex)" --gas-limit <limit> --rpc-url <rpc> --ledger
```

**Try it without a GPU first.** While ETH2015 runs its test deployment on Sepolia, the
required difficulty there is tiny, so `python3 miner/search.py --job jobs/42-mint.json --cpu`
finds a solution in seconds and you can walk the whole pipeline, up to a simulated
transaction, before touching CUDA. `job.mjs` prints the real 2015 difficulty alongside.

Nothing in this kit asks for a private key. `prepare.mjs` only simulates; you sign and
send with whatever wallet you already use (`cast send --ledger`, `--trezor`, `--account`).

## What is tested

- `tools/ethash-tool`: `go test` checks two independent Ethash vectors (from
  [chfast/ethash](https://github.com/chfast/ethash)) and the canonical sizes of all epochs.
- `miner/search.py`'s CPU reference matches `ethash-tool` byte for byte at nonces 0,
  2^32 and 2^64-1 on the epoch 1 dataset.
- The full CPU path (job, search, witness, multiproof, calldata, simulation) passes
  against the Sepolia deployment for a mint (card 1, 1.83M gas) and a level-up (card 3432,
  epoch 16, 1.76M gas).
- `cuda/ethash.cu` is the kernel behind every GPU rate in [docs/05](docs/05-hardware.md).
  `search.py` self-checks it against the CPU on every start, before it mines anything.

## Layout

```
cuda/ethash.cu          cooperative search kernel (default), scalar kernel, single-hash check kernel
miner/search.py         CuPy driver: one process per GPU, adaptive batches, self-checks, --bench, --cpu
tools/ethash-tool/      Go: dataset + Merkle tree generation, CPU mining, witnesses (MIT)
tools/job.mjs           card number to challenge + difficulty, checked against the contract
tools/prepare.mjs       nonce to verified witness, multiproof, calldata, simulated transaction
tools/lib.mjs           shared encoding, proofs and witness replay
docs/                   the lessons
```

`data/`, `jobs/`, `solutions/`, `tx/` and `cache/` are created as you go and are not
tracked.

## License

MIT, see [LICENSE](LICENSE). The two Ethash test vectors in
`tools/ethash-tool/main_test.go` come from chfast/ethash (Apache 2.0), see
[`tools/ethash-tool/third_party`](tools/ethash-tool/third_party).
