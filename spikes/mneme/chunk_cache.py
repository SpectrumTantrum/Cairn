"""Spike A: the chunk-hash embedding cache's hit-rate is a function of CHUNKING
STRATEGY, not the cache. Test the same one-paragraph edit under two strategies:
  (1) heading/section-anchored splitting  -> edit contained to its section
  (2) global recursive split + 15% overlap (what PRD §6 literally describes)
      -> an early edit shifts every downstream boundary -> cascade
chunk_hash = sha256(chunk TEXT only), per PRD §9 (position metadata excluded).
"""
import hashlib, re

TOKEN_CAP = 512          # PRD §6
OVERLAP = int(0.15 * TOKEN_CAP)  # 15% overlap, ~77 tokens

def toks(s):  # crude tokenizer: words (good enough to show boundary behavior)
    return s.split()

def h(text):
    return hashlib.sha256(text.encode()).hexdigest()[:12]

# ---- build a realistic multi-section document --------------------------------
def make_doc(edit=False):
    secs = []
    for i in range(1, 11):
        # each section: heading + 3 paragraphs of varying length
        paras = []
        for p in range(3):
            n = 40 + ((i * 7 + p * 13) % 60)        # 40-100 words, deterministic
            word = f"s{i}p{p}w"
            body = " ".join(f"{word}{k}" for k in range(n))
            # the edit: change ONE paragraph in section 5 (mid-document)
            if edit and i == 5 and p == 1:
                body = " ".join(f"EDITED{k}" for k in range(n + 12))  # length changes too
            paras.append(body)
        secs.append((f"## Section {i}", paras))
    return secs

# ---- strategy 1: heading/section-anchored -----------------------------------
def chunk_heading_anchored(secs):
    chunks = []
    for heading, paras in secs:
        # pack paragraphs within THIS section only, cap at TOKEN_CAP, no cross-section merge
        buf, count = [], 0
        for para in paras:
            pt = toks(para)
            if count + len(pt) > TOKEN_CAP and buf:
                chunks.append(" ".join(buf)); buf, count = [], 0
            buf += pt; count += len(pt)
        if buf:
            chunks.append(" ".join(buf))
    return chunks

# ---- strategy 2: global recursive split + 15% overlap (PRD §6 verbatim) ------
def chunk_global_overlap(secs):
    # flatten the whole doc to one token stream (headings inline), then window it
    stream = []
    for heading, paras in secs:
        stream += toks(heading)
        for para in paras:
            stream += toks(para)
    chunks, i = [], 0
    step = TOKEN_CAP - OVERLAP
    while i < len(stream):
        chunks.append(" ".join(stream[i:i + TOKEN_CAP]))
        i += step
    return chunks

def hit_rate(before, after):
    old = {}
    for c in before:
        old[h(c)] = old.get(h(c), 0) + 1
    survived = 0
    for c in after:
        k = h(c)
        if old.get(k, 0) > 0:
            survived += 1; old[k] -= 1
    return survived, len(after)

doc0, doc1 = make_doc(edit=False), make_doc(edit=True)
print(f"TOKEN_CAP={TOKEN_CAP} overlap={OVERLAP} (15%)  |  edit = one paragraph rewritten in Section 5 of 10\n")

for name, fn in [("heading/section-anchored", chunk_heading_anchored),
                 ("global recursive + 15% overlap (PRD §6)", chunk_global_overlap)]:
    b, a = fn(doc0), fn(doc1)
    s, n = hit_rate(b, a)
    embeds_needed = n - s
    print(f"{name}:")
    print(f"  chunks: {len(b)} -> {len(a)}   cache HITS: {s}/{n}   re-embeds needed: {embeds_needed}   hit-rate: {100*s/n:.0f}%")
print("\nInterpretation: the cache only delivers 'near-free re-index' under section-anchored")
print("chunking. A global recursive splitter with overlap (what §6 describes) cascades a single")
print("edit across all downstream chunks, so the embedding cost is NOT bounded to the edit.")
