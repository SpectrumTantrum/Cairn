# Dynamic Programming and Greedy Algorithms

## What Dynamic Programming Is

Dynamic programming solves a problem by breaking it into overlapping subproblems and storing each subproblem's answer so it is computed only once. It applies when a problem has optimal substructure — an optimal solution is built from optimal solutions to subproblems — and overlapping subproblems, where the same subproblem recurs. The two implementation styles are top-down memoization, which caches recursive calls, and bottom-up tabulation, which fills a table in dependency order. The payoff is turning an exponential brute-force search into polynomial time.

## Memoization versus Tabulation

Memoization writes the recursion naturally and caches results in a lookup table the first time each is computed, so only the subproblems actually reached get solved. Tabulation instead iterates over all subproblems from the base cases upward, filling a table without recursion. Memoization is easier to derive from a recursive definition and skips unreachable states, while tabulation avoids recursion overhead and makes it easy to discard parts of the table no longer needed, saving space. They compute the same answers with the same asymptotic cost.

## The Knapsack Problem

The 0/1 knapsack problem asks which subset of items, each with a weight and a value, maximizes total value without exceeding a weight capacity. The dynamic program builds a table indexed by item count and remaining capacity, where each cell chooses the better of taking or skipping the current item. It runs in O(n W) time for n items and capacity W, which is pseudo-polynomial because it depends on the numeric capacity rather than its bit length. The fractional knapsack, by contrast, is solved greedily.

## Greedy Algorithms

A greedy algorithm builds a solution by repeatedly making the choice that looks best right now, never reconsidering. Greedy works only when the problem has the greedy-choice property — a locally optimal choice leads to a globally optimal solution — which must be proved, often by an exchange argument. Dijkstra's shortest paths, Huffman coding, and the fractional knapsack are greedy. The danger is that greedy fails silently on problems like 0/1 knapsack, returning a plausible but suboptimal answer, which is why dynamic programming is needed there.
