import { useMemo, useState } from "react";
import type { FocusEvent, KeyboardEvent, ReactNode } from "react";
import { AlertTriangle, FilePlus, FolderInput, FolderPlus, Pencil } from "lucide-react";
import type { TreeNode } from "../../../shared/types.js";

/** The vault-mutation dialog currently open, or null (issue #21). */
export type TreeDialog =
  | { kind: "newFile"; parent: string }
  | { kind: "newFolder"; parent: string }
  | { kind: "rename"; node: TreeNode }
  | { kind: "move"; node: TreeNode }
  | { kind: "delete"; node: TreeNode };

interface TreeDialogsProps {
  dialog: TreeDialog;
  tree: TreeNode[];
  onCancel(): void;
  onCreateFile(parent: string, name: string): void;
  onCreateFolder(parent: string, name: string): void;
  onRename(node: TreeNode, name: string): void;
  onMove(node: TreeNode, dest: string): void;
  onDelete(node: TreeNode): void;
}

/** Renders the single active create/rename/move/delete dialog for the vault tree. */
export function TreeDialogs(props: TreeDialogsProps) {
  const { dialog } = props;
  switch (dialog.kind) {
    case "newFile":
      return (
        <PromptDialog
          key="newFile"
          icon={<FilePlus size={15} />}
          title="New note"
          label="Name (.md is added if you omit an extension)"
          initialValue="Untitled"
          confirmLabel="Create"
          onCancel={props.onCancel}
          onConfirm={(v) => props.onCreateFile(dialog.parent, v)}
        />
      );
    case "newFolder":
      return (
        <PromptDialog
          key="newFolder"
          icon={<FolderPlus size={15} />}
          title="New folder"
          label="Folder name"
          initialValue="New folder"
          confirmLabel="Create"
          onCancel={props.onCancel}
          onConfirm={(v) => props.onCreateFolder(dialog.parent, v)}
        />
      );
    case "rename":
      return (
        <PromptDialog
          key={`rename:${dialog.node.path}`}
          icon={<Pencil size={15} />}
          title="Rename"
          label="New name"
          initialValue={dialog.node.name}
          confirmLabel="Rename"
          selectBasename={dialog.node.type !== "folder"}
          onCancel={props.onCancel}
          onConfirm={(v) => props.onRename(dialog.node, v)}
        />
      );
    case "move":
      return (
        <MoveDialog
          node={dialog.node}
          tree={props.tree}
          onCancel={props.onCancel}
          onConfirm={(dest) => props.onMove(dialog.node, dest)}
        />
      );
    case "delete":
      return <DeleteDialog node={dialog.node} onCancel={props.onCancel} onConfirm={() => props.onDelete(dialog.node)} />;
  }
}

interface PromptDialogProps {
  icon: ReactNode;
  title: string;
  label: string;
  initialValue: string;
  confirmLabel: string;
  selectBasename?: boolean;
  onConfirm(value: string): void;
  onCancel(): void;
}

/** A single-line text-input modal used for new note / new folder / rename. */
function PromptDialog({ icon, title, label, initialValue, confirmLabel, selectBasename, onConfirm, onCancel }: PromptDialogProps) {
  const [value, setValue] = useState(initialValue);

  function submit(): void {
    const v = value.trim();
    if (!v) return;
    onConfirm(v);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      onCancel();
    }
  }

  // Select the basename (before the extension) on focus so a rename replaces the
  // stem without clobbering the `.md` unless the user chooses to.
  function onFocus(e: FocusEvent<HTMLInputElement>): void {
    const dot = value.lastIndexOf(".");
    if (selectBasename && dot > 0) e.target.setSelectionRange(0, dot);
    else e.target.select();
  }

  return (
    <div className="settings-backdrop" role="dialog" aria-modal="true" aria-label={title}>
      <div className="confirm-dialog">
        <h3>
          {icon} {title}
        </h3>
        <label className="field">
          <span>{label}</span>
          <input type="text" value={value} autoFocus onFocus={onFocus} onChange={(e) => setValue(e.target.value)} onKeyDown={onKeyDown} />
        </label>
        <div className="form-actions">
          <span className="spacer" />
          <button type="button" className="ghost-btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="primary-btn" onClick={submit} disabled={value.trim() === ""}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Destination-folder picker for a context-menu move (no drag-and-drop in this slice). */
function MoveDialog({ node, tree, onConfirm, onCancel }: { node: TreeNode; tree: TreeNode[]; onConfirm(dest: string): void; onCancel(): void }) {
  const options = useMemo(() => moveTargets(tree, node), [tree, node]);
  const [dest, setDest] = useState(options[0]?.value ?? "");

  return (
    <div className="settings-backdrop" role="dialog" aria-modal="true" aria-label="Move">
      <div className="confirm-dialog">
        <h3>
          <FolderInput size={15} /> Move {node.name}
        </h3>
        {options.length === 0 ? (
          <p>There is no other folder to move this into. Create a folder first.</p>
        ) : (
          <label className="field">
            <span>Destination folder</span>
            <select value={dest} onChange={(e) => setDest(e.target.value)}>
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="form-actions">
          <span className="spacer" />
          <button type="button" className="ghost-btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="primary-btn" onClick={() => onConfirm(dest)} disabled={options.length === 0}>
            Move
          </button>
        </div>
      </div>
    </div>
  );
}

function DeleteDialog({ node, onConfirm, onCancel }: { node: TreeNode; onConfirm(): void; onCancel(): void }) {
  const isFolder = node.type === "folder";
  return (
    <div className="settings-backdrop" role="dialog" aria-modal="true" aria-label="Confirm delete">
      <div className="confirm-dialog">
        <h3>
          <AlertTriangle size={15} /> Delete {isFolder ? "folder" : "file"}?
        </h3>
        <p>
          <code>{node.path}</code>
          {isFolder ? " and everything inside it" : ""} will be permanently deleted from your vault. This cannot be undone.
        </p>
        <div className="form-actions">
          <span className="spacer" />
          <button type="button" className="ghost-btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="primary-btn danger-btn" onClick={onConfirm}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

/** Folders a node may be moved into: every folder except the node's own subtree and its current parent, plus the vault root. */
function moveTargets(tree: TreeNode[], node: TreeNode): Array<{ value: string; label: string }> {
  const slash = node.path.lastIndexOf("/");
  const parent = slash === -1 ? "" : node.path.slice(0, slash);
  const folders: string[] = [];
  const walk = (nodes: TreeNode[]): void => {
    for (const n of nodes) {
      if (n.type !== "folder") continue;
      // Never offer moving a folder into itself or one of its descendants.
      if (node.type === "folder" && (n.path === node.path || n.path.startsWith(`${node.path}/`))) continue;
      folders.push(n.path);
      if (n.children) walk(n.children);
    }
  };
  walk(tree);
  return ["", ...folders]
    .filter((f) => f !== parent) // moving to the current parent is a no-op
    .map((f) => ({ value: f, label: f === "" ? "(vault root)" : f }));
}
