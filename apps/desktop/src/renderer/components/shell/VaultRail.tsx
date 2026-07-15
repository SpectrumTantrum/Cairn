import {
  ArrowUpDown,
  ChevronsDownUp,
  FilePlus,
  FolderPlus,
  HelpCircle,
  Repeat2,
  Search,
  Settings,
  X,
} from "lucide-react";
import type { KeyboardEvent } from "react";
import type { SearchHit, TreeNode, TreeSortMode } from "../../../shared/types.js";
import { FileTree } from "./FileTree";

const STUB_HINT = "Coming in v1 — needs vault-mutation write support";

/** Human labels for the sort toggle's tooltip (current mode + next-on-click). */
const SORT_LABELS: Record<TreeSortMode, string> = {
  name: "name",
  mtime: "date modified",
  size: "size",
};
const SORT_NEXT: Record<TreeSortMode, TreeSortMode> = {
  name: "mtime",
  mtime: "size",
  size: "name",
};

interface VaultRailProps {
  vaultName: string | null;
  nodes: TreeNode[];
  expanded: Set<string>;
  activePath: string | null;
  // sort
  sortMode: TreeSortMode;
  canSort: boolean;
  onCycleSort(): void;
  // search
  searchOpen: boolean;
  searchQuery: string;
  searchResults: SearchHit[];
  searching: boolean;
  canSearch: boolean;
  onToggleSearch(): void;
  onSearchChange(value: string): void;
  onSearchSubmit(): void;
  onOpenResult(hit: SearchHit): void;
  // tree
  onToggleFolder(path: string): void;
  onOpenNode(node: TreeNode): void;
  onCollapseAll(): void;
  onSwitchVault(): void;
  onOpenSettings(): void;
}

export function VaultRail({
  vaultName,
  nodes,
  expanded,
  activePath,
  sortMode,
  canSort,
  onCycleSort,
  searchOpen,
  searchQuery,
  searchResults,
  searching,
  canSearch,
  onToggleSearch,
  onSearchChange,
  onSearchSubmit,
  onOpenResult,
  onToggleFolder,
  onOpenNode,
  onCollapseAll,
  onSwitchVault,
  onOpenSettings,
}: VaultRailProps) {
  return (
    <>
      <div className="rail-header">
        <span className="rail-title">Vault</span>
        <div className="rail-actions">
          <button type="button" className="icon-btn" disabled title={STUB_HINT}>
            <FilePlus size={16} />
          </button>
          <button type="button" className="icon-btn" disabled title={STUB_HINT}>
            <FolderPlus size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title={`Sort by ${SORT_LABELS[sortMode]} — click to sort by ${SORT_LABELS[SORT_NEXT[sortMode]]}`}
            onClick={onCycleSort}
            disabled={!canSort}
          >
            <ArrowUpDown size={16} />
          </button>
          <button
            type="button"
            className={`icon-btn${searchOpen ? " active" : ""}`}
            title="Search this vault"
            onClick={onToggleSearch}
            disabled={!canSearch}
          >
            <Search size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Collapse all folders"
            onClick={onCollapseAll}
            disabled={expanded.size === 0}
          >
            <ChevronsDownUp size={16} />
          </button>
        </div>
      </div>

      {searchOpen ? (
        <VaultSearch
          query={searchQuery}
          results={searchResults}
          searching={searching}
          onChange={onSearchChange}
          onSubmit={onSearchSubmit}
          onClose={onToggleSearch}
          onOpenResult={onOpenResult}
        />
      ) : null}

      {vaultName ? (
        <FileTree
          nodes={nodes}
          expanded={expanded}
          activePath={activePath}
          onToggleFolder={onToggleFolder}
          onOpenNode={onOpenNode}
        />
      ) : (
        <div className="file-tree">
          <p className="tree-empty">Choose a vault folder to browse your Markdown notes.</p>
        </div>
      )}

      <div className="rail-footer">
        <button
          type="button"
          className="vault-switcher"
          onClick={onSwitchVault}
          title={vaultName ? "Switch vault" : "Choose a vault folder"}
        >
          <Repeat2 size={15} />
          <span className="vault-name">{vaultName ?? "Choose vault…"}</span>
        </button>
        <div className="rail-actions">
          <button type="button" className="icon-btn" disabled title="Coming in v1 — needs help/docs surface">
            <HelpCircle size={16} />
          </button>
          <button type="button" className="icon-btn" title="Settings — cloud models (BYOK)" onClick={onOpenSettings}>
            <Settings size={16} />
          </button>
        </div>
      </div>
    </>
  );
}

interface VaultSearchProps {
  query: string;
  results: SearchHit[];
  searching: boolean;
  onChange(value: string): void;
  onSubmit(): void;
  onClose(): void;
  onOpenResult(hit: SearchHit): void;
}

/** Vault-wide search: input above the tree, results with file/heading/snippet + line jump. */
function VaultSearch({ query, results, searching, onChange, onSubmit, onClose, onOpenResult }: VaultSearchProps) {
  function onKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === "Enter") {
      e.preventDefault();
      onSubmit();
    } else if (e.key === "Escape") {
      onClose();
    }
  }
  return (
    <div className="vault-search">
      <div className="vault-search-box">
        <Search size={14} />
        <input
          className="vault-search-input"
          type="text"
          value={query}
          placeholder="Search notes…"
          autoFocus
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button type="button" className="vault-search-clear" title="Close search" onClick={onClose}>
          <X size={13} />
        </button>
      </div>
      <div className="vault-search-results">
        {searching ? (
          <p className="muted">Searching…</p>
        ) : query.trim() === "" ? (
          <p className="muted">Type a query and press Enter.</p>
        ) : results.length === 0 ? (
          <p className="muted">No matches in this vault.</p>
        ) : (
          results.map((hit, i) => (
            <button
              type="button"
              className="search-result"
              key={`${hit.file}:${hit.line}:${i}`}
              title={`Open ${hit.file} at line ${hit.line}`}
              onClick={() => onOpenResult(hit)}
            >
              <span className="search-result-file">
                {basename(hit.file)}
                <span className="search-result-line">:{hit.line}</span>
                {hit.heading ? <span className="search-result-heading"> › {hit.heading}</span> : null}
              </span>
              <span className="search-result-snippet">{hit.snippet}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}
