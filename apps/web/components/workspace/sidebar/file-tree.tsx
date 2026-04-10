"use client";

import { useState } from "react";
import {
  ChevronRightIcon,
  FileTextIcon,
  FolderIcon,
  ImageIcon,
} from "lucide-react";
import type { FsNode } from "@/lib/fs/fs-client";
import { cn } from "@/lib/utils";

interface FileTreeProps {
  nodes: FsNode[];
  activePath: string | null;
  onOpen: (path: string) => void;
}

export function FileTree({ nodes, activePath, onOpen }: FileTreeProps) {
  return (
    <ul className="space-y-0.5">
      {nodes.map((node) => (
        <TreeNode
          key={node.path}
          node={node}
          depth={0}
          activePath={activePath}
          onOpen={onOpen}
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
}

function TreeNode({ node, depth, activePath, onOpen }: TreeNodeProps) {
  const [open, setOpen] = useState(depth < 1);
  const name = node.path.split("/").pop() ?? node.path;
  const paddingLeft = depth * 12 + 8;

  if (node.type === "dir") {
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
          <span className="truncate">{name}</span>
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
              />
            ))}
          </ul>
        )}
      </li>
    );
  }

  const isActive = node.path === activePath;
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
        <span className="truncate">{name}</span>
      </button>
    </li>
  );
}
