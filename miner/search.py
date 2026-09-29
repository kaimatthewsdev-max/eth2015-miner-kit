#!/usr/bin/env python3
"""ETH2015 GPU search: cuda/ethash.cu driven by CuPy, one process per GPU.

  python3 miner/search.py --job jobs/42-mint.json            # mine a job from tools/job.mjs
  python3 miner/search.py --dag data/1 --bench 60            # measure MH/s, find nothing
  python3 miner/search.py --dag data/1 --bench 30 --kernel scalar   # compare the naive kernel

Found solutions are written to solutions/ as JSON before the program exits.
"""

import argparse
import json
import multiprocessing as mp
import os
import queue
import secrets
import sys
import time
import urllib.request

import numpy as np
from Crypto.Hash import keccak

HERE = os.path.dirname(os.path.abspath(__file__))
KERNEL = os.path.join(HERE, "..", "cuda", "ethash.cu")
U64 = 1 << 64
FNV_PRIME = np.uint32(0x01000193)


# ---------------------------------------------------------------- CPU reference

def keccak512(data):
    return keccak.new(digest_bits=512, data=data).digest()


def keccak256(data):
    return keccak.new(digest_bits=256, data=data).digest()


def hashimoto_cpu(dag_words, page_count, challenge, nonce):
    """Plain Hashimoto over a uint32 view of dag.bin. Slow, but independent of the GPU."""
    seed = keccak512(challenge + nonce.to_bytes(8, "little"))
    words = np.frombuffer(seed, dtype="<u4")
    mix = np.concatenate([words, words]).astype(np.uint32)
    s0 = int(mix[0])
    with np.errstate(over="ignore"):
        for i in range(64):
            index = (((i ^ s0) * 0x01000193) ^ int(mix[i % 32])) % (1 << 32) % page_count
            page = dag_words[index * 32:index * 32 + 32]
            mix = (mix * FNV_PRIME) ^ page
        m = mix.reshape(8, 4)
        digest = (((m[:, 0] * FNV_PRIME ^ m[:, 1]) * FNV_PRIME ^ m[:, 2]) * FNV_PRIME ^ m[:, 3])
    digest = digest.astype("<u4").tobytes()
    return digest, keccak256(seed + digest)


def target_for(difficulty):
    return (1 << 256) - 1 if difficulty == 1 else (1 << 256) // difficulty


# ---------------------------------------------------------------- work size

