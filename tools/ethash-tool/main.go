// SPDX-License-Identifier: MIT
// Ethash (not Etchash or ProgPoW), following Ethereum's execution specification.
package main

import (
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"golang.org/x/crypto/sha3"
	"hash"
	"math/big"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

func must(err error) {
	if err != nil {
		panic(err)
	}
}
func hsum(h hash.Hash, in []byte, out []byte) { h.Reset(); _, _ = h.Write(in); h.Sum(out[:0]) }
func k256(in []byte) []byte                   { h := sha3.NewLegacyKeccak256(); _, _ = h.Write(in); return h.Sum(nil) }
func hx(b []byte) string                      { return "0x" + hex.EncodeToString(b) }
func unhex(s string) []byte                   { b, e := hex.DecodeString(strings.TrimPrefix(s, "0x")); must(e); return b }
func prime(n uint64) bool {
	if n < 2 {
		return false
	}
	for d := uint64(2); d*d <= n; d++ {
		if n%d == 0 {
			return false
		}
	}
	return true
}
func sizes(epoch int) (uint64, uint64) {
	c := uint64(1<<24) + uint64(epoch)*(1<<17) - 64
	for !prime(c / 64) {
		c -= 128
	}
	d := uint64(1<<30) + uint64(epoch)*(1<<23) - 128
	for !prime(d / 128) {
		d -= 256
	}
	return c, d
}
func seedFor(epoch int) []byte {
	s := make([]byte, 32)
	for i := 0; i < epoch; i++ {
		s = k256(s)
	}
	return s
}
func cacheFor(epoch int) []uint32 {
	size, _ := sizes(epoch)
	raw := make([]byte, size)
	h := sha3.NewLegacyKeccak512()
	hsum(h, seedFor(epoch), raw[:64])
	for i := uint64(64); i < size; i += 64 {
		hsum(h, raw[i-64:i], raw[i:i+64])
	}
	n := size / 64
	var buf [64]byte
	for r := 0; r < 3; r++ {
		for i := uint64(0); i < n; i++ {
			v := uint64(binary.LittleEndian.Uint32(raw[i*64:])) % n
			prev := (i + n - 1) % n
			for j := uint64(0); j < 64; j++ {
				buf[j] = raw[prev*64+j] ^ raw[v*64+j]
			}
			hsum(h, buf[:], raw[i*64:i*64+64])
		}
	}
	out := make([]uint32, size/4)
	for i := range out {
		out[i] = binary.LittleEndian.Uint32(raw[i*4:])
	}
	return out
}
func fnv(a, b uint32) uint32 { return a*0x01000193 ^ b }
func item(cache []uint32, index uint32, out []byte, h hash.Hash) {
	n := uint32(len(cache) / 16)
	var mix [16]uint32
	var buf [64]byte
	copy(mix[:], cache[(index%n)*16:])
	mix[0] ^= index
	for j, v := range mix {
		binary.LittleEndian.PutUint32(buf[j*4:], v)
	}
	hsum(h, buf[:], buf[:])
	for j := range mix {
		mix[j] = binary.LittleEndian.Uint32(buf[j*4:])
	}
	for j := uint32(0); j < 256; j++ {
		parent := fnv(index^j, mix[j%16]) % n
		row := cache[parent*16 : parent*16+16]
		for k := range mix {
			mix[k] = fnv(mix[k], row[k])
		}
	}
	for j, v := range mix {
		binary.LittleEndian.PutUint32(buf[j*4:], v)
	}
	hsum(h, buf[:], out)
}

type Trace struct {
	Challenge       string   `json:"challenge"`
	Nonce           string   `json:"nonce"`
	MixDigest       string   `json:"mixDigest"`
	Result          string   `json:"result"`
	Indices         []uint32 `json:"indices"`
	Pages           string   `json:"pages"`
	Siblings        []string `json:"siblings,omitempty"`
	Attempts        uint64   `json:"attempts,omitempty"`
	HashesPerSecond float64  `json:"hashesPerSecond,omitempty"`
}

func hashimoto(challenge []byte, nonce uint64, count uint32, fetch func(uint32, []byte), trace bool) Trace {
	var in [40]byte
	copy(in[:32], challenge)
	binary.LittleEndian.PutUint64(in[32:], nonce)
	var seed [64]byte
	hsum(sha3.NewLegacyKeccak512(), in[:], seed[:])
	var mix [32]uint32
	for j := range mix {
		mix[j] = binary.LittleEndian.Uint32(seed[(j%16)*4:])
	}
	seed0 := mix[0]
	indices := make([]uint32, 0, 64)
	pages := make([]byte, 0, 8192)
	var page [128]byte
	for i := uint32(0); i < 64; i++ {
		index := fnv(i^seed0, mix[i%32]) % count
		fetch(index, page[:])
		if trace {
			indices = append(indices, index)
			pages = append(pages, page[:]...)
		}
		for j := range mix {
			mix[j] = fnv(mix[j], binary.LittleEndian.Uint32(page[j*4:]))
		}
	}
	var digest [32]byte
	for i := 0; i < 8; i++ {
		binary.LittleEndian.PutUint32(digest[i*4:], fnv(fnv(fnv(mix[i*4], mix[i*4+1]), mix[i*4+2]), mix[i*4+3]))
	}
	return Trace{Challenge: hx(challenge), Nonce: fmt.Sprint(nonce), MixDigest: hx(digest[:]), Result: hx(k256(append(seed[:], digest[:]...))), Indices: indices, Pages: hx(pages)}
}

type Meta struct {
	Version      int    `json:"version"`
	Epoch        int    `json:"epoch"`
	PageCount    uint32 `json:"pageCount"`
	DatasetBytes uint64 `json:"datasetBytes"`
	Leaves       uint64 `json:"leaves"`
	DagRoot      string `json:"dagRoot"`
	Seed         string `json:"seed"`
}

func mapFile(path string, size int, create bool) ([]byte, func()) {
	flags := os.O_RDONLY
	prot := syscall.PROT_READ
	if create {
		flags = os.O_CREATE | os.O_EXCL | os.O_RDWR
		prot |= syscall.PROT_WRITE
	}
	f, e := os.OpenFile(path, flags, 0644)
	must(e)
	if create {
		must(f.Truncate(int64(size)))
	} else {
		st, e := f.Stat()
		must(e)
		if st.Size() != int64(size) {
			panic("incorrect file size: " + path)
		}
	}
	b, e := syscall.Mmap(int(f.Fd()), 0, size, prot, syscall.MAP_SHARED)
	must(e)
	return b, func() {
		must(syscall.Munmap(b))
		if create {
			must(f.Sync())
		}
		must(f.Close())
	}
}
func parallel(n uint64, workers int, name string, fn func(uint64, uint64)) {
	var next, done atomic.Uint64
	var wg sync.WaitGroup
	start := time.Now()
	stop := make(chan struct{})
	go func() {
		t := time.NewTicker(15 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-t.C:
				fmt.Fprintf(os.Stderr, "%s %.1f%% (%s)\n", name, 100*float64(done.Load())/float64(n), time.Since(start).Round(time.Second))
			case <-stop:
				return
			}
		}
	}()
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				s := next.Add(1024) - 1024
				if s >= n {
					return
				}
				end := s + 1024
				if end > n {
					end = n
				}
				fn(s, end)
				done.Add(end - s)
			}
		}()
	}
	wg.Wait()
	close(stop)
	if n > 100000 {
		fmt.Fprintf(os.Stderr, "%s done (%s)\n", name, time.Since(start).Round(time.Millisecond))
	}
}
func generate(epoch int, dir string, workers int) {
	if _, e := os.Stat(filepath.Join(dir, "manifest.json")); e == nil {
		panic("manifest already exists; refusing to overwrite")
	}
	must(os.MkdirAll(dir, 0755))
	start := time.Now()
	cache := cacheFor(epoch)
	_, size := sizes(epoch)
	count := size / 128
	fmt.Fprintf(os.Stderr, "epoch %d cache ready; %d pages, %d dataset bytes\n", epoch, count, size)
	dag, closeDag := mapFile(filepath.Join(dir, "dag.bin.tmp"), int(size), true)
	parallel(count, workers, "DAG", func(s, e uint64) {
		h := sha3.NewLegacyKeccak512()
		for i := s; i < e; i++ {
			item(cache, uint32(i*2), dag[i*128:i*128+64], h)
			item(cache, uint32(i*2+1), dag[i*128+64:i*128+128], h)
		}
	})
	leaves := uint64(1)
	for leaves < count {
		leaves *= 2
	}
	tree, closeTree := mapFile(filepath.Join(dir, "tree.bin.tmp"), int(leaves*2*32), true)
	parallel(leaves, workers, "Merkle leaves", func(s, e uint64) {
		h := sha3.NewLegacyKeccak256()
		var b [133]byte
		for i := s; i < e; i++ {
			binary.BigEndian.PutUint32(b[1:5], uint32(i))
			if i < count {
				b[0] = 0
				copy(b[5:], dag[i*128:i*128+128])
				hsum(h, b[:], tree[(leaves+i)*32:(leaves+i+1)*32])
			} else {
				b[0] = 2
				hsum(h, b[:5], tree[(leaves+i)*32:(leaves+i+1)*32])
			}
		}
	})
	for start := leaves / 2; start > 0; start /= 2 {
		base := start
		parallel(base, workers, "Merkle level", func(s, e uint64) {
			h := sha3.NewLegacyKeccak256()
			var b [65]byte
			b[0] = 1
			for j := s; j < e; j++ {
				i := base + j
				copy(b[1:], tree[i*64:i*64+64])
				hsum(h, b[:], tree[i*32:i*32+32])
			}
		})
	}
	meta := Meta{1, epoch, uint32(count), size, leaves, hx(tree[32:64]), hx(seedFor(epoch))}
	closeTree()
	closeDag()
	must(os.Rename(filepath.Join(dir, "dag.bin.tmp"), filepath.Join(dir, "dag.bin")))
	must(os.Rename(filepath.Join(dir, "tree.bin.tmp"), filepath.Join(dir, "tree.bin")))
	writeJSON(filepath.Join(dir, "manifest.json"), meta)
	fmt.Fprintf(os.Stderr, "epoch %d complete in %s; root %s\n", epoch, time.Since(start).Round(time.Second), meta.DagRoot)
}
func writeJSON(path string, v any) {
	b, e := json.MarshalIndent(v, "", "  ")
	must(e)
	if path == "-" {
		fmt.Println(string(b))
	} else {
		must(os.WriteFile(path, append(b, '\n'), 0644))
	}
}
func main() {
	mode := flag.String("mode", "", "generate, cache, mine, witness, or light")
	epoch := flag.Int("epoch", 1, "Ethash epoch (0..25)")
	dir := flag.String("dir", "data/dag/1", "dataset directory")
	workers := flag.Int("workers", min(runtime.NumCPU(), 4), "generation workers")
	challengeHex := flag.String("challenge", "", "32-byte challenge, hex")
	nonce := flag.Uint64("nonce", 0, "nonce or mining start nonce, decimal")
	difficulty := flag.String("difficulty", "1", "required difficulty, decimal")
	attempts := flag.Uint64("attempts", 1000000, "maximum mining attempts")
	output := flag.String("out", "-", "output file (binary for cache mode, JSON otherwise)")
	flag.Parse()
	if *epoch < 0 || *epoch > 25 || *workers < 1 {
		panic("invalid epoch or workers")
	}
	if *mode == "cache" {
		if *output == "-" { panic("cache mode requires -out FILE") }
		cache := cacheFor(*epoch)
		raw := make([]byte, len(cache)*4)
		for i, word := range cache { binary.LittleEndian.PutUint32(raw[i*4:], word) }
		file, err := os.CreateTemp(filepath.Dir(*output), ".ethash-cache-*")
		must(err)
		defer os.Remove(file.Name())
		_, err = file.Write(raw)
		must(err)
		must(file.Close())
		must(os.Rename(file.Name(), *output))
		return
	}
	if *mode == "generate" {
		generate(*epoch, *dir, *workers)
		return
	}
	if *mode != "mine" && *mode != "witness" && *mode != "light" {
		panic("choose -mode generate|mine|witness|light")
	}
	challenge := unhex(*challengeHex)
	if len(challenge) != 32 {
		panic("challenge must be 32 bytes")
	}
	if *mode == "light" {
		cache := cacheFor(*epoch)
		_, size := sizes(*epoch)
		h := sha3.NewLegacyKeccak512()
		fetch := func(i uint32, b []byte) { item(cache, i*2, b[:64], h); item(cache, i*2+1, b[64:], h) }
		writeJSON(*output, hashimoto(challenge, *nonce, uint32(size/128), fetch, true))
		return
	}
	var meta Meta
	b, e := os.ReadFile(filepath.Join(*dir, "manifest.json"))
	must(e)
	must(json.Unmarshal(b, &meta))
	if meta.Version != 1 || meta.Epoch < 0 || meta.Epoch > 25 {
		panic("invalid manifest version or epoch")
	}
	_, canonicalSize := sizes(meta.Epoch)
	if meta.DatasetBytes != canonicalSize || uint64(meta.PageCount)*128 != canonicalSize {
		panic("invalid manifest")
	}
	wantLeaves := uint64(1)
	for wantLeaves < uint64(meta.PageCount) {
		wantLeaves *= 2
	}
	if meta.Leaves != wantLeaves {
		panic("invalid tree size")
	}
	dag, closeDag := mapFile(filepath.Join(*dir, "dag.bin"), int(meta.DatasetBytes), false)
	defer closeDag()
	tree, closeTree := mapFile(filepath.Join(*dir, "tree.bin"), int(meta.Leaves*2*32), false)
	defer closeTree()
	if hx(tree[32:64]) != meta.DagRoot {
		panic("manifest root differs from tree")
	}
	fetch := func(i uint32, b []byte) { copy(b, dag[uint64(i)*128:uint64(i)*128+128]) }
	chosen := *nonce
	tries := uint64(0)
	start := time.Now()
	if *mode == "mine" {
		d, ok := new(big.Int).SetString(*difficulty, 10)
		if !ok || d.Sign() <= 0 || d.BitLen() > 256 {
			panic("invalid difficulty")
		}
		target := new(big.Int).Div(new(big.Int).Lsh(big.NewInt(1), 256), d)
		found := false
		for ; tries < *attempts; tries++ {
			r := hashimoto(challenge, chosen, meta.PageCount, fetch, false)
			if new(big.Int).SetBytes(unhex(r.Result)).Cmp(target) <= 0 {
				found = true
				tries++
				break
			}
			if chosen == ^uint64(0) {
				panic(fmt.Sprintf("nonce space exhausted after %d attempts", tries+1))
			}
			chosen++
		}
		if !found {
			panic(fmt.Sprintf("no solution in %d attempts; next nonce %d", tries, chosen))
		}
	}
	r := hashimoto(challenge, chosen, meta.PageCount, fetch, true)
	r.Attempts = tries
	r.HashesPerSecond = float64(tries) / time.Since(start).Seconds()
	for _, idx := range r.Indices {
		for pos := meta.Leaves + uint64(idx); pos > 1; pos /= 2 {
			sib := pos ^ 1
			r.Siblings = append(r.Siblings, hx(tree[sib*32:sib*32+32]))
		}
	}
	writeJSON(*output, r)
}
