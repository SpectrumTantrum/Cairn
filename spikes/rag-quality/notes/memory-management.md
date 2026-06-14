# Memory Management

## The Stack and the Heap

A program's stack holds function call frames, each with the local variables and return address for one active call, and it grows and shrinks automatically as functions are entered and exited. The heap is a region for dynamically allocated memory whose lifetime the program controls explicitly or through a collector. Stack allocation is fast — just bumping a pointer — but limited in size and scope, while heap allocation is flexible but slower and prone to fragmentation. A stack overflow comes from runaway recursion exhausting the call stack.

## Garbage Collection

Garbage collection automatically reclaims heap memory no longer reachable from the program's roots. Tracing collectors mark every object reachable from the roots and sweep away the rest; generational collectors exploit the observation that most objects die young by collecting a small young generation often and an old generation rarely. The alternative, reference counting, frees an object the moment its count hits zero but cannot reclaim cycles on its own. The cost of collection is pause times, which concurrent and incremental collectors work to shorten.

## Manual Memory and Common Bugs

Languages like C make the programmer free every allocation explicitly, which is fast and predictable but error-prone. A memory leak is allocated memory never freed, slowly exhausting the heap. A use-after-free reads or writes memory already returned to the allocator, and a double free corrupts allocator bookkeeping; both are exploitable security bugs. A dangling pointer refers to freed or out-of-scope memory. Tools like AddressSanitizer and Valgrind catch many of these by instrumenting allocations at runtime.

## Smart Pointers and Ownership

Smart pointers tie a heap object's lifetime to a scope so it is freed automatically, giving manual languages much of the safety of garbage collection without the pauses. A unique pointer expresses sole ownership and frees its object when it goes out of scope. A shared pointer keeps a reference count and frees when the last owner releases it, while a weak pointer observes a shared object without keeping it alive, breaking the reference cycles that pure reference counting cannot reclaim.
