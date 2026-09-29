# 3. The kernel: 75 to 225 MH/s on the same GPU

The single biggest lesson. On one RTX 5090, same host, same dataset (epoch 1), 90-second
runs after warm-up:

| Kernel | MH/s |
| --- | ---: |
| Scalar: one thread computes one whole hash | 75.66 |
| **Cooperative: eight threads share each page read, four hashes in flight** | **225.52** |

**2.98 times faster**, with identical results. Nothing about the algorithm changed: same 64
accesses per hash, same page selection, same amount of work per nonce. Only the memory
access layout changed. Both kernels are in [`cuda/ethash.cu`](../cuda/ethash.cu), and
`search.py --kernel scalar` lets you reproduce the comparison on your own card.

## Why the scalar kernel is slow

A warp is 32 threads that issue loads together. In the scalar kernel each thread owns one
nonce, so a load instruction asks for 32 *different* random pages, and each thread then
walks its own 128-byte page 4 bytes at a time. Memory is fetched in 32-byte sectors and
128-byte lines; scattered narrow reads waste most of every transaction and the load
units drown in requests.

## The cooperative layout

Borrowed from [ethminer's CUDA kernel](https://github.com/ethereum-mining/ethminer/blob/master/libethash-cuda/dagger_shuffled.cuh),
adapted to this project's Keccak and Hashimoto:

- Threads work in **groups of eight lanes**. Each lane still owns one nonce and does its
  own two Keccaks (they are cheap and independent).
- For the 64 DAG accesses, the group processes its eight owners' hashes together. For each
  access, the owner's page index is **broadcast** with `__shfl_sync`, and each of the eight
  lanes loads **one 16-byte slice (a `uint4`, one eighth)** of that same 128-byte page.
  Eight lanes x 16 bytes = one perfectly coalesced 128-byte read.
- Each lane keeps only its 4 words of the 32-word mix, so register use stays low.
- At the end the eight partial mixes are folded and shuffled back to the owning lane,
  which finishes its own final Keccak.
- **Four hashes in flight**: the group interleaves four owners' access chains so there are
  independent loads to issue while earlier ones are outstanding. The 64 reads of one hash
  are strictly dependent; parallelism has to come from other hashes.

```
for owner_base in (0, 4):                  # 8 owners, 4 at a time
    for access in 0..63:
        for p in 0..3:                     # 4 independent hashes in flight
            page = shfl(owner p's selection word) ...
            v    = dag_as_uint4[page * 8 + lane]      # lane's 16 bytes of the page
            part[p][0..3] = fnv(part[p][0..3], v)
```

## What we tried that did not help

Same host, 12-second trials (MH/s):

| Variant | Threads/block | MH/s |
| --- | ---: | ---: |
| Scalar | 64 / 128 / 256 | 75.59 / 75.67 / 75.03 |
| Scalar, unroll 32 accesses | 128 | 75.03 |
| Scalar, unroll all 64 accesses | 128 | **69.59** (slower) |
| Cooperative, 1 hash in flight | 128 | 223.74 |
| Cooperative, 2 hashes in flight | 128 | 225.25 |
| Cooperative, 4 hashes in flight | 64 / 128 / 256 | 225.51 / 225.51 / 225.47 |

- **Block size barely matters** once the layout is right. On an A100 64 threads was
  slightly best (171.1 vs 169.6 at 128 and 163.3 at 256), so the default is 64.
- **Unrolling is not the fix.** It reduced local-memory allocation but not the real
  problem, and fully unrolled was slower. (The browser miner found the same in WGSL.)
- **More hashes in flight is not always better.** On an A100, eight in flight fell to
  143 to 144 MH/s against 170 for four: register pressure (106 registers per thread at
  four) starts costing occupancy. Four is the sweet spot on every card we measured.
- On the 5090, 225 MH/s x 8 KiB per hash = 1.85 TB/s of logical reads, above the card's
  1.79 TB/s peak. The cooperative kernel is at the bandwidth wall; caches serve part of
  it. We did not collect profiler counters, so treat that as a plausibility check.

## Correctness traps in the cooperative kernel

- **Padded lanes must still run.** When the batch size is not a multiple of eight, the
  extra lanes have no real nonce, but they must still take part in every `__shfl_sync`,
  or the group deadlocks or reads garbage. The kernel gives them a dummy nonce and only
  suppresses their result at the end.
- **Keep "found" separate from the index.** `2^64 - 1` is a valid nonce offset when a range
  covers the whole nonce space, so it cannot double as "nothing found". The kernel sets a
  flag with `atomicCAS` and writes the index separately.
- **Verify on start.** `search.py` compares single GPU hashes to an independent CPU
  implementation (nonces 0, 1, 2^32-1, 2^32, 2^64-1 and the start nonce), then runs the
  search kernel over 200 nonces (a partial block) and requires it to find exactly the
  best one, and nothing for an all-zero target. It takes a second and catches a wrong
  dataset, a wrong epoch or a broken kernel before hours are wasted.
- **Count unique nonces**, not lanes, when you report MH/s. Eight lanes per hash would
  otherwise inflate the number eightfold.
