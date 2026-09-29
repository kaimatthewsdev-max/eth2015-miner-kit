# 5. Hardware and rates

All rates below are the cooperative kernel in `cuda/ethash.cu` (four hashes in flight, 64
threads per block, adaptive 500 ms launches), epoch 1 dataset, 90-second measurements after
warm-up, on rented Vast.ai machines in September 2026. Prices are what those offers cost
at the time and move daily.

| GPU | MH/s | Memory bandwidth (GB/s, as measured by Vast) | MH/s per GB/s | Offer $/h | MH/s per $/h |
| --- | ---: | ---: | ---: | ---: | ---: |
| H200 | 419.05 | 4,067 | 0.103 | 2.37 | 177 |
| RTX 5090 | 225.52 | 1,458 | 0.155 | 0.40 to 0.80 | 280 to 560 |
| A100 SXM4 40GB | 171.07 | 1,314 | 0.130 | 0.39 | 443 |
| RTX 3090 Ti | 113.82 | 861 | 0.132 | 0.47 | 240 |
| RTX 3080 Ti | 96.73 | not recorded | | 0.15 | 655 |
| Tesla V100 PCIe 32GB | 81.23 | 744 | 0.109 | 0.155 | 524 |

For scale, a laptop GPU in Firefox on eth2015.com did 0.29 MH/s with the browser's scalar
kernel and 0.58 MH/s with its cooperative one.

## The bandwidth rule

Ethash is memory-bound: each hash reads 64 x 128 bytes = **8 KiB** of dataset. So

```
MH/s  ~=  memory bandwidth (GB/s)  x  0.10 to 0.155
```

Consumer GDDR cards convert best (0.13 to 0.155). HBM datacenter cards convert worse
(0.10 to 0.13): the H200 has 2.8x the 5090's bandwidth but only 1.9x its hash rate.
Use the rule to shortlist a card, then run `search.py --bench 30` on it before committing.

## Choosing hardware

- **Cheapest per hash wins** unless you are racing a specific card. Level-ups are never a
  race, and most mints are not contested in the first minutes. By MH/s per dollar the
  3080 Ti, V100 and a well-priced 5090 led our list; the H200 is fastest but poor value.
- **Memory size is not the constraint.** Every 2015 dataset is under 1.3 GB.
- **Benchmark a rental before committing to it.** Thirty seconds of `--bench` tells you
  what you are actually paying for.
- **Expected time per card** = difficulty / rate. With a fleet, rates add: two 5090s mine a
  median card in about 4.5 hours on average.
