import { basename, relative } from "node:path";
import { useMemo } from "react";
import { icon } from "../../core/icons.js";
import type { ChatMessage } from "../../types/index.js";

interface FileEntry {
  path: string;
  editCount: number;
  created: boolean;
}

function addFile(fileMap: Map<string, FileEntry>, path: string, created = false) {
  const existing = fileMap.get(path);
  if (existing) {
    existing.editCount++;
    if (created) existing.created = true;
  } else {
    fileMap.set(path, { path, editCount: 1, created });
  }
}

function useChangedFiles(messages: ChatMessage[]) {
  return useMemo(() => {
    const fileMap = new Map<string, FileEntry>();

    for (const msg of messages) {
      if (msg.role !== "assistant" || !msg.toolCalls) continue;
      for (const tc of msg.toolCalls) {
        if (tc.name === "edit_file" && typeof tc.args.path === "string" && tc.result?.success) {
          const isCreate = typeof tc.args.oldString === "string" && tc.args.oldString === "";
          addFile(fileMap, tc.args.path as string, isCreate);
        }
        if (tc.name === "multi_edit" && typeof tc.args.path === "string" && tc.result?.success) {
          addFile(fileMap, tc.args.path as string);
        }
        if (tc.name === "dispatch" && tc.result?.filesEdited) {
          for (const f of tc.result.filesEdited) {
            addFile(fileMap, f);
          }
        }
      }
    }

    return [...fileMap.values()].sort((a, b) => a.path.localeCompare(b.path));
  }, [messages]);
}

interface BarProps {
  messages: ChatMessage[];
}

export function ChangedFilesBar({ messages }: BarProps) {
  const files = useChangedFiles(messages);
  if (files.length === 0) return null;

  const created = files.filter((f) => f.created).length;
  const modified = files.length - created;
  const preview = files.slice(0, 3);
  const remaining = files.length - preview.length;

  return (
    <box height={1} paddingX={1}>
      <text truncate>
        <span fg="#555">{icon("changes")} </span>
        {created > 0 && <span fg="#5a8">+{String(created)} </span>}
        {modified > 0 && <span fg="#b87333">~{String(modified)} </span>}
        <span fg="#333">│ </span>
        {preview.map((f, i) => (
          <span key={f.path}>
            {i > 0 ? <span fg="#333"> </span> : null}
            <span fg={f.created ? "#5a8" : "#b87333"}>{basename(f.path)}</span>
          </span>
        ))}
        {remaining > 0 && <span fg="#444"> +{String(remaining)}</span>}
        <span fg="#333"> │ </span>
        <span fg="#444">/changes</span>
      </text>
    </box>
  );
}

interface TreeNode {
  name: string;
  file?: FileEntry;
  children: Map<string, TreeNode>;
}

function buildTree(files: FileEntry[], cwd: string): TreeNode {
  const root: TreeNode = { name: "", children: new Map() };
  for (const f of files) {
    const rel = relative(cwd, f.path) || basename(f.path);
    const parts = rel.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i] as string;
      let child = node.children.get(seg);
      if (!child) {
        child = { name: seg, children: new Map() };
        node.children.set(seg, child);
      }
      node = child;
    }
    const leaf = parts[parts.length - 1] as string;
    node.children.set(leaf, { name: leaf, file: f, children: new Map() });
  }
  return root;
}

interface FlatRow {
  depth: number;
  name: string;
  file?: FileEntry;
  isDir: boolean;
  isLast: boolean;
  parentLasts: boolean[];
}

