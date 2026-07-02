import type { GitFileStatus } from "@/app/api/git/status/route";

export function statusLabel(status: GitFileStatus): string {
  switch (status) {
    case "staged":
      return "A";
    case "staged-modified":
      return "M";
    case "staged-deleted":
      return "D";
    case "modified":
      return "M";
    case "deleted":
      return "D";
    case "untracked":
      return "?";
    case "renamed":
      return "R";
    case "conflicted":
      return "C";
    default:
      return "?";
  }
}

export function statusColor(status: GitFileStatus): string {
  switch (status) {
    case "staged":
    case "staged-modified":
    case "staged-deleted":
    case "renamed":
      return "text-green-500";
    case "modified":
      return "text-yellow-500";
    case "deleted":
      return "text-red-400";
    case "untracked":
      return "text-green-700 dark:text-green-400";
    case "conflicted":
      return "text-red-500";
    default:
      return "text-muted-foreground";
  }
}