def next_batch_size(current, elapsed_ms, target_ms, maximum):
    """Aim every launch at target_ms. Clamp each step to x0.25..x4 and keep it a multiple of 128."""
    ratio = max(0.25, min(4.0, target_ms / max(elapsed_ms, 0.001)))
    proposed = max(128, int(current * ratio))
    return min(maximum, (proposed // 128) * 128)


# ---------------------------------------------------------------- GPU process

def gpu_process(gpu, args, job, start, events, stop):
    try:
        import cupy as cp
        cp.cuda.Device(gpu).use()
        with open(KERNEL, encoding="utf-8") as f:
            module = cp.RawModule(code=f.read(), options=("--std=c++14",),
                                  name_expressions=("ethash_search", "ethash_search_scalar", "ethash_one"))
        search = module.get_function("ethash_search" if args.kernel == "coop" else "ethash_search_scalar")
        one = module.get_function("ethash_one")

        pages = job["pageCount"]
        host = np.memmap(os.path.join(job["dagDir"], "dag.bin"), mode="r", dtype="<u4", shape=(pages * 32,))
        dag = cp.asarray(host)
        cp.cuda.runtime.deviceSynchronize()

        challenge = bytes.fromhex(job["challenge"][2:])
        ch = cp.asarray(np.frombuffer(challenge, dtype=np.uint8))
        found = cp.zeros(1, dtype=cp.uint32)
        found_index = cp.zeros(1, dtype=cp.uint64)
        threads = args.threads

        def launch(first, count, target):
            found[:] = 0
            t = target if isinstance(target, cp.ndarray) else cp.asarray(np.frombuffer(target, dtype=np.uint8))
            blocks = (count + threads - 1) // threads
            search((blocks,), (threads,), (dag, np.uint32(pages), ch, np.uint64(first), np.uint64(count),
                                           t, found, found_index))
            cp.cuda.runtime.deviceSynchronize()
            return int(found_index.get()[0]) if int(found.get()[0]) else None

        # Self-check 1: single hashes against the CPU, including the 32-bit and 64-bit edges.
        digest = cp.empty(8, dtype=cp.uint32)
        result = cp.empty(32, dtype=cp.uint8)
        for nonce in (0, 1, (1 << 32) - 1, 1 << 32, U64 - 1, start):
            one((1,), (1,), (dag, np.uint32(pages), ch, np.uint64(nonce), digest, result))
            cp.cuda.runtime.deviceSynchronize()
            want = hashimoto_cpu(host, pages, challenge, nonce)
            got = (digest.get().astype("<u4").tobytes(), result.get().tobytes())
            if got != want:
                raise RuntimeError("GPU %d disagrees with the CPU at nonce %d" % (gpu, nonce))

        # Self-check 2: the search kernel must find the best of 200 nonces (a partial block
        # of padded lanes), and nothing for an all-zero target.
        first = (start + 12345) % U64
        results = [(hashimoto_cpu(host, pages, challenge, (first + i) % U64)[1], i) for i in range(200)]
        best, best_i = min(results)
        if launch(first, 200, best) != best_i or launch(first, 200, bytes(32)) is not None:
            raise RuntimeError("GPU %d search kernel self-check failed" % gpu)
        events.put({"type": "ready", "gpu": gpu, "name": cp.cuda.runtime.getDeviceProperties(gpu)["name"].decode()})

        target = bytes(32) if args.bench else target_for(int(job["difficulty"])).to_bytes(32, "big")
        target = cp.asarray(np.frombuffer(target, dtype=np.uint8))
        cursor, batch = start, args.batch
        while not stop.is_set():
            began = time.perf_counter()
            index = launch(cursor, batch, target)
            ms = (time.perf_counter() - began) * 1000
            if index is not None:
                nonce = (cursor + index) % U64
                mix, res = hashimoto_cpu(host, pages, challenge, nonce)
                events.put({"type": "found", "gpu": gpu, "nonce": nonce,
                            "mixDigest": "0x" + mix.hex(), "result": "0x" + res.hex()})
                return
            events.put({"type": "progress", "gpu": gpu, "hashes": batch, "ms": ms, "batch": batch})
            cursor = (cursor + batch) % U64
            batch = next_batch_size(batch, ms, args.target_ms, args.max_batch)
    except Exception as exc:  # report, the parent stops everything
        events.put({"type": "error", "gpu": gpu, "error": "%s: %s" % (type(exc).__name__, exc)})


# ---------------------------------------------------------------- main

def load_job(args):
    if args.job:
        with open(args.job) as f:
            job = json.load(f)
        job["dagDir"] = args.dag or os.path.join(args.data, str(job["epoch"]))
    else:
        if not args.dag:
            sys.exit("give --job, or --dag DIR (with --challenge and --difficulty, or --bench)")
        job = {"dagDir": args.dag, "challenge": args.challenge or "0x" + "00" * 32,
               "difficulty": str(args.difficulty or 1)}
    with open(os.path.join(job["dagDir"], "manifest.json")) as f:
        manifest = json.load(f)
    if "dagRoot" in job and job["dagRoot"].lower() != manifest["dagRoot"].lower():
        sys.exit("dataset root %s is not the card's %s" % (manifest["dagRoot"], job["dagRoot"]))
    job["epoch"], job["pageCount"] = manifest["epoch"], manifest["pageCount"]
    if os.path.getsize(os.path.join(job["dagDir"], "dag.bin")) != job["pageCount"] * 128:
        sys.exit("dag.bin has the wrong size for pageCount")
    if len(job["challenge"]) != 66:
        sys.exit("challenge must be 32 bytes of hex")
    return job


def minted_by(job):
    """Owner of the card if it has been minted, via tokenState(uint256) on the job's RPC."""
    call = keccak256(b"tokenState(uint256)")[:4] + int(job["tokenId"]).to_bytes(32, "big")
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_call",
                       "params": [{"to": job["nftAddress"], "data": "0x" + call.hex()}, "latest"]}).encode()
    request = urllib.request.Request(job["rpc"], body, {"Content-Type": "application/json", "User-Agent": "eth2015-miner-kit"})
    with urllib.request.urlopen(request, timeout=20) as response:
        words = bytes.fromhex(json.load(response)["result"][2:])
    owner = words[44:64]
    return None if owner == bytes(20) else "0x" + owner.hex()