function flattenTree(node: TreeNode, depth: number, parentLasts: boolean[]): FlatRow[] {
  const rows: FlatRow[] = [];
  const sorted = [...node.children.values()].sort((a, b) => {
    const aDir = a.children.size > 0 && !a.file;
    const bDir = b.children.size > 0 && !b.file;
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (let ci = 0; ci < sorted.length; ci++) {
    const child = sorted[ci];
    if (!child) continue;
    const isLast = ci === sorted.length - 1;
    const isDir = child.children.size > 0 && !child.file;

    if (isDir && child.children.size === 1) {
      const grandchild = [...child.children.values()][0] as TreeNode;
      const collapsed: TreeNode = {
        name: `${child.name}/${grandchild.name}`,
        file: grandchild.file,
        children: grandchild.children,
      };
      const isCollapsedDir = collapsed.children.size > 0 && !collapsed.file;
      if (isCollapsedDir) {
        const wrapper: TreeNode = { name: "", children: new Map([[collapsed.name, collapsed]]) };
        rows.push(...flattenTree(wrapper, depth, parentLasts));
      } else {
        rows.push({
          depth,
          name: collapsed.name,
          file: collapsed.file,
          isDir: false,
          isLast,
          parentLasts,
        });
      }
    } else {
      rows.push({ depth, name: child.name, file: child.file, isDir, isLast, parentLasts });
      if (isDir) rows.push(...flattenTree(child, depth + 1, [...parentLasts, isLast]));
    }
  }
  return rows;
}

function buildPrefix(row: FlatRow): string {
  if (row.depth === 0) return row.isLast ? "└─ " : "├─ ";
  let prefix = "";
  for (let i = 0; i < row.parentLasts.length; i++) {
    prefix += row.parentLasts[i] ? "   " : "│  ";
  }
  prefix += row.isLast ? "└─ " : "├─ ";
  return prefix;
}

interface PanelProps {
  messages: ChatMessage[];
  cwd: string;
}

export function ChangesPanel({ messages, cwd }: PanelProps) {
  const files = useChangedFiles(messages);

  const rows = useMemo(() => {
    if (files.length === 0) return [];
    const tree = buildTree(files, cwd);
    return flattenTree(tree, 0, []);
  }, [files, cwd]);

  const created = files.filter((f) => f.created).length;
  const modified = files.length - created;

  return (
    <box flexDirection="column" width="20%" borderStyle="rounded" border={true} borderColor="#333">
      <box height={1} flexShrink={0} paddingX={1} marginTop={-1}>
        <text>
          <span fg="#8B5CF6">{icon("changes")}</span>
          <span fg="#888"> Changes </span>
          {created > 0 && <span fg="#5a8">+{String(created)}</span>}
          {created > 0 && modified > 0 && <span fg="#444"> </span>}
          {modified > 0 && <span fg="#b87333">~{String(modified)}</span>}
        </text>
      </box>
      {files.length === 0 ? (
        <box paddingX={1} paddingY={1}>
          <text fg="#444">No changes yet</text>
        </box>
      ) : (
        <scrollbox flexGrow={1} flexShrink={1} minHeight={0}>
          {rows.map((row, i) => {
            const prefix = buildPrefix(row);
            if (row.isDir) {
              return (
                <box key={`d-${row.name}-${String(i)}`} paddingLeft={1} height={1}>
                  <text truncate>
                    <span fg="#333">{prefix}</span>
                    <span fg="#8B5CF6">{icon("folder")}</span>
                    <span fg="#777"> {row.name}</span>
                  </text>
                </box>
              );
            }
            const f = row.file;
            const isNew = f?.created ?? false;
            const statusIcon = isNew ? "A" : "M";
            const statusColor = isNew ? "#5a8" : "#b87333";
            const nameColor = isNew ? "#7cb" : "#bbb";
            return (
              <box key={f?.path ?? `f-${String(i)}`} paddingLeft={1} height={1}>
                <text truncate>
                  <span fg="#333">{prefix}</span>
                  <span fg={statusColor}>{statusIcon} </span>
                  <span fg={nameColor}>{row.name}</span>
                  {f && f.editCount > 1 && <span fg="#555"> ×{String(f.editCount)}</span>}
                </text>
              </box>
            );
          })}
        </scrollbox>
      )}
    </box>
  );
}
