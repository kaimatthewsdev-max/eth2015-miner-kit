# 7. Browser and WebGPU notes

The eth2015.com mining page runs the same work in WebGPU. If you want to write a browser
or WGSL miner, the ideas from the CUDA kernel carry over.

## Cooperative reads in WGSL

WGSL has no portable subgroup shuffle, so the browser kernel shares each page through
**workgroup memory** instead: 6,400 bytes of it (well inside the 16 KiB default limit) and
one `workgroupBarrier()` per access, with the selected word double-buffered so a single
barrier separates each write from the previous read.

On a laptop in Firefox that took mining from **290 to 580 kH/s, about 2.0x**, the biggest
single improvement the browser miner had.

## Tips

- **Compile once, early.** Firefox takes about 1.2 to 1.5 seconds per compute pipeline.
  Compile during setup and time it separately from mining, so benchmarks measure work.
- **Cache the dataset.** Store generated chunks in OPFS or IndexedDB and reuse them
  across visits; a rebuild costs about 70 seconds on a desktop GPU. Storage is per browser,
  so stick to one browser.
- **Batch around 200 ms.** Browsers add their own per-dispatch completion cost; a 200 ms
  target leaves plenty of room above it (see [docs/04](04-work-size.md)).
- **Keep the tab visible.** Browsers throttle background tabs; pause when hidden and resume
  when visible. A native miner has no such limit, which is one more reason to go native.
- **Check for a hardware adapter.** Report `isFallbackAdapter` so users know when WebGPU is
  running in software and should enable hardware acceleration.

## Dataset generation on the GPU

The browser builds the dataset with a WebGPU kernel: four vector cache loads per parent
and fixed mix indices, 1.53x faster than the first version. Chunks are verified against
published hashes before use, and the upper Merkle levels are downloaded as a 512 KiB
per-epoch "frontier" instead of being built locally.
