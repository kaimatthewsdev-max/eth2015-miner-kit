# ethash-tool

Ethash for ETH2015 in one Go file, standard library plus `golang.org/x/crypto`.

```bash
go build -o ethash-tool . && go test ./...

./ethash-tool -mode generate -epoch 1 -dir ../../data/1 -workers $(nproc)   # dag.bin, tree.bin, manifest.json
./ethash-tool -mode light   -epoch 1 -challenge 0x.. -nonce 7              # one hash from the cache only (slow, no dataset)
./ethash-tool -mode mine    -dir ../../data/1 -challenge 0x.. -difficulty 16 -nonce 0 -attempts 100000   # CPU search
./ethash-tool -mode witness -dir ../../data/1 -challenge 0x.. -nonce 7     # 64 pages + branches for the proof
./ethash-tool -mode cache   -epoch 1 -out cache.bin                        # the 16 MB Ethash cache
```

`generate` refuses to overwrite an existing `manifest.json` and writes through temporary
files, so an interrupted run never leaves a dataset that looks complete. `light` and
`witness` print JSON with `mixDigest`, `result`, the 64 page `indices` and the `pages`;
`witness` adds each page's 24 or so `siblings`.
