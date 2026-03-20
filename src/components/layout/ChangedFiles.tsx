import { basename, relative } from "node:path";
import { useMemo } from "react";
import { icon } from "../../core/icons.js";
import type { ChatMessage } from "../../types/index.js";

interface FileEntry {
  path: string;
  editCount: number;
  created: boolean;
}

function useChangedFiles(messages: ChatMessage[]) {
  return useMemo(() => {
    const fileMap = new Map<string, FileEntry>();

    for (const msg of messages) {
      if (msg.role !== "assistant" || !msg.toolCalls) continue;
      for (const tc of msg.toolCalls) {
        if (tc.name === "edit_file" && typeof tc.args.path === "string" && tc.result?.success) {
          const path = tc.args.path as string;
          const existing = fileMap.get(path);
          const isCreate = typeof tc.args.oldString === "string" && tc.args.oldString === "";
          if (existing) {
            existing.editCount++;
            if (isCreate) existing.created = true;
          } else {
            fileMap.set(path, { path, editCount: 1, created: isCreate });
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

  const preview = files.slice(0, 3);
  const remaining = files.length - preview.length;

  return (
    <box height={1} paddingX={1}>
      <text truncate>
        <span fg="#555">{icon("changes")} </span>
        <span fg="#666">{String(files.length)} changed</span>
        <span fg="#333"> │ </span>
        {preview.map((f, i) => (
          <span key={f.path}>
            {i > 0 ? <span fg="#333"> </span> : null}
            <span fg={f.created ? "#5a8" : "#777"}>{basename(f.path)}</span>
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

function flattenTree(
  node: TreeNode,
  depth: number,
): Array<{ depth: number; name: string; file?: FileEntry; isDir: boolean }> {
  const rows: Array<{ depth: number; name: string; file?: FileEntry; isDir: boolean }> = [];
  const sorted = [...node.children.values()].sort((a, b) => {
    const aDir = a.children.size > 0 && !a.file;
    const bDir = b.children.size > 0 && !b.file;
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const child of sorted) {
    const isDir = child.children.size > 0 && !child.file;
    // Collapse single-child directories: src/core/tools → src/core/tools
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
        rows.push(...flattenTree(wrapper, depth));
      } else {
        rows.push({ depth, name: collapsed.name, file: collapsed.file, isDir: false });
      }
    } else {
      rows.push({ depth, name: child.name, file: child.file, isDir });
      if (isDir) rows.push(...flattenTree(child, depth + 1));
    }
  }
  return rows;
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
    return flattenTree(tree, 0);
  }, [files, cwd]);

  return (
    <box flexDirection="column" width="20%" borderStyle="rounded" border={true} borderColor="#222">
      <box
        height={1}
        flexShrink={0}
        paddingX={1}
        backgroundColor="#111"
        alignSelf="flex-start"
        marginTop={-1}
      >
        <text fg="#333">
          {icon("changes")} Changes <span fg="#444">{String(files.length)}</span>
        </text>
      </box>
      {files.length === 0 ? (
        <box paddingX={1} paddingY={1}>
          <text fg="#444">No changes yet</text>
        </box>
      ) : (
        <scrollbox flexGrow={1} flexShrink={1} minHeight={0}>
          {rows.map((row, i) => {
            const indent = "  ".repeat(row.depth);
            if (row.isDir) {
              return (
                <box key={`d-${row.name}-${String(i)}`} paddingX={1} height={1}>
                  <text truncate>
                    <span fg="#333">{indent}</span>
                    <span fg="#555">{row.name}/</span>
                  </text>
                </box>
              );
            }
            const f = row.file;
            const created = f?.created ?? false;
            return (
              <box key={f?.path ?? `f-${String(i)}`} paddingX={1} height={1}>
                <text truncate>
                  <span fg="#333">{indent}</span>
                  <span fg={created ? "#5a8" : "#777"}>{created ? "+" : "~"} </span>
                  <span fg={created ? "#5a8" : "#999"}>{row.name}</span>
                  {f && f.editCount > 1 && <span fg="#444"> ×{String(f.editCount)}</span>}
                </text>
              </box>
            );
          })}
        </scrollbox>
      )}
    </box>
  );
}
