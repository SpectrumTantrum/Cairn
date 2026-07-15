import { useState } from "react";
import type { MouseEvent } from "react";
import { ChevronDown, ChevronRight, FilePlus, FileQuestion, FileText, FolderInput, FolderPlus, Pencil, Trash2 } from "lucide-react";
import type { TreeNode } from "../../../shared/types.js";

/** Mutation intents surfaced by the tree (issue #21). `parent` is a folder's vault-relative path ("" = root). */
export interface TreeMutations {
  onNewFile(parent: string): void;
  onNewFolder(parent: string): void;
  onRenameNode(node: TreeNode): void;
  onMoveNode(node: TreeNode): void;
  onDeleteNode(node: TreeNode): void;
}

interface FileTreeProps extends TreeMutations {
  nodes: TreeNode[];
  expanded: Set<string>;
  activePath: string | null;
  onToggleFolder(path: string): void;
  onOpenNode(node: TreeNode): void;
}

interface MenuState {
  node: TreeNode;
  x: number;
  y: number;
}

export function FileTree({ nodes, expanded, activePath, onToggleFolder, onOpenNode, ...mutations }: FileTreeProps) {
  const [menu, setMenu] = useState<MenuState | null>(null);

  function openMenu(e: MouseEvent, node: TreeNode): void {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ node, x: e.clientX, y: e.clientY });
  }

  if (nodes.length === 0) {
    return <p className="tree-empty">This vault has no Markdown files yet.</p>;
  }
  return (
    <div className="file-tree">
      <TreeLevel
        nodes={nodes}
        expanded={expanded}
        activePath={activePath}
        onToggleFolder={onToggleFolder}
        onOpenNode={onOpenNode}
        onContextMenu={openMenu}
      />
      {menu ? <ContextMenu menu={menu} mutations={mutations} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}

interface TreeLevelProps {
  nodes: TreeNode[];
  expanded: Set<string>;
  activePath: string | null;
  onToggleFolder(path: string): void;
  onOpenNode(node: TreeNode): void;
  onContextMenu(e: MouseEvent, node: TreeNode): void;
}

function TreeLevel({ nodes, expanded, activePath, onToggleFolder, onOpenNode, onContextMenu }: TreeLevelProps) {
  return (
    <>
      {nodes.map((node) => {
        if (node.type === "folder") {
          const isOpen = expanded.has(node.path);
          return (
            <div key={node.path}>
              <button
                type="button"
                className="tree-row"
                onClick={() => onToggleFolder(node.path)}
                onContextMenu={(e) => onContextMenu(e, node)}
              >
                <span className="caret">{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
                <span className="node-name">{node.name}</span>
              </button>
              {isOpen && node.children && node.children.length > 0 ? (
                <div className="tree-group">
                  <TreeLevel
                    nodes={node.children}
                    expanded={expanded}
                    activePath={activePath}
                    onToggleFolder={onToggleFolder}
                    onOpenNode={onOpenNode}
                    onContextMenu={onContextMenu}
                  />
                </div>
              ) : null}
            </div>
          );
        }
        const active = node.path === activePath;
        const isMd = node.type === "markdown";
        return (
          <button
            type="button"
            key={node.path}
            className={`tree-row${active ? " active" : ""}${isMd ? "" : " other"}`}
            title={isMd ? node.path : `${node.path} — opens as a read-only host (Markdown editing only for now)`}
            onClick={() => onOpenNode(node)}
            onContextMenu={(e) => onContextMenu(e, node)}
          >
            <span className="caret" />
            <span className="node-icon">{isMd ? <FileText size={14} /> : <FileQuestion size={14} />}</span>
            <span className="node-name">{displayName(node.name)}</span>
          </button>
        );
      })}
    </>
  );
}

/** Right-click actions for a tree node. Folder nodes also expose new-note / new-folder. */
function ContextMenu({ menu, mutations, onClose }: { menu: MenuState; mutations: TreeMutations; onClose(): void }) {
  const { node, x, y } = menu;
  const isFolder = node.type === "folder";
  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };
  return (
    <>
      <div
        className="context-menu-overlay"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <ul className="context-menu" style={{ top: y, left: x }} role="menu">
        {isFolder ? (
          <>
            <li>
              <button type="button" role="menuitem" onClick={run(() => mutations.onNewFile(node.path))}>
                <FilePlus size={13} /> New note
              </button>
            </li>
            <li>
              <button type="button" role="menuitem" onClick={run(() => mutations.onNewFolder(node.path))}>
                <FolderPlus size={13} /> New folder
              </button>
            </li>
            <li className="context-sep" role="separator" />
          </>
        ) : null}
        <li>
          <button type="button" role="menuitem" onClick={run(() => mutations.onRenameNode(node))}>
            <Pencil size={13} /> Rename…
          </button>
        </li>
        <li>
          <button type="button" role="menuitem" onClick={run(() => mutations.onMoveNode(node))}>
            <FolderInput size={13} /> Move…
          </button>
        </li>
        <li>
          <button type="button" role="menuitem" className="danger" onClick={run(() => mutations.onDeleteNode(node))}>
            <Trash2 size={13} /> Delete…
          </button>
        </li>
      </ul>
    </>
  );
}

function displayName(name: string): string {
  return name.toLowerCase().endsWith(".md") ? name.slice(0, -3) : name;
}
