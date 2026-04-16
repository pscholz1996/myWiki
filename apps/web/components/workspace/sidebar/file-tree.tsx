"use client";

import { useState } from "react";
import {
  ChevronRightIcon,
  FileTextIcon,
  FolderIcon,
  ImageIcon,
} from "lucide-react";
import type { FsNode } from "@/lib/fs/fs-client";
import type { GitFileStatus } from "@/lib/git/git-client";
import { cn } from "@/lib/utils";

interface FileTreeProps {
  nodes: FsNode[];
  activePath: string | null;
  onOpen: (path: string) => void;
  fileStatuses?: Map<string, GitFileStatus>;
}

function gitStatusColor(status: GitFileStatus | undefined): string {
  switch (status) {
    case "modified":
      return "text-yellow-500";
    case "staged":
    case "staged-modified":
    case "staged-deleted":
    case "renamed":
      return "text-green-500";
    case "untracked":
      return "text-green-700 dark:text-green-400";
    case "deleted":
      return "text-red-400 line-through";
    case "conflicted":
      return "text-red-500";
    default:
      return "";
  }
}

function gitStatusBadge(status: GitFileStatus | undefined): string | null {
  switch (status) {
    case "modified":
    case "staged-modified":
      return "M";
    case "staged":
      return "A";
    case "untracked":
      return "?";
    case "deleted":
    case "staged-deleted":
      return "D";
    case "renamed":
      return "R";
    case "conflicted":
      return "C";
    default:
      return null;
  }
}

/** Compute the "most severe" git status among all descendants of a directory. */
function dirStatus(
  node: FsNode,
  statuses: Map<string, GitFileStatus>,
): GitFileStatus | undefined {
  const severity: GitFileStatus[] = [
    "conflicted",
    "modified",
    "deleted",
    "staged-modified",
    "staged",
    "staged-deleted",
    "renamed",
    "untracked",
  ];
  let worst: GitFileStatus | undefined;
  let worstIdx = severity.length;

  const stack: FsNode[] = [node];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === "file") {
      const s = statuses.get(n.path);
      if (s) {
        const idx = severity.indexOf(s);
        if (idx !== -1 && idx < worstIdx) {
          worstIdx = idx;
          worst = s;
        }
      }
    } else if (n.children) {
      stack.push(...n.children);
    }
  }
  return worst;
}

export function FileTree({ nodes, activePath, onOpen, fileStatuses }: FileTreeProps) {
  return (
    <ul className="space-y-0.5">
      {nodes.map((node) => (
        <TreeNode
          key={node.path}
          node={node}
          depth={0}
          activePath={activePath}
          onOpen={onOpen}
          fileStatuses={fileStatuses}
        />
      ))}
    </ul>
  );
}

function iconFor(path: string) {
  const lower = path.toLowerCase();
  if (
    lower.endsWith(".png") ||
    lower.endsWith(".jpg") ||
    lower.endsWith(".jpeg")
  ) {
    return <ImageIcon className="size-4 shrink-0 text-muted-foreground" />;
  }
  return <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />;
}

interface TreeNodeProps {
  node: FsNode;
  depth: number;
  activePath: string | null;
  onOpen: (path: string) => void;
  fileStatuses?: Map<string, GitFileStatus>;
}

function TreeNode({ node, depth, activePath, onOpen, fileStatuses }: TreeNodeProps) {
  const [open, setOpen] = useState(depth < 1);
  const name = node.path.split("/").pop() ?? node.path;
  const paddingLeft = depth * 12 + 8;

  if (node.type === "dir") {
    const dStatus = fileStatuses ? dirStatus(node, fileStatuses) : undefined;
    const colorCls = gitStatusColor(dStatus);

    return (
      <li>
        <button
          className="flex w-full items-center gap-1 rounded-md py-1 pr-2 text-left text-sm hover:bg-sidebar-accent/50"
          style={{ paddingLeft }}
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronRightIcon
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
          <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className={cn("truncate", colorCls)}>{name}</span>
        </button>
        {open && node.children && node.children.length > 0 && (
          <ul className="space-y-0.5">
            {node.children.map((child) => (
              <TreeNode
                key={child.path}
                node={child}
                depth={depth + 1}
                activePath={activePath}
                onOpen={onOpen}
                fileStatuses={fileStatuses}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }

  const isActive = node.path === activePath;
  const fileStatus = fileStatuses?.get(node.path);
  const colorCls = gitStatusColor(fileStatus);
  const badge = gitStatusBadge(fileStatus);

  return (
    <li>
      <button
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-sm transition-colors",
          isActive
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "hover:bg-sidebar-accent/50",
        )}
        style={{ paddingLeft: paddingLeft + 18 /* indent past the chevron */ }}
        onClick={() => onOpen(node.path)}
      >
        {iconFor(node.path)}
        <span className={cn("min-w-0 flex-1 truncate", !isActive && colorCls)}>{name}</span>
        {badge && (
          <span className={cn("shrink-0 font-mono text-[10px]", colorCls)}>
            {badge}
          </span>
        )}
      </button>
    </li>
  );
}
