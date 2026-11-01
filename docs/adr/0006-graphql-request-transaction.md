# ADR 0006: One read-only tenant transaction per GraphQL request

**Status:** accepted

## Problem
Under load, `POST /api/graphql` with the full dashboard served **300 req/s, p50 64 ms, p99 96 ms**, while simple REST reads served about 1,000 req/s. Each resolver and DataLoader batch called `withTenant()`, which opens its own transaction: `BEGIN`, `set_config`, the query, `COMMIT`. A dashboard request therefore held up to 7 pooled connections at once. With 20 concurrent clients and a pool of 10, requests spent their time **waiting for connections**.

## Decision
The GraphQL context opens **one controlled transaction per request**: `db.startTransaction().setAccessMode('read only')`, then `set_config` once. Every resolver and loader uses it, and an Apollo plugin commits it in `willSendResponse`, which runs for successful, invalid and failed operations alike.

## Result
Same benchmark (20 connections, 15 seconds):

| | before | after |
|---|---:|---:|
| req/s | 300 | **398 (+33%)** |
| p50 | 64 ms | 49 ms |
| p99 | 96 ms | **71 ms (−26%)** |

As a bonus, GraphQL **cannot write**. The transaction is `READ ONLY`, and a test asserts that an INSERT through it is rejected.

## Trade-off
The queries of one request now run sequentially on a single connection instead of in parallel on several. At these query costs (1 to 5 ms each), pool pressure dominated, so serialising was a net win. For very expensive independent queries, the old per-resolver pattern could be brought back selectively.
