// Hand-authored evaluation pairs for the rag-quality spike.
//
// Each pair: { question, expected_chunk_id, category }.
//   expected_chunk_id -> the ONE primary-evidence chunk for the question (run
//     `node chunker.mjs` to see the id manifest). Scoring is single-id membership
//     in the top-3 (retrieval.mjs), NOT "any of N ids" — that would inflate recall
//     and soften the 80% bar. Multi-hop questions therefore each name the single
//     chunk that most directly answers them.
//   category -> one of: 'paraphrase' | 'exact-term' | 'multi-hop'.
//     paraphrase  — describes the concept WITHOUT the defining term/keyword
//                   (this is where a weak embedder fails: synonym/intent matching).
//     exact-term  — uses the technical term verbatim (keyword-overlap easy case).
//     multi-hop   — requires connecting two ideas, but one chunk is the primary
//                   evidence (e.g. "which sort do I pick if X and Y").
//
// The corpus is intentionally clustered with confusable neighbors (4 sorts, 3
// tree types, chaining vs open addressing, BFS vs DFS, LRU in caching AND in OS
// paging, ...), so top-3 here is a real discrimination test, not a gimme.

export const EVAL = [
  // ---- paraphrase (no defining keyword shared with the chunk) ----------------
  { question: 'Which sorting method can collapse to slow quadratic behavior when the data is already in order and the pivot is picked badly?', expected_chunk_id: 66, category: 'paraphrase' },
  { question: 'What sorting approach keeps equal items in their original order and always splits the list down the middle?', expected_chunk_id: 67, category: 'paraphrase' },
  { question: 'Which ordering method turns the data into a max-heap and pulls the biggest item off the top repeatedly?', expected_chunk_id: 68, category: 'paraphrase' },
  { question: 'What technique builds the answer one subproblem at a time and remembers earlier answers so it never recomputes them?', expected_chunk_id: 30, category: 'paraphrase' },
  { question: 'Which strategy always grabs whatever looks best at the moment and never goes back to revise an earlier pick?', expected_chunk_id: 33, category: 'paraphrase' },
  { question: 'What graph walk fans out one ring of neighbors at a time and finds the fewest-hops route in an unweighted map?', expected_chunk_id: 34, category: 'paraphrase' },
  { question: 'Which graph walk plunges as far down one path as it can before retreating to try another?', expected_chunk_id: 35, category: 'paraphrase' },
  { question: 'What lets one position in a sequence weigh how much every other position matters when forming its own representation?', expected_chunk_id: 70, category: 'paraphrase' },
  { question: 'How does a model that has no built-in sense of word order get told where each token sits in the sentence?', expected_chunk_id: 72, category: 'paraphrase' },
  { question: 'What kind of lock lets only a single thread into a protected region at once?', expected_chunk_id: 13, category: 'paraphrase' },
  { question: 'What situation arises when several threads each hold something the others need and none can move forward?', expected_chunk_id: 15, category: 'paraphrase' },
  { question: 'Why does storing each fact in only one place mean you sometimes have to stitch several tables together to answer a question?', expected_chunk_id: 27, category: 'paraphrase' },
  { question: 'During a network split, why must a distributed store give up either staying answerable or staying in agreement?', expected_chunk_id: 29, category: 'paraphrase' },
  { question: 'Which transport gives up reliability and ordering to send data with the least delay, good for live video and games?', expected_chunk_id: 46, category: 'paraphrase' },
  { question: 'What goes wrong when a model basically memorizes the training set, scoring great on it but poorly on new data?', expected_chunk_id: 39, category: 'paraphrase' },
  { question: 'Why does making a model more flexible cut one source of error while raising another, so you have to find the middle?', expected_chunk_id: 40, category: 'paraphrase' },
  { question: 'What gives every program its own private illusion of a big contiguous memory while the system maps it to real frames behind the scenes?', expected_chunk_id: 52, category: 'paraphrase' },
  { question: 'When fast memory fills up, how do you pick which page to throw out, and what is the unbeatable-but-impossible ideal choice?', expected_chunk_id: 53, category: 'paraphrase' },
  { question: 'How are stored passwords kept safe so that even if the database leaks, the originals are not exposed?', expected_chunk_id: 59, category: 'paraphrase' },
  { question: 'What scheme uses a freely shareable key to lock a message that only the matching secret key can open?', expected_chunk_id: 58, category: 'paraphrase' },
  { question: 'What proves that no general procedure can decide whether an arbitrary program will eventually stop?', expected_chunk_id: 4, category: 'paraphrase' },
  { question: 'What balanced tree is built for disks, keeping many keys per node so the path from top to bottom stays short?', expected_chunk_id: 24, category: 'paraphrase' },
  { question: 'Which structure stores words by sharing common starting letters along a path, so lookup cost depends on word length?', expected_chunk_id: 25, category: 'paraphrase' },

  // ---- exact-term (uses the technical term verbatim) -------------------------
  { question: 'What is the worst-case time complexity of quicksort?', expected_chunk_id: 66, category: 'exact-term' },
  { question: 'Is merge sort a stable sort and how much auxiliary space does it need?', expected_chunk_id: 67, category: 'exact-term' },
  { question: 'How does Timsort exploit existing runs in the data?', expected_chunk_id: 62, category: 'exact-term' },
  { question: 'How does counting sort beat the comparison-sort lower bound?', expected_chunk_id: 63, category: 'exact-term' },
  { question: 'What does radix sort do to sort integers digit by digit?', expected_chunk_id: 64, category: 'exact-term' },
  { question: 'What is the difference between Big-O, Big-Omega, and Big-Theta?', expected_chunk_id: 9, category: 'exact-term' },
  { question: 'What does amortized analysis measure and how does the dynamic-array doubling example work?', expected_chunk_id: 11, category: 'exact-term' },
  { question: 'What is an NP-complete problem and what would a polynomial-time solution to one imply?', expected_chunk_id: 12, category: 'exact-term' },
  { question: 'How does Dijkstra\'s algorithm handle non-negative edge weights and why does it fail with negative ones?', expected_chunk_id: 36, category: 'exact-term' },
  { question: 'What is a topological sort and when does one exist?', expected_chunk_id: 37, category: 'exact-term' },
  { question: 'What invariant does a red-black tree enforce on node colors?', expected_chunk_id: 22, category: 'exact-term' },
  { question: 'How does an AVL tree decide when to rotate?', expected_chunk_id: 23, category: 'exact-term' },
  { question: 'How does separate chaining resolve hash collisions?', expected_chunk_id: 18, category: 'exact-term' },
  { question: 'What is open addressing and how does linear probing work?', expected_chunk_id: 19, category: 'exact-term' },
  { question: 'What does the ACID acronym stand for in database transactions?', expected_chunk_id: 26, category: 'exact-term' },
  { question: 'What are the steps of the TCP three-way handshake?', expected_chunk_id: 47, category: 'exact-term' },
  { question: 'How does multi-head attention differ from single-head attention?', expected_chunk_id: 71, category: 'exact-term' },
  { question: 'What pretraining objective does BERT use and how does it differ from GPT?', expected_chunk_id: 73, category: 'exact-term' },
  { question: 'What is tail recursion and why can it run in constant stack space?', expected_chunk_id: 55, category: 'exact-term' },
  { question: 'What does the master theorem do for divide-and-conquer recurrences?', expected_chunk_id: 56, category: 'exact-term' },
  { question: 'What is the pumping lemma used to prove?', expected_chunk_id: 3, category: 'exact-term' },
  { question: 'How does garbage collection reclaim unreachable heap memory?', expected_chunk_id: 43, category: 'exact-term' },

  // ---- multi-hop (connect two ideas; one primary-evidence chunk) -------------
  { question: 'I need a comparison sort with a guaranteed n log n worst case AND only constant extra space — which one fits?', expected_chunk_id: 68, category: 'multi-hop' },
  { question: 'If I must sort and stability matters but I also want a guaranteed n log n even in the worst case, which sort should I reach for?', expected_chunk_id: 67, category: 'multi-hop' },
  { question: 'Why can counting sort and radix sort run faster than n log n when every comparison sort cannot?', expected_chunk_id: 65, category: 'multi-hop' },
  { question: 'My shortest-path graph has some negative edge weights — why is the greedy single-source method the wrong tool here?', expected_chunk_id: 36, category: 'multi-hop' },
  { question: 'Greedy returns a plausible but wrong answer on the 0/1 knapsack, so what method actually solves it correctly and why?', expected_chunk_id: 32, category: 'multi-hop' },
  { question: 'My binary search tree degraded to linear-time operations on sorted input — what self-balancing tree keeps height logarithmic with color rules?', expected_chunk_id: 22, category: 'multi-hop' },
  { question: 'My hash table chains are getting long and slow under a high load factor — what collision strategy tolerates load factors above one?', expected_chunk_id: 18, category: 'multi-hop' },
  { question: 'I want exact-match key lookups in a database with no need for range scans — which index type is built only for that?', expected_chunk_id: 28, category: 'multi-hop' },
  { question: 'A page-replacement policy should approximate evicting the page used furthest in the future — which cheap approximation uses a reference bit?', expected_chunk_id: 53, category: 'multi-hop' },
  { question: 'In a bounded-buffer producer-consumer setup, which primitive counts filled and empty slots to coordinate the two sides?', expected_chunk_id: 14, category: 'multi-hop' },
  { question: 'To break the circular-wait condition and avoid deadlock, what discipline on the order of lock acquisition should every thread follow?', expected_chunk_id: 13, category: 'multi-hop' },
  { question: 'I want the safety of automatic memory reclamation in a manual language without GC pauses — what feature ties an object\'s lifetime to a scope?', expected_chunk_id: 45, category: 'multi-hop' },
  { question: 'My cache keeps evicting items I am about to reuse — which eviction policy exploits temporal locality by dropping the least-recently-used entry?', expected_chunk_id: 6, category: 'multi-hop' },
  { question: 'I need encryption for bulk traffic but have no pre-shared secret — how do systems combine asymmetric and symmetric crypto to solve that?', expected_chunk_id: 58, category: 'multi-hop' },
  { question: 'Untrusted input is being concatenated straight into my SQL queries — what attack does that enable and what is the fix?', expected_chunk_id: 60, category: 'multi-hop' },
  { question: 'I authenticated the user correctly but they still did something they should not be allowed to — which distinct concept did I get wrong?', expected_chunk_id: 61, category: 'multi-hop' },
];
