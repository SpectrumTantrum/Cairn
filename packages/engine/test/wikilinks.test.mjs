import assert from "node:assert/strict";
import { before, test } from "node:test";

let parseWikilinks;
let resolveWikilink;
let computeBacklinks;
let buildBacklinkIndex;

before(async () => {
  const engine = await import("../dist/index.js");
  parseWikilinks = engine.parseWikilinks;
  resolveWikilink = engine.resolveWikilink;
  computeBacklinks = engine.computeBacklinks;
  buildBacklinkIndex = engine.buildBacklinkIndex;
});

test("parses plain, aliased, fragment, and typed link forms", () => {
  const md = "See [[Foo]], [[bar|the bar]], [[Foo#Heading]], and [[pdf: Paper · p.3|page 3]].";
  const links = parseWikilinks(md);
  assert.equal(links.length, 4);

  assert.equal(links[0].target, "Foo");
  assert.equal(links[0].alias, undefined);
  assert.equal(links[0].display, "Foo");

  assert.equal(links[1].target, "bar");
  assert.equal(links[1].alias, "the bar");
  assert.equal(links[1].display, "the bar");

  assert.equal(links[2].target, "Foo");
  assert.equal(links[2].fragment, "Heading");

  // Typed form is parsed generically — the whole left side is the target, no per-format branching.
  assert.equal(links[3].target, "pdf: Paper · p.3");
  assert.equal(links[3].alias, "page 3");
  assert.equal(links[3].display, "page 3");
});

test("resolves exact path, extension-optional, and unique basename", () => {
  const files = ["notes/Foo.md", "sub/bar.md", "readme.markdown"];

  assert.equal(resolveWikilink("notes/Foo", files).path, "notes/Foo.md");
  assert.equal(resolveWikilink("notes/Foo.md", files).path, "notes/Foo.md");
  // Bare basename resolves to the unique file with that leaf name.
  assert.equal(resolveWikilink("bar", files).path, "sub/bar.md");
  assert.equal(resolveWikilink("readme", files).path, "readme.markdown");
});

test("reports ambiguity when a bare name matches multiple files, and null when unresolved", () => {
  const files = ["a/note.md", "b/note.md", "c/other.md"];
  const amb = resolveWikilink("note", files);
  assert.equal(amb.path, null);
  assert.deepEqual(amb.ambiguous.sort(), ["a/note.md", "b/note.md"]);

  const missing = resolveWikilink("nope", files);
  assert.equal(missing.path, null);
  assert.deepEqual(missing.ambiguous, []);
});

test("computeBacklinks finds files linking to a target and excludes self-links", () => {
  const docs = [
    { path: "index.md", content: "Start at [[Foo]] and [[sub/bar]]." },
    { path: "notes/Foo.md", content: "Foo links to [[sub/bar|bar]]. Foo also mentions [[Foo]] (self)." },
    { path: "sub/bar.md", content: "Bar stands alone." },
  ];

  const toFoo = computeBacklinks("notes/Foo.md", docs);
  assert.deepEqual(toFoo.map((b) => b.from), ["index.md"]);

  const toBar = computeBacklinks("sub/bar.md", docs).map((b) => b.from).sort();
  assert.deepEqual(toBar, ["index.md", "notes/Foo.md"]);
});

test("buildBacklinkIndex returns an entry for every doc, empty when unlinked", () => {
  const docs = [
    { path: "a.md", content: "link to [[b]]" },
    { path: "b.md", content: "no outgoing links" },
    { path: "c.md", content: "also links [[b]]" },
  ];
  const map = buildBacklinkIndex(docs);
  assert.deepEqual([...map.keys()].sort(), ["a.md", "b.md", "c.md"]);
  assert.deepEqual(map.get("b.md").map((x) => x.from).sort(), ["a.md", "c.md"]);
  assert.deepEqual(map.get("a.md"), []);
});
