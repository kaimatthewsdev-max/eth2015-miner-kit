// SPDX-License-Identifier: MIT
// ETH2015 Ethash kernels. ethash_search: eight lanes share each 128-byte DAG page, four
// hashes in flight (docs/03). ethash_search_scalar: one thread per hash, for comparison.
// ethash_one: a single hash, used by the start-up self-check.

typedef unsigned int uint32_t;
typedef unsigned long long uint64_t;

#define FNV_PRIME 0x01000193u

__device__ __constant__ uint64_t KECCAK_RC[24] = {
    0x0000000000000001ULL,0x0000000000008082ULL,0x800000000000808aULL,0x8000000080008000ULL,
    0x000000000000808bULL,0x0000000080000001ULL,0x8000000080008081ULL,0x8000000000008009ULL,
    0x000000000000008aULL,0x0000000000000088ULL,0x0000000080008009ULL,0x000000008000000aULL,
    0x000000008000808bULL,0x800000000000008bULL,0x8000000000008089ULL,0x8000000000008003ULL,
    0x8000000000008002ULL,0x8000000000000080ULL,0x000000000000800aULL,0x800000008000000aULL,
    0x8000000080008081ULL,0x8000000000008080ULL,0x0000000080000001ULL,0x8000000080008008ULL
};

__device__ __constant__ unsigned KECCAK_RHO[25] = {
    0,1,62,28,27,36,44,6,55,20,3,10,43,25,39,41,45,15,21,8,18,2,61,56,14
};

__device__ __forceinline__ uint64_t rotl64(uint64_t x, unsigned n) {
    return n ? ((x << n) | (x >> (64 - n))) : x;
}

__device__ void keccak_f1600(uint64_t a[25]) {
    #pragma unroll 1
    for (int round = 0; round < 24; ++round) {
        uint64_t c[5], b[25];
        #pragma unroll
        for (int x = 0; x < 5; ++x) c[x] = a[x]^a[x+5]^a[x+10]^a[x+15]^a[x+20];
        #pragma unroll
        for (int x = 0; x < 5; ++x) {
            uint64_t d = c[(x+4)%5] ^ rotl64(c[(x+1)%5], 1);
            #pragma unroll
            for (int y = 0; y < 5; ++y) a[x+5*y] ^= d;
        }
        #pragma unroll
        for (int y = 0; y < 5; ++y)
            #pragma unroll
            for (int x = 0; x < 5; ++x)
                b[y + 5*((2*x + 3*y)%5)] = rotl64(a[x+5*y], KECCAK_RHO[x+5*y]);
        #pragma unroll
        for (int y = 0; y < 5; ++y)
            #pragma unroll
            for (int x = 0; x < 5; ++x)
                a[x+5*y] = b[x+5*y] ^ ((~b[(x+1)%5+5*y]) & b[(x+2)%5+5*y]);
        a[0] ^= KECCAK_RC[round];
    }
}

__device__ __forceinline__ uint32_t fnv32(uint32_t a, uint32_t b) {
    return a * FNV_PRIME ^ b;
}

__device__ void hashimoto(const uint32_t *dag, uint32_t page_count,
                          const unsigned char *challenge, uint64_t nonce,
                          uint32_t digest[8], unsigned char result[32]) {
    uint64_t state[25] = {0};
    unsigned char *bytes = (unsigned char *)state;
    #pragma unroll
    for (int i = 0; i < 32; ++i) bytes[i] = challenge[i];
    #pragma unroll
    for (int i = 0; i < 8; ++i) bytes[32+i] = (unsigned char)(nonce >> (8*i));
    bytes[40] = 0x01;
    bytes[71] |= 0x80;
    keccak_f1600(state);

    uint32_t seed[16], mix[32];
    #pragma unroll
    for (int i = 0; i < 16; ++i) seed[i] = ((uint32_t *)state)[i];
    #pragma unroll
    for (int i = 0; i < 32; ++i) mix[i] = seed[i & 15];
    const uint32_t seed0 = seed[0];
    #pragma unroll 1
    for (uint32_t access = 0; access < 64; ++access) {
        uint32_t page = fnv32(access ^ seed0, mix[access & 31]) % page_count;
        const uint32_t *data = dag + ((uint64_t)page * 32);
        #pragma unroll
        for (int j = 0; j < 32; ++j) mix[j] = fnv32(mix[j], data[j]);
    }
    #pragma unroll
    for (int i = 0; i < 8; ++i)
        digest[i] = fnv32(fnv32(fnv32(mix[4*i], mix[4*i+1]), mix[4*i+2]), mix[4*i+3]);

    #pragma unroll
    for (int i = 0; i < 25; ++i) state[i] = 0;
    #pragma unroll
    for (int i = 0; i < 16; ++i) ((uint32_t *)state)[i] = seed[i];
    #pragma unroll
    for (int i = 0; i < 8; ++i) ((uint32_t *)state)[16+i] = digest[i];
    bytes[96] = 0x01;
    bytes[135] |= 0x80;
    keccak_f1600(state);
    #pragma unroll
    for (int i = 0; i < 32; ++i) result[i] = bytes[i];
}