def save_solution(args, job, nonce, mix, result, where):
    difficulty = int(job["difficulty"])
    if int(result, 16) > target_for(difficulty):
        sys.exit("%s reported nonce %d, which does not meet the target" % (where, nonce))
    sol = dict(challenge=job["challenge"], difficulty=str(difficulty), epoch=job["epoch"],
               nonce=str(nonce), mixDigest=mix, result=result,
               tokenId=job.get("tokenId"), action=job.get("action"), recipient=job.get("recipient"),
               foundAt=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    os.makedirs(args.out, exist_ok=True)
    path = os.path.join(args.out, "%s-%s-%s.json" % (job.get("tokenId", "x"), job.get("action", "work"), nonce))
    with open(path, "w") as f:
        json.dump(sol, f, indent=2)
    print("FOUND nonce %d on %s, saved %s" % (nonce, where, path), flush=True)


def cpu_search(args, job, start):
    """Pure Python, about 2,000 hashes a second: enough for Sepolia's test difficulty, nothing more."""
    pages, challenge = job["pageCount"], bytes.fromhex(job["challenge"][2:])
    dag = np.memmap(os.path.join(job["dagDir"], "dag.bin"), mode="r", dtype="<u4", shape=(pages * 32,))
    goal, nonce, began = target_for(int(job["difficulty"])), start, time.time()
    while True:
        mix, result = hashimoto_cpu(dag, pages, challenge, nonce)
        if int.from_bytes(result, "big") <= goal:
            print("%d hashes in %.1f s" % ((nonce - start) % U64 + 1, time.time() - began))
            return save_solution(args, job, nonce, "0x" + mix.hex(), "0x" + result.hex(), "CPU")
        nonce = (nonce + 1) % U64


def main():
    p = argparse.ArgumentParser(description="ETH2015 CUDA search")
    p.add_argument("--job", help="job JSON from tools/job.mjs")
    p.add_argument("--data", default="data", help="folder holding <epoch>/dag.bin (default: data)")
    p.add_argument("--dag", help="one epoch folder, overrides --data")
    p.add_argument("--challenge"); p.add_argument("--difficulty", type=int)
    p.add_argument("--gpus", help="comma list of GPU indexes (default: all)")
    p.add_argument("--start", type=int, help="first nonce (default: random)")
    p.add_argument("--bench", type=float, help="measure for this many seconds with an impossible target")
    p.add_argument("--kernel", choices=("coop", "scalar"), default="coop")
    p.add_argument("--threads", type=int, default=64, help="threads per block, a multiple of 8")
    p.add_argument("--target-ms", type=float, default=500, help="aim for GPU launches of this length")
    p.add_argument("--batch", type=int, default=1 << 20, help="first launch size, adapts from there")
    p.add_argument("--max-batch", type=int, default=1 << 30)
    p.add_argument("--cpu", action="store_true", help="search on the CPU (Sepolia test difficulty only)")
    p.add_argument("--out", default="solutions")
    args = p.parse_args()
    if args.threads % 8:
        p.error("--threads must be a multiple of 8 (eight lanes share one DAG page)")
    job = load_job(args)
    base = args.start if args.start is not None else secrets.randbits(64)
    if args.cpu:
        return cpu_search(args, job, base)

    import cupy as cp
    gpus = [int(x) for x in args.gpus.split(",")] if args.gpus else list(range(cp.cuda.runtime.getDeviceCount()))
    if not gpus:
        sys.exit("no CUDA GPU found")
    ctx = mp.get_context("spawn")
    events, stop = ctx.Queue(), ctx.Event()
    procs = []
    for k, gpu in enumerate(gpus):  # disjoint, far-apart starting points
        start = (base + k * (U64 // len(gpus))) % U64
        procs.append(ctx.Process(target=gpu_process, args=(gpu, args, job, start, events, stop), daemon=True))
    for proc in procs:
        proc.start()
    print("epoch %d, %d pages, %s GPU(s), loading %.2f GB each and self-checking..."
          % (job["epoch"], job["pageCount"], len(gpus), job["pageCount"] * 128 / 1e9), flush=True)

    rate, batch, ready = {}, {}, 0
    window = {g: [0, 0.0] for g in gpus}
    began = shown = None
    checked = time.time()
    watch = job.get("action") == "mint" and job.get("rpc") and not args.bench
    difficulty = int(job["difficulty"])
    try:
        while True:
            try:
                e = events.get(timeout=1)
            except queue.Empty:
                e = None
                if not any(proc.is_alive() for proc in procs):
                    sys.exit("all GPU processes stopped")
            if e and e["type"] == "error":
                sys.exit("GPU %d: %s" % (e["gpu"], e["error"]))
            if e and e["type"] == "ready":
                ready += 1
                print("GPU %d ready (%s), self-check passed" % (e["gpu"], e["name"]), flush=True)
                if ready == len(gpus):
                    began = shown = time.time()
            if e and e["type"] == "progress":
                w = window[e["gpu"]]
                w[0] += e["hashes"]; w[1] += e["ms"] / 1000
                batch[e["gpu"]] = e["batch"]
            if e and e["type"] == "found":
                save_solution(args, job, e["nonce"], e["mixDigest"], e["result"], "GPU %d" % e["gpu"])
                return 0
            now = time.time()
            if began and now - shown >= 10:
                for g in gpus:
                    h, s = window[g]
                    rate[g] = h / s if s else rate.get(g, 0)
                    window[g] = [0, 0.0]
                total = sum(rate.values())
                line = "%.1f MH/s  " % (total / 1e6) + "  ".join(
                    "gpu%d %.1f (batch %.1fM)" % (g, rate.get(g, 0) / 1e6, batch.get(g, 0) / 1e6) for g in gpus)
                if not args.bench and total:
                    line += "  | average time per solution %.1f h" % (difficulty / total / 3600)
                print(line, flush=True)
                shown = now
            if watch and now - checked >= 600:
                checked = now
                try:
                    owner = minted_by(job)
                except Exception as exc:
                    print("could not check whether card %s is still unminted: %s" % (job["tokenId"], exc), flush=True)
                else:
                    if owner:
                        sys.exit("card %s was minted by %s meanwhile; stopping (a mint solution cannot be reused)"
                                 % (job["tokenId"], owner))
            if args.bench and began and now - began >= args.bench:
                return 0
    finally:
        stop.set()
        for proc in procs:
            proc.join(timeout=5)
            if proc.is_alive():
                proc.terminate()


if __name__ == "__main__":
    sys.exit(main())
