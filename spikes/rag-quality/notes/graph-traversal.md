# Graph Traversal and Shortest Paths

## Breadth-First Search

Breadth-first search explores a graph level by level, visiting all neighbors of the current frontier before moving outward. It uses a FIFO queue to track the frontier and a visited set to avoid revisiting nodes. On an unweighted graph, BFS finds the shortest path in terms of number of edges from the source to every reachable node. It runs in O(V + E) time, visiting each vertex and edge once. BFS is the basis for algorithms that need layer-by-layer expansion, such as finding connected components or bipartite checking.

## Depth-First Search

Depth-first search dives as deep as possible along each branch before backtracking, naturally implemented with a stack or with recursion. Like BFS it runs in O(V + E) time and uses a visited set. DFS produces a spanning tree and classifies edges as tree, back, forward, or cross edges, which is what makes it the engine behind cycle detection, topological sorting, and finding strongly connected components. A back edge encountered during DFS on a directed graph signals a cycle.

## Dijkstra's Algorithm

Dijkstra's algorithm finds shortest paths from a single source on a graph with non-negative edge weights. It greedily expands the closest unsettled vertex, relaxing the edges out of it, using a priority queue keyed by tentative distance. With a binary heap it runs in O((V + E) log V) time. Dijkstra fails on graphs with negative edge weights because once a vertex is settled it is never revisited, and a later negative edge could have offered a cheaper path. For that case the Bellman-Ford algorithm is used instead.

## Topological Sort

A topological sort orders the vertices of a directed acyclic graph so that every edge points from an earlier vertex to a later one. Two standard methods exist: Kahn's algorithm repeatedly removes vertices with in-degree zero, while the DFS-based method emits vertices in reverse order of finishing time. A topological order exists if and only if the graph is acyclic; if the algorithm cannot find a zero-in-degree vertex while edges remain, the graph contains a cycle. Topological sort underlies build systems and dependency resolution.
