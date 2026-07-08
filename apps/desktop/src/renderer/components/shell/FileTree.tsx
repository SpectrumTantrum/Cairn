import { ChevronDown, ChevronRight, FileText, FileQuestion } from "lucide-react";
import type { TreeNode } from "../../../shared/types.js";

interface FileTreeProps {
  nodes: TreeNode[];
  expanded: Set<string>;
  activePath: string | null;
  onToggleFolder(path: string): void;
  onOpenNode(node: TreeNode): void;
}

export function FileTree({ nodes, expanded, activePath, onToggleFolder, onOpenNode }: FileTreeProps) {
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
      />
    </div>
  );
}

function TreeLevel({ nodes, expanded, activePath, onToggleFolder, onOpenNode }: FileTreeProps) {
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
              >
                <span className="caret">
                  {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </span>
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
          >
            <span className="caret" />
            <span className="node-icon">
              {isMd ? <FileText size={14} /> : <FileQuestion size={14} />}
            </span>
            <span className="node-name">{displayName(node.name)}</span>
          </button>
        );
      })}
    </>
  );
}

function displayName(name: string): string {
  return name.toLowerCase().endsWith(".md") ? name.slice(0, -3) : name;
}
