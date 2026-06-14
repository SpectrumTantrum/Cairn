# Advanced and Non-Comparison Sorting

## Timsort

Timsort is the hybrid sorting algorithm used by Python's built-in sort and Java's Arrays.sort for objects. It finds existing ordered subsequences called runs, extends short runs using insertion sort, and then merges the runs with an adaptive strategy that exploits partially-ordered data. Timsort is stable and achieves O(n) time on already-sorted input while keeping the O(n log n) worst case. It was designed by Tim Peters in 2002 specifically to perform well on the kinds of real-world data that arise in practice rather than on random permutations.

## Counting Sort

Counting sort is a non-comparison sort that works when keys are integers in a small known range. It counts how many times each key value appears, computes prefix sums to find each value's output position, and writes elements into their final slots. It runs in O(n + k) time where k is the size of the key range, beating the O(n log n) comparison lower bound. Counting sort is stable when implemented carefully, but it needs O(n + k) extra space and is only practical when k is not much larger than n.

## Radix Sort

Radix sort sorts integers or fixed-length strings digit by digit, using a stable subroutine — usually counting sort — on each digit position. Least-significant-digit radix sort processes the rightmost digit first and works up to the most significant. With d digits and a radix of b, it runs in O(d (n + b)) time, which is effectively linear when the key length is bounded. Because it sidesteps element comparisons entirely, radix sort can beat comparison sorts on large datasets of bounded-width integers.

## The Comparison Sort Lower Bound

Any sorting algorithm that determines order only by comparing pairs of elements must make at least O(n log n) comparisons in the worst case. The argument is a decision-tree counting bound: there are n factorial possible orderings, so a binary decision tree distinguishing them needs depth at least log(n!), which is Theta(n log n) by Stirling's approximation. This is why counting sort and radix sort, which read the keys directly instead of comparing them, are able to break the n log n barrier.