extern "C" __global__ void ethash_search_scalar(const uint32_t *dag, uint32_t page_count,
    const unsigned char *challenge, uint64_t start, uint64_t count,
    const unsigned char *target, unsigned int *found, unsigned long long *found_index) {
    uint64_t index = (uint64_t)blockIdx.x * blockDim.x + threadIdx.x;
    if (index >= count) return;
    uint32_t digest[8]; unsigned char result[32];
    hashimoto(dag, page_count, challenge, start + index, digest, result);
    #pragma unroll
    for (int i = 0; i < 32; ++i) {
        if (result[i] > target[i]) return;
        if (result[i] < target[i]) break;
    }
    // Keep discovery state separate from the index.  UINT64_MAX is a valid
    // index when the complete nonce space is assigned in one range.
    if (atomicCAS(found, 0u, 1u) == 0u)
        *found_index = (unsigned long long)index;
}

extern "C" __global__ void ethash_one(const uint32_t *dag, uint32_t page_count,
    const unsigned char *challenge, uint64_t nonce, uint32_t *digest_out,
    unsigned char *result_out) {
    if (blockIdx.x || threadIdx.x) return;
    uint32_t digest[8]; unsigned char result[32];
    hashimoto(dag, page_count, challenge, nonce, digest, result);
    #pragma unroll
    for (int i = 0; i < 8; ++i) digest_out[i] = digest[i];
    #pragma unroll
    for (int i = 0; i < 32; ++i) result_out[i] = result[i];
}

// Default search: eight cooperating lanes, four hashes in flight.

__device__ void cooperative_hashimoto(const uint32_t *dag, uint32_t page_count,
                          const unsigned char *challenge, uint64_t nonce,
                          uint32_t digest[8], unsigned char result[32]) {
    uint64_t state[25] = {0};
    unsigned char *bytes = (unsigned char *)state;
    #pragma unroll
    for (int i = 0; i < 32; ++i) bytes[i] = challenge[i];
    #pragma unroll
    for (int i = 0; i < 8; ++i) bytes[32+i] = (unsigned char)(nonce >> (8*i));
    bytes[40] = 0x01;
    bytes[71] |= 0x80;
    keccak_f1600(state);


    uint32_t seed[16];
    #pragma unroll
    for (int i=0; i<16; ++i) seed[i] = ((uint32_t*)state)[i];
    const unsigned mask = __activemask();
    const int lane = threadIdx.x & 7;
    #pragma unroll 1
    for (int owner_base=0; owner_base<8; owner_base+=4) {
        uint32_t part[4][4], first[4];
        #pragma unroll
        for (int p=0; p<4; ++p) {
            first[p] = __shfl_sync(mask, seed[0], owner_base+p, 8);
            // All lanes execute every shuffle with the same source word.
            #pragma unroll
            for (int word=0; word<16; ++word) {
                uint32_t v = __shfl_sync(mask, seed[word], owner_base+p, 8);
                if ((word/4)==(lane&3)) part[p][word&3]=v;
            }
        }
        #pragma unroll 1
        for (unsigned group=0; group<16; ++group) {
            #pragma unroll
            for (unsigned component=0; component<4; ++component) {
                #pragma unroll
                for (int p=0; p<4; ++p) {
                    unsigned access=group*4+component;
                    uint32_t selected=__shfl_sync(mask,part[p][component],group&7,8);
                    uint32_t page=fnv32(access ^ first[p],selected) % page_count;
                    uint4 values=((const uint4*)dag)[(uint64_t)page*8+lane];
                    part[p][0]=fnv32(part[p][0],values.x);
                    part[p][1]=fnv32(part[p][1],values.y);
                    part[p][2]=fnv32(part[p][2],values.z);
                    part[p][3]=fnv32(part[p][3],values.w);
                }
            }
        }
        #pragma unroll
        for (int p=0; p<4; ++p) {
            uint32_t reduced=fnv32(fnv32(fnv32(part[p][0],part[p][1]),part[p][2]),part[p][3]);
            #pragma unroll
            for (int word=0; word<8; ++word) {
                uint32_t v=__shfl_sync(mask,reduced,word,8);
                if(lane==owner_base+p) digest[word]=v;
            }
        }
    }

    #pragma unroll
    for (int i = 0; i < 25; ++i) state[i] = 0;
    #pragma unroll
    for (int i = 0; i < 16; ++i) ((uint32_t *)state)[i] = seed[i];
    #pragma unroll
    for (int i = 0; i < 8; ++i) ((uint32_t *)state)[16+i] = digest[i];
    bytes[96] = 0x01;
    bytes[135] |= 0x80;
    keccak_f1600(state);
    #pragma unroll
    for (int i = 0; i < 32; ++i) result[i] = bytes[i];
}

extern "C" __global__ void ethash_search(const uint32_t *dag, uint32_t page_count,
    const unsigned char *challenge, uint64_t start, uint64_t count,
    const unsigned char *target, unsigned int *found, unsigned long long *found_index) {
    uint64_t index = (uint64_t)blockIdx.x * blockDim.x + threadIdx.x;
    uint32_t digest[8]; unsigned char result[32];
    // Padded lanes must participate in all cooperative shuffles.
    cooperative_hashimoto(dag, page_count, challenge, start + (index < count ? index : 0), digest, result);
    if (index >= count) return;
    #pragma unroll
    for (int i = 0; i < 32; ++i) {
        if (result[i] > target[i]) return;
        if (result[i] < target[i]) break;
    }
    // Keep discovery state separate from the index.  UINT64_MAX is a valid
    // index when the complete nonce space is assigned in one range.
    if (atomicCAS(found, 0u, 1u) == 0u)
        *found_index = (unsigned long long)index;
}

