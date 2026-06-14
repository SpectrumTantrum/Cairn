# Concurrency Primitives

## Mutexes and Locks

A mutex, short for mutual exclusion, is a lock that guarantees only one thread enters a critical section at a time. A thread acquires the mutex before touching shared state and releases it afterward; any other thread that tries to acquire it blocks until the lock is free. Mutexes prevent data races but introduce the risk of deadlock when threads acquire multiple locks in inconsistent orders. The standard defense is to impose a global lock-ordering discipline so that all threads grab locks in the same sequence.

## Semaphores

A semaphore is a counter that controls access to a pool of identical resources. A counting semaphore initialized to N permits up to N threads through before the rest block; a binary semaphore initialized to one behaves much like a mutex. Threads call wait, which decrements the counter and blocks if it would go negative, and signal, which increments it and wakes a waiter. Semaphores are the classic tool for the producer-consumer problem, where one semaphore counts filled slots and another counts empty slots in a bounded buffer.

## Deadlock and the Four Conditions

A deadlock is a state where a set of threads are each waiting for a resource held by another, so none can proceed. Deadlock requires four conditions to hold simultaneously: mutual exclusion, hold-and-wait, no preemption, and circular wait. Breaking any one of them prevents deadlock — for instance, requiring a thread to request all its resources at once eliminates hold-and-wait, and imposing a total order on resources eliminates circular wait. Deadlock detection alternatively lets cycles form and recovers by aborting a thread.

## Race Conditions and Atomicity

A race condition occurs when the correctness of a program depends on the unpredictable timing of concurrent operations on shared data. The canonical example is two threads incrementing the same counter: each reads the value, adds one, and writes it back, so an interleaving can lose an update. An atomic operation executes as an indivisible unit that no other thread can observe partway through, which is why atomic compare-and-swap instructions are the foundation of lock-free data structures and of higher-level synchronization.
