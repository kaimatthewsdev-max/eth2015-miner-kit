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

## Tuning that pays off

- **Keep four hashes in flight.** One in flight already gets most of the gain (223.7 MH/s);
  two and four add the rest. Four was the best setting on every card we measured, so it
  is the default.
- **64 threads per block.** Once the layout is right, block size is a fine adjustment;
  64 was best on an A100 (171.1 MH/s) and ties for best on the 5090.
- **Spend your effort on memory layout, not arithmetic.** The Keccaks are a small share of
  the time. On the 5090, 225 MH/s x 8 KiB per hash = 1.85 TB/s of logical reads, right at
  the card's 1.79 TB/s peak (caches serve part of it). The cooperative kernel is at the
  bandwidth wall, so the next gains come from faster memory, not a cleverer loop.
- **Measure on your own card** with `search.py --bench 30`, and compare against
  `--kernel scalar` to see the layout effect for yourself.

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
