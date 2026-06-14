# Caching

## Why Caches Work

A cache is a small fast store that holds copies of data from a larger slower store, betting that recently or frequently used data will be needed again. Caches work because real programs exhibit locality: temporal locality means a recently accessed item is likely to be accessed again soon, and spatial locality means items near a recently accessed one are likely next. Hardware caches, database buffer pools, content delivery networks, and browser caches all exploit the same principle at different scales.

## Cache Eviction Policies

When a cache fills, an eviction policy chooses what to discard. Least-recently-used evicts the item untouched for the longest, exploiting temporal locality, and is the common default. Least-frequently-used evicts the item with the fewest accesses, which suits skewed access patterns but can keep stale once-popular items too long. First-in-first-out evicts in insertion order regardless of use. The adaptive replacement cache balances recency and frequency, and many production caches add admission control to avoid polluting the cache with one-hit items.

## Write Policies and Invalidation

A write-through cache updates the cache and the backing store together, keeping them consistent at the cost of slower writes. A write-back cache updates only the cache and marks the entry dirty, flushing to the backing store later, which is faster but risks data loss on a crash and complicates consistency. Cache invalidation — knowing when a cached value has gone stale — is famously one of the hard problems in computer science, addressed with time-to-live expiry, explicit invalidation messages, or versioned keys.

## Cache Hierarchy in Hardware

A modern CPU has a hierarchy of caches between the cores and main memory. The L1 cache is tiny and per-core but answers in a few cycles, L2 is larger and slower, and L3 is shared across cores and larger still. Each level trades capacity for latency. A cache miss at one level falls through to the next, and a miss all the way to main memory costs hundreds of cycles, which is why cache-friendly memory access patterns can make an algorithm far faster than its instruction count alone would predict.
