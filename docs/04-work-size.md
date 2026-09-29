# 4. Work size: how many nonces per launch

How much work you hand the GPU per kernel launch matters more than it looks.

## What we saw

| Setup (RTX 5090, scalar kernel) | MH/s |
| --- | ---: |
| Fixed batches of 262,144 nonces | 30.65 |
| Adaptive batches aimed at 500 ms | 76.53 |

These ran on two different rented 5090s, so not all of the 2.5x is batching, but the
direction was clear: 262,144 nonces is only about 3 ms of work for a 5090 even with the
scalar kernel. Every launch pays a fixed cost: the launch itself, the synchronise, and reading back
the "found" flag. With millisecond batches that fixed cost is a large share of the time
and the GPU sits idle between launches. With the cooperative kernel a 5090 settles at
about **112.8 million nonces per 500 ms launch**.

## The rule we use

```python
def next_batch_size(current, elapsed_ms, target_ms=500, maximum=1 << 30):
    ratio = max(0.25, min(4.0, target_ms / max(elapsed_ms, 0.001)))
    proposed = max(128, int(current * ratio))
    return min(maximum, (proposed // 128) * 128)
```

- **Aim at a duration, not a count.** 500 ms is long enough that launch overhead is
  negligible and short enough to stay responsive: progress is reported, and a stop (you
  found a solution, or someone else minted the card) takes effect within half a second.
- **Clamp each step to x0.25 to x4** so one noisy measurement (a desktop redraw, a
  thermal dip) cannot swing the batch wildly.
- **Keep it a multiple of 128** so every block is full and cooperative groups are never
  padded except at the very end of a range.
- **Do not recalibrate on a short tail.** If the last launch of a range was smaller than
  the tuned size, its time says nothing about the full size; keep the old calibration.
- **Adapt per GPU.** Different cards in one machine settle at different sizes;
  `search.py` runs one process per GPU, each with its own batch size.

Start small (the default first batch is about a million nonces) and let it grow; the
first few launches find the size in a couple of seconds.

## Multi-GPU and nonce ranges

- Start from a **random 64-bit nonce**, not 0. Two machines, or a restart, will not repeat
  each other's work, and there is nothing to coordinate.
- Give each GPU a **disjoint range**. `search.py` spaces the starting points 2^64 / (number
  of GPUs) apart and lets each walk forward; they would need centuries to meet.
- Nonces wrap at 2^64. CUDA's `uint64` addition wraps for free; make sure your host code
  does too.
- There is no partial progress to save. Restarting from a fresh random start costs nothing.

## The browser version of the same lesson

The eth2015.com browser miner once targeted 50 ms dispatches for dataset generation.
On one user's machine every GPU completion took at least ~100 ms regardless of size (a
browser or driver floor), so the controller read every batch as too slow and halved it
again and again, down to 64 items: **0.04 MiB/s**. Retargeting to 200 ms let batches grow
past the floor (a controlled reproduction went from 12.82 s to 0.81 s for 512 KiB).

Lesson: elapsed time is not always proportional to work. If your target is close to the
fixed per-launch cost, adaptive sizing can spiral down. Pick a target comfortably above it.
