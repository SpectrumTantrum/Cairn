# Comparison-Based Sorting Algorithms

## Quicksort

Quicksort is a divide-and-conquer sort that picks a pivot element and partitions the array so that everything smaller than the pivot comes before it and everything larger comes after. It then recurses on the two partitions. Its average-case running time is O(n log n), but if the pivot is consistently chosen poorly — for example, always picking the first element on an already-sorted array — it degrades to O(n^2). Quicksort is not stable, and it sorts in place using only O(log n) stack space for the recursion. In practice it is often the fastest comparison sort because of small constant factors and good cache locality.

## Merge Sort

Merge sort splits the array in half, recursively sorts each half, and then merges the two sorted halves back together. Because the split is always balanced, merge sort guarantees O(n log n) time in the best, average, and worst case. It is a stable sort, meaning equal elements keep their original relative order. The main drawback is that the standard array implementation needs O(n) auxiliary space for the merge step. Merge sort is the algorithm of choice when stability matters or when sorting linked lists, where the extra space disappears.

## Heapsort

Heapsort builds a binary max-heap from the input array and then repeatedly extracts the maximum element, placing it at the end of the array. Building the heap takes O(n) time and each of the n extractions costs O(log n), so the total running time is O(n log n) in all cases. Unlike merge sort, heapsort sorts in place with O(1) extra space, but unlike quicksort it is not stable and tends to have worse cache behavior because heap operations jump around the array. It is valued for its worst-case guarantee combined with constant space.

## Insertion Sort

Insertion sort builds the sorted output one element at a time, shifting larger elements to the right to make room for each new value. It runs in O(n^2) time in the average and worst case, but it is O(n) on nearly-sorted input and has very low overhead. Insertion sort is stable and in place. Because of its tiny constant factors, hybrid sorts switch to insertion sort for small subarrays, typically below a threshold of around ten to twenty elements.
