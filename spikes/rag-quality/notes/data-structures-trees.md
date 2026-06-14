# Tree Data Structures

## Binary Search Trees

A binary search tree keeps the invariant that every node's left subtree holds smaller keys and its right subtree holds larger keys, which lets search, insert, and delete run in time proportional to the tree's height. On a balanced tree that height is O(log n), but an unbalanced tree built by inserting sorted data degenerates into a linked list with O(n) operations. In-order traversal of a BST visits the keys in sorted order, which is a handy way to test whether a tree satisfies the search-tree property.

## Red-Black Trees

A red-black tree is a self-balancing binary search tree that colors each node red or black and enforces rules: the root is black, red nodes cannot have red children, and every root-to-leaf path has the same number of black nodes. These constraints keep the longest path at most twice the shortest, guaranteeing O(log n) height. Insertions and deletions restore the invariants with rotations and recoloring. Red-black trees back many standard library ordered maps because their rebalancing does less work on average than stricter schemes.

## AVL Trees

An AVL tree is a self-balancing binary search tree where the heights of any node's two child subtrees differ by at most one. After each insert or delete it checks the balance factor and performs single or double rotations to restore the height invariant. Because AVL trees are more rigidly balanced than red-black trees, lookups are slightly faster, but they pay for it with more rotations during updates. AVL trees are preferred for lookup-heavy workloads where reads vastly outnumber writes.

## B-Trees

A B-tree is a balanced search tree designed for storage systems that read data in large blocks, such as disks and databases. Each node holds many keys and has many children, keeping the tree short and wide so that traversing from root to leaf touches few blocks. A B-tree of order m keeps every node at least half full and grows by splitting full nodes upward. Database indexes and filesystems use B-trees and their variant the B+ tree, where all values live in the leaves linked for fast range scans.

## Tries

A trie, or prefix tree, stores strings by sharing common prefixes along paths from the root, so each edge is labeled with a character and each path spells out a key. Lookup and insertion take time proportional to the length of the key rather than the number of keys stored, which makes tries excellent for autocomplete and dictionary lookups. The trade-off is memory: a naive trie wastes space on sparse branches, which compressed variants like the radix tree or Patricia trie address by merging single-child chains.
