# Recursion and Divide-and-Conquer

## Recursion and the Call Stack

A recursive function solves a problem by calling itself on smaller inputs until it reaches a base case that is solved directly. Every recursive call pushes a frame onto the call stack holding its arguments and local state, and the frames unwind as calls return. Without a reachable base case the recursion never stops and overflows the stack. Recursion expresses naturally self-similar problems — tree traversals, divide-and-conquer sorts, and grammar parsing — at the cost of stack space proportional to the recursion depth.

## Tail Recursion

A recursive call is in tail position when it is the very last action of the function, with nothing left to do after it returns. A compiler can optimize tail calls into a loop, reusing the current stack frame instead of pushing a new one, so a tail-recursive function runs in constant stack space. Many functional languages guarantee this optimization. A non-tail recursion, such as one that combines results after the recursive call returns, cannot be trivially flattened and keeps a frame per level.

## The Master Theorem

The master theorem gives the asymptotic running time of divide-and-conquer recurrences of the form T(n) = a T(n/b) + f(n), where a subproblems of size n/b are solved and f(n) is the work to divide and combine. Comparing f(n) against n raised to log base b of a yields three cases: the recursion dominates, the levels balance and add a log factor, or the top-level work dominates. It instantly gives merge sort's T(n) = 2 T(n/2) + O(n) as Theta(n log n).

## Backtracking

Backtracking is recursive search that builds a candidate solution incrementally and abandons a partial candidate the moment it cannot possibly be completed to a valid solution. It explores a tree of choices depth-first, undoing the last choice when a branch dead-ends and trying the next. Classic uses are solving Sudoku, placing N queens so none attack each other, and generating permutations. Pruning infeasible branches early is what makes backtracking tractable on search spaces far too large to enumerate fully.
