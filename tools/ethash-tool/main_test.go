// SPDX-License-Identifier: MIT
package main

import (
	"golang.org/x/crypto/sha3"
	"testing"
)

// Known-answer values from chfast/ethash test/unittests/test_cases.hpp
// (Copyright 2018 Pawel Bylica, Apache-2.0; see third_party/NOTICE.md).
func TestIndependentEthashVectors(t *testing.T) {
	cache := cacheFor(0)
	_, size := sizes(0)
	h := sha3.NewLegacyKeccak512()
	fetch := func(i uint32, b []byte) { item(cache, i*2, b[:64], h); item(cache, i*2+1, b[64:], h) }
	cases := []struct {
		header      string
		nonce       uint64
		mix, result string
	}{
		{"2a8de2adf89af77358250bf908bf04ba94a6e8c3ba87775564a41d269a05e4ce", 0x4242424242424242, "58f759ede17a706c93f13030328bcea40c1d1341fb26f2facd21ceb0dae57017", "dd47fd2d98db51078356852d7c4014e6a5d6c387c35f40e2875b74a256ed7906"},
		{"100cbec5e5ef82991290d0d93d758f19082e71f234cf479192a8b94df6da6bfe", 0x307692cf71b12f6d, "e55d02c555a7969361cf74a9ec6211d8c14e4517930a00442f171bdb1698d175", "ab9b13423cface72cbec8424221651bc2e384ef0f7a560e038fc68c8d8684829"},
	}
	for _, c := range cases {
		r := hashimoto(unhex(c.header), c.nonce, uint32(size/128), fetch, true)
		if r.MixDigest != "0x"+c.mix || r.Result != "0x"+c.result {
			t.Fatalf("independent vector mismatch: %+v", r)
		}
	}
}
func TestCanonicalSizes(t *testing.T) {
	c, d := sizes(0)
	if c != 16776896 || d != 1073739904 {
		t.Fatal(c, d)
	}
	for e := 0; e <= 25; e++ {
		c, d := sizes(e)
		if !prime(c/64) || !prime(d/128) {
			t.Fatal(e)
		}
	}
}
