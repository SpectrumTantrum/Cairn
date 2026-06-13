"""Spike C: LanceDB embedded hybrid search = dense vector + full-text(BM25) + RRF,
with citation metadata, no server. Tests whether the keyword half comes from an FTS
index over the stored TEXT (not from consumed learned-sparse vectors), which would
make the PRD's `sparse` column unnecessary.
Run: uv run --with lancedb --with pylance python lancedb_hybrid.py
"""
import json, urllib.request, shutil, os
import lancedb
from lancedb.rerankers import RRFReranker

print("lancedb version:", lancedb.__version__)

def embed(text):
    req = urllib.request.Request("http://localhost:11434/api/embed",
        data=json.dumps({"model": "bge-m3", "input": text}).encode(),
        headers={"content-type": "application/json"})
    return json.load(urllib.request.urlopen(req))["embeddings"][0]

DOCS = [
    ("RRF (reciprocal rank fusion) combines ranked lists by summing 1/(k+rank).", "papers/fusion.pdf", 3, ["Methods", "Fusion"]),
    ("The Kalman filter estimates state from noisy measurements recursively.", "lectures/estimation.pdf", 12, ["Estimation", "Kalman"]),
    ("Photosynthesis converts light into chemical energy in chloroplasts.", "bio/cells.pdf", 5, ["Cells", "Energy"]),
    ("Dense retrieval embeds text into vectors and ranks by cosine similarity.", "papers/retrieval.pdf", 1, ["Retrieval"]),
    ("BM25 scores documents by term frequency and inverse document frequency.", "papers/retrieval.pdf", 2, ["Retrieval", "Keyword"]),
    ("Gradient descent minimizes a loss by stepping along the negative gradient.", "ml/optim.pdf", 7, ["Optimization"]),
]

DB = "/tmp/mneme-lance"
shutil.rmtree(DB, ignore_errors=True)
db = lancedb.connect(DB)
rows = [{"text": t, "vector": embed(t), "source_file": sf, "page": pg, "heading_path": json.dumps(hp)}
        for (t, sf, pg, hp) in DOCS]
tbl = db.create_table("chunks", data=rows)

# Full-text (BM25) index over the TEXT column — native Rust FTS, no Tantivy dep.
tbl.create_fts_index("text", use_tantivy=False)
print("created: vector column (dim %d) + FTS/BM25 index over `text`  (embedded, on disk: %s)" % (len(rows[0]["vector"]), DB))

def hybrid(q, k=3):
    qv = embed(q)
    res = (tbl.search(query_type="hybrid")
              .vector(qv).text(q)
              .rerank(reranker=RRFReranker())
              .limit(k).to_list())
    return res

for q in ["how do you fuse two ranked result lists?",   # semantic -> RRF doc
          "Kalman"]:                                      # exact keyword -> FTS half
    print(f"\nQUERY: {q!r}")
    for r in hybrid(q):
        cite = f'{r["source_file"]} p.{r["page"]} {json.loads(r["heading_path"])}'
        print(f'  score={r.get("_relevance_score", r.get("_score","?")):.4f}  [{cite}]  {r["text"][:60]}...')

print("\nVERDICT: LanceDB does embedded hybrid (dense + BM25-FTS + RRF) with full citation")
print("metadata, no server. The keyword half is the FTS index over `text` — it does NOT")
print("consume learned-sparse vectors, so the PRD `sparse` column is unnecessary for this path.")
