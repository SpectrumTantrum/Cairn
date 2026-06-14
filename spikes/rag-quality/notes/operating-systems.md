# Operating System Fundamentals

## Processes and Threads

A process is an instance of a running program with its own isolated address space, file descriptors, and other resources, which the operating system protects from other processes. A thread is a unit of execution within a process; threads of the same process share its address space and resources but each has its own stack and registers. Creating a thread is cheaper than creating a process because there is no new address space to set up, but the shared memory means threads must synchronize to avoid corrupting shared state.

## CPU Scheduling

The CPU scheduler decides which ready process or thread runs next on a core. Round-robin gives each task a fixed time slice in rotation for fairness, first-come-first-served runs tasks in arrival order, and shortest-job-first minimizes average waiting time but needs to know or estimate run lengths. Preemptive schedulers can interrupt a running task when a higher-priority one becomes ready, while cooperative schedulers wait for the task to yield. Real systems use multilevel feedback queues that adjust priorities based on observed behavior.

## Virtual Memory and Paging

Virtual memory gives each process the illusion of a large contiguous address space while the operating system maps virtual pages to physical frames through a page table. When a process touches a page that is not resident in physical memory, a page fault traps into the kernel, which loads the page from disk, possibly evicting another page first. The translation lookaside buffer caches recent virtual-to-physical translations so that the common case avoids walking the page table. Paging enables isolation, sharing, and using more memory than physically exists.

## Page Replacement Policies

When physical memory is full and a new page must be loaded, a replacement policy chooses a victim page to evict. The theoretically optimal policy evicts the page that will be used furthest in the future, but that requires knowing the future, so real systems approximate it. Least-recently-used evicts the page unused for the longest time and performs well but is costly to track exactly; the clock algorithm approximates LRU cheaply with a reference bit. FIFO is simple but can suffer Belady's anomaly, where adding more frames increases faults.
