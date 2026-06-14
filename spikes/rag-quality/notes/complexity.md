# Asymptotic Complexity and Big-O Notation

## Big-O, Big-Omega, and Big-Theta

Big-O notation describes an asymptotic upper bound on a function's growth: f(n) is O(g(n)) if beyond some input size it never exceeds a constant multiple of g(n). Big-Omega is the matching lower bound, describing the best case an algorithm cannot beat asymptotically. Big-Theta is a tight bound, used when the upper and lower bounds coincide, so saying an algorithm is Theta(n log n) means it grows exactly on that order. People colloquially say "Big-O" when they really mean a tight bound, but the formal distinction matters in proofs.

## Common Growth Rates

The standard hierarchy of growth rates, from fastest-growing to slowest, runs: factorial, exponential, polynomial, then within polynomials cubic before quadratic before linearithmic before linear, then logarithmic, then constant. Linearithmic means n log n, the speed of the best comparison sorts. A logarithmic algorithm such as binary search roughly doubles the input it can handle for each extra unit of work. Constant time O(1) means the cost does not depend on input size at all, like indexing into an array.

## Amortized Analysis

Amortized analysis measures the average cost per operation over a worst-case sequence of operations, rather than the worst case of any single operation. The classic example is a dynamic array that doubles its capacity when full: a single insertion can cost O(n) when a resize happens, but across n insertions the total resizing work is bounded by 2n, so each insertion is O(1) amortized. The aggregate, accounting, and potential methods are three formal techniques for proving amortized bounds.

## P versus NP

The class P contains decision problems solvable in polynomial time by a deterministic machine. The class NP contains problems whose proposed solutions can be verified in polynomial time. The famous open question is whether P equals NP — whether every problem whose answer is quick to check is also quick to solve. NP-complete problems such as Boolean satisfiability are the hardest in NP: a polynomial-time algorithm for any one of them would solve all of them and prove P equals NP.
