# 7. Browser and WebGPU notes

The eth2015.com mining page runs the same work in WebGPU. If you want to write a
browser or WGSL miner, or are wondering why native is worth it, this is what we found.

## The cooperative trick carries over, partly

WGSL has no portable subgroup shuffle, so the browser kernel shares each page through
**workgroup memory** instead: 6,400 bytes of it (well inside the 16 KiB default limit) and
one `workgroupBarrier()` per access, with the selected word double-buffered so a single
barrier separates each write from the previous read.

On a laptop in Firefox that took mining from **290 to 580 kH/s, about 2.0x**. CUDA got
2.98x from the same idea; barriers cost more than warp shuffles. Still the biggest single
improvement the browser miner had.

## Other findings

- **Unrolling made WGSL slower too.** A fully unrolled kernel with no run-time
  private-array indexing was slower and was reverted. Same lesson as CUDA.
- **Pipeline compilation is slow in Firefox:** about 1.2 to 1.5 seconds per compute
  pipeline, around 4 seconds for the three a miner needs. Time it separately from real
  work or your benchmark lies.
- **Firefox hides the adapter.** Vendor, architecture and device come back as empty
  strings. That is privacy behaviour, not a failure; you cannot identify the GPU from it.
- **Same GPU, different OS, different speed.** On one RTX 5080, Firefox on Linux mined
  about 45 MH/s against about 100 MH/s on Windows, at 100% GPU load in both. Neither
  batching nor queue depth changed it; we did not find the cause.
- **Caches are per browser.** The generated dataset is cached in OPFS/IndexedDB, which is
  per browser: a dataset built in Chrome is cold in Firefox and costs a full rebuild
  (about 70 seconds on a desktop GPU).
- **A hidden tab stops.** Browsers throttle background tabs, so the page pauses when
  hidden and resumes when visible. A native miner has no such limit.
- **Software fallback exists.** Chrome can silently run WebGPU on the CPU (SwiftShader).
  Useful for tests, useless for mining; check `isFallbackAdapter` and tell the user.

## Dataset generation on the GPU

Generating the dataset in the browser moved from scalar cache reads with dynamic indexing
to four vector cache loads per parent with fixed indices: **1.53x** faster on a software
adapter for one 8 MiB chunk. Chunks are verified against published hashes before use, and
the upper Merkle levels are downloaded as a 512 KiB per-epoch "frontier" instead of being
built locally.
