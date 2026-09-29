# 2. Datasets and epochs

The dataset (the "DAG") is the canonical Ethash full dataset for the card's epoch, exactly
what Ethereum miners generated in 2015. The 2015 cards use **epochs 1 to 25**, so there
are only 25 datasets in total, and every card in an epoch shares one.

## Build it once per epoch

```bash
tools/ethash-tool/ethash-tool -mode generate -epoch 16 -dir data/16 -workers $(nproc)
```

This writes three files:

| File | Size | Used for |
| --- | --- | --- |
| `dag.bin` | 1.08 GB (epoch 1) to 1.28 GB (epoch 25) | mining: loaded into GPU memory |
| `tree.bin` | 1 GiB | the Merkle tree over the pages, only needed for the proof |
| `manifest.json` | tiny | epoch, `pageCount`, `dagRoot` |

The dataset is expanded from a 16 MB cache with the standard `calc_dataset_item` (256
parent lookups per 64-byte item), so it is CPU-bound and parallelises perfectly. On a
rented many-core GPU server epoch 1 took **33 seconds**, tree included; expect longer on a
desktop, in proportion to its cores. Do it once and keep the folder.

**Check it before you mine.** `manifest.json`'s `dagRoot` must equal the card's
`record.dagRoot`; `miner/search.py` refuses to start otherwise. The project also publishes
SHA-256 hashes of every 8 MiB chunk at `https://seed.eth2015.com/<epoch>/manifest`
(`chunkSHA256`), handy if you generate the dataset with your own code and need to find
where it goes wrong.

## Pick cards by epoch

Switching epochs means loading a different 1.1 to 1.3 GB dataset. Group your cards by
epoch and you generate and load each dataset once. Difficulty climbs with the epoch, so
the early epochs are also the cheap ones.

| Epoch | Cards | Dataset GB | Difficulty min / median / max (T) | Median hours at 225 MH/s |
| ---: | ---: | ---: | --- | ---: |
| 1 | 125 | 1.082 | 1.46 / 1.61 / 1.74 | 2.0 |
| 2 | 172 | 1.091 | 1.73 / 2.21 / 3.23 | 2.7 |
| 3 | 110 | 1.099 | 3.41 / 4.39 / 4.61 | 5.4 |
| 4 | 193 | 1.107 | 4.40 / 5.17 / 5.86 | 6.4 |
| 5 | 241 | 1.116 | 5.91 / 7.20 / 9.44 | 8.9 |
| 6 | 254 | 1.124 | 5.98 / 6.30 / 7.98 | 7.8 |
| 7 | 165 | 1.132 | 6.19 / 6.80 / 7.12 | 8.4 |
| 8 | 285 | 1.141 | 5.37 / 6.12 / 6.72 | 7.6 |
| 9 | 203 | 1.149 | 6.48 / 6.95 / 7.39 | 8.6 |
| 10 | 119 | 1.158 | 5.47 / 5.86 / 7.18 | 7.2 |
| 11 | 122 | 1.166 | 5.90 / 6.27 / 6.43 | 7.7 |
| 12 | 264 | 1.174 | 5.93 / 6.21 / 6.52 | 7.7 |
| 13 | 263 | 1.183 | 5.62 / 5.92 / 6.12 | 7.3 |
| 14 | 588 | 1.191 | 5.61 / 6.33 / 6.85 | 7.8 |
| 15 | 289 | 1.200 | 6.70 / 7.43 / 7.94 | 9.2 |
| 16 | 402 | 1.208 | 7.13 / 7.57 / 7.94 | 9.3 |
| 17 | 300 | 1.216 | 7.47 / 7.78 / 8.08 | 9.6 |
| 18 | 196 | 1.225 | 7.80 / 8.44 / 9.04 | 10.4 |
| 19 | 214 | 1.233 | 7.44 / 7.57 / 7.75 | 9.3 |
| 20 | 129 | 1.242 | 7.36 / 7.79 / 8.01 | 9.6 |
| 21 | 433 | 1.250 | 7.34 / 7.77 / 8.28 | 9.6 |
| 22 | 328 | 1.258 | 7.12 / 8.11 / 8.84 | 10.0 |
| 23 | 316 | 1.267 | 8.34 / 8.76 / 8.92 | 10.8 |
| 24 | 181 | 1.275 | 8.32 / 8.53 / 8.86 | 10.5 |
| 25 | 295 | 1.283 | 8.23 / 8.55 / 8.81 | 10.6 |

(From the public `collection.json`. Epoch = deployment block / 30,000.)

## Tricks that helped

- **Any GPU with 2 GB free fits every epoch.** The 2015 datasets are small by later Ethash
  standards (mainnet reached 5 GB+). Old or cheap cards are not ruled out by memory, only
  by bandwidth. A 24 GB card can keep several epochs resident if you switch often.
- **Memory-map, then copy once.** `search.py` maps `dag.bin` and copies it to the GPU in
  one transfer; the same mapping serves the CPU self-check. No need to read 1.2 GB into
  Python objects.
- **The tree is only for the proof.** Mining needs `dag.bin` alone. `tree.bin` is read
  once per solution to collect 64 branches. If disk is tight you can skip it and build the
  tree after you find a solution (llm.txt explains how), but building it at generation
  time is simpler and it is reused by every card in the epoch.
- **Page = two Ethash items.** Ethash's "mix" is 128 bytes, read as two consecutive
  64-byte dataset items. Here that pair is one "page", `pageCount = datasetBytes / 128`,
  and page `i` is items `2i` and `2i+1`. Keep that straight and the Merkle leaves, the
  kernel and the witness all agree.
- **Generation can also run on the GPU.** The browser miner builds the dataset with a
  WebGPU kernel (four vector cache loads per parent, fixed mix indices), and downloads the
  upper Merkle levels as a 512 KiB "frontier" per epoch instead of building them.
  For a native miner the Go tool on the CPU is fast enough that we never
  needed either.
