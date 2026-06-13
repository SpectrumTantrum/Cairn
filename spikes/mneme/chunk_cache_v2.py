"""Spike A (RECONCILED): my first spike used a naive fixed-window splitter and
showed a cascade. A workflow research agent, using the REAL langchain
RecursiveCharacterTextSplitter (which respects \\n\\n separators), got ~94% hits
and NO cascade. This re-runs with the real splitters across four regimes to find
where the chunk-hash cache actually breaks.
Run: uv run --with langchain-text-splitters python chunk_cache_v2.py
"""
import hashlib, re
from langchain_text_splitters import RecursiveCharacterTextSplitter, MarkdownHeaderTextSplitter

CHUNK, OVL = 1800, 270  # ~512 tokens, 15% overlap (char-based)

def H(s): return hashlib.sha256(s.encode()).hexdigest()[:12]
def hits(before, after):
    old = {}
    for c in before: old[H(c)] = old.get(H(c), 0) + 1
    s = 0
    for c in after:
        k = H(c)
        if old.get(k, 0) > 0: s += 1; old[k] -= 1
    return s, len(after)

def para(tag, n): return " ".join(f"{tag}{k}" for k in range(n))

def structured(edit=False):
    secs = []
    for i in range(1, 13):
        ps = []
        for p in range(3):
            n = 60 + ((i*7+p*11) % 40)
            body = para(f"EDIT" if (edit and i==2 and p==1) else f"s{i}p{p}w", n + (15 if (edit and i==2 and p==1) else 0))
            ps.append(body)
        secs.append(f"## Section {i}\n\n" + "\n\n".join(ps))
    return "\n\n".join(secs)

rec = RecursiveCharacterTextSplitter(chunk_size=CHUNK, chunk_overlap=OVL)  # default separators: \n\n, \n, " ", ""

# A1: structured prose, GLOBAL recursive, one early-section paragraph edited
b = rec.split_text(structured(False)); a = rec.split_text(structured(True))
s, n = hits(b, a); print(f"A1 structured + global recursive + 1 early edit:        {s}/{n} hits ({100*s/n:.0f}%)  [reconcile: cascade overstated?]")

# A2: structured prose, HEADER-ANCHORED (split by headers, then recurse within)
mds = MarkdownHeaderTextSplitter([("##", "h2")])
def header_anchored(doc):
    out = []
    for d in mds.split_text(doc):
        out += rec.split_text(d.page_content)
    return out
b = header_anchored(structured(False)); a = header_anchored(structured(True))
s, n = hits(b, a); print(f"A2 structured + HEADER-anchored + 1 early edit:          {s}/{n} hits ({100*s/n:.0f}%)")

# A3: RUN-ON text (no paragraph breaks), insert 5 words at the START
runon = para("w", 4000)
runon_edit = "NEW a b c d " + runon
b = rec.split_text(runon); a = rec.split_text(runon_edit)
s, n = hits(b, a); print(f"A3 run-on (no \\n\\n) + 5 words inserted at start:         {s}/{n} hits ({100*s/n:.0f}%)  [cascade IS real here]")

# A4: EXTRACTION REFLOW — identical WORDS, re-wrapped whitespace (simulates a
# non-deterministic re-extraction of an UNCHANGED pdf: same text, different breaks)
doc = structured(False)
reflowed = re.sub(r"\n\n+", " ", doc)          # collapse paragraph breaks (re-extractor lost them)
b = rec.split_text(doc); a = rec.split_text(reflowed)
s, n = hits(b, a); print(f"A4 extraction reflow (same words, lost \\n\\n):            {s}/{n} hits ({100*s/n:.0f}%)  [the DOMINANT risk]")

print("\nReconciled reading: the overlap-CASCADE fear is OVERSTATED for separator-respecting")
print("splitters on well-structured prose (A1/A2 high). The cache truly collapses for (A3)")
print("run-on/table/OCR text with no breaks near the cap, and (A4) PDF re-extraction that")
print("perturbs whitespace/reading-order — the headline PDF case. Risk = extraction determinism,")
print("not the overlap. Header-anchoring helps structure but does NOT fix A4.")
