# Hash Tables and Hashing

## Hash Table Basics

A hash table stores key-value pairs in an array of buckets, using a hash function to map each key to a bucket index. When the hash distributes keys evenly, lookup, insert, and delete all run in O(1) on average. The worst case is O(n) if every key collides into one bucket, which is why a good hash function and a controlled load factor matter. The load factor is the ratio of stored entries to buckets; once it crosses a threshold the table is resized and all entries are rehashed into a larger array.

## Collision Resolution: Chaining

Separate chaining resolves collisions by storing all entries that hash to the same bucket in a secondary structure, classically a linked list. Lookups scan the chain for the matching key, so performance degrades gracefully as chains lengthen rather than failing outright. Modern implementations sometimes upgrade long chains to balanced trees so that a pathological bucket costs O(log n) instead of O(n). Chaining tolerates load factors above one because the buckets only hold pointers to chains, not the entries themselves.

## Collision Resolution: Open Addressing

Open addressing stores every entry directly in the bucket array and resolves a collision by probing for another open slot. Linear probing checks the next slot in sequence, quadratic probing jumps by increasing offsets, and double hashing uses a second hash function to choose the step. Open addressing has better cache locality than chaining but suffers from clustering and cannot exceed a load factor of one, so it must resize sooner. Deletions need tombstone markers so that probe sequences are not broken.

## Cryptographic vs Non-Cryptographic Hashes

A non-cryptographic hash such as FNV or MurmurHash is built only for speed and even distribution, which is all a hash table needs. A cryptographic hash such as SHA-256 additionally resists collision and preimage attacks, so that it is infeasible to find two inputs with the same digest or to reverse a digest back to its input. Using a slow cryptographic hash inside a hash table wastes time, while using a fast non-cryptographic hash for security is dangerous — the choice depends entirely on the threat model.
