# Database Systems

## ACID Transactions

ACID names the four guarantees a transactional database provides. Atomicity means a transaction either fully commits or fully rolls back, never partway. Consistency means each transaction moves the database from one valid state to another, preserving all declared constraints. Isolation means concurrent transactions do not see each other's uncommitted intermediate states. Durability means once a transaction commits, its effects survive crashes, typically because they are written to a write-ahead log on stable storage before the commit is acknowledged.

## Normalization

Normalization organizes relational tables to reduce redundancy and avoid update anomalies. First normal form requires atomic column values with no repeating groups. Second normal form removes partial dependencies on part of a composite key. Third normal form removes transitive dependencies, so that non-key columns depend only on the key. The goal is that every fact is stored in exactly one place, so an update touches one row; the cost is that answering a query may require joining several tables back together.

## Database Indexes

An index is an auxiliary structure that speeds up lookups at the cost of extra storage and slower writes. Most relational databases implement indexes as B+ trees, which keep range queries and ordered scans efficient, while some use hash indexes for exact-match lookups only. A covering index includes every column a query needs so the engine never touches the base table. Indexes must be maintained on every insert, update, and delete, so over-indexing a write-heavy table can hurt more than it helps.

## The CAP Theorem

The CAP theorem states that a distributed data store can guarantee at most two of three properties when a network partition occurs: consistency, availability, and partition tolerance. Since partitions are unavoidable in real networks, the practical choice is between consistency and availability during a partition. A CP system refuses requests it cannot serve consistently, while an AP system stays available but may return stale data. Many modern systems offer tunable consistency, letting each operation pick its point on the spectrum.
