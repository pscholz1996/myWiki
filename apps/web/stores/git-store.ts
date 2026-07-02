import { create } from "zustand";
import type { GitFileStatus } from "@/lib/git/git-client";
import {
  fetchGitInfo,
  fetchGitStatus,
  stageFiles,
  unstageFiles,
  commitChanges,
  pullChanges,
  pushChanges,
  fetchGitLog,
  fetchCommitDetail,
  restoreFileAt,
} from "@/lib/git/git-client";
import type { GitLogEntry } from "@/lib/git/git-log-format";
import type { GitCommitFileEntry } from "@/lib/git/commit-detail-format";
import type { ParsedDiff } from "@/lib/git/diff-format";

const HISTORY_PAGE_SIZE = 20;

interface GitCommitDetail {
  commit: GitLogEntry | null;
  files: GitCommitFileEntry[];
}

interface GitState {
  // Info
  isGitRepo: boolean;
  branch: string | null;
  remote: string | null;
  lastCommit: {
    hash: string;
    message: string;
    author: string;
    date: string;
  } | null;
  ahead: number;
  behind: number;

  // Status
  fileStatuses: Map<string, GitFileStatus>;
  stagedCount: number;
  modifiedCount: number;
  untrackedCount: number;

  // Loading
  loading: boolean;
  error: string | null;
  actionLoading: boolean;

  // History
  history: GitLogEntry[];
  historyOffset: number;
  historyHasMore: boolean;
  historyLoading: boolean;
  historyLoadingMore: boolean;
  expandedCommit: string | null;
  commitDetail: Map<string, GitCommitDetail>;
  diffCache: Map<string, ParsedDiff & { path: string }>;

  // Actions
  loadInfo: () => Promise<void>;
  loadStatus: () => Promise<void>;
  refresh: () => Promise<void>;
  stageFile: (path: string) => Promise<void>;
  unstageFile: (path: string) => Promise<void>;
  commit: (message: string) => Promise<string>;
  pull: () => Promise<string>;
  push: () => Promise<string>;
  loadHistory: (reset?: boolean) => Promise<void>;
  toggleExpandCommit: (hash: string) => Promise<void>;
  loadDiff: (hash: string, path: string) => Promise<ParsedDiff & { path: string }>;
  restoreFile: (hash: string, path: string) => Promise<void>;
}

export const useGitStore = create<GitState>((set, get) => ({
  isGitRepo: false,
  branch: null,
  remote: null,
  lastCommit: null,
  ahead: 0,
  behind: 0,
  fileStatuses: new Map(),
  stagedCount: 0,
  modifiedCount: 0,
  untrackedCount: 0,
  loading: false,
  error: null,
  actionLoading: false,

  history: [],
  historyOffset: 0,
  historyHasMore: false,
  historyLoading: false,
  historyLoadingMore: false,
  expandedCommit: null,
  commitDetail: new Map(),
  diffCache: new Map(),

  async loadInfo() {
    try {
      const info = await fetchGitInfo();
      set({
        isGitRepo: info.isGitRepo,
        branch: info.branch,
        remote: info.remote,
        lastCommit: info.lastCommit,
        ahead: info.ahead,
        behind: info.behind,
      });
    } catch (error) {
      set({
        error:
          error instanceof Error ? error.message : "Failed to load git info",
      });
    }
  },

  async loadStatus() {
    try {
      const status = await fetchGitStatus();
      const map = new Map<string, GitFileStatus>();
      for (const f of status.files) {
        map.set(f.path, f.status);
      }
      set({
        isGitRepo: status.isGitRepo,
        fileStatuses: map,
        stagedCount: status.stagedCount,
        modifiedCount: status.modifiedCount,
        untrackedCount: status.untrackedCount,
      });
    } catch (error) {
      set({
        error:
          error instanceof Error ? error.message : "Failed to load git status",
      });
    }
  },

  async refresh() {
    set({ loading: true, error: null });
    await Promise.all([get().loadInfo(), get().loadStatus()]);
    set({ loading: false });
  },

  async stageFile(path: string) {
    set({ actionLoading: true, error: null });
    try {
      await stageFiles([path]);
      await get().loadStatus();
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to stage file",
      });
    } finally {
      set({ actionLoading: false });
    }
  },

  async unstageFile(path: string) {
    set({ actionLoading: true, error: null });
    try {
      await unstageFiles([path]);
      await get().loadStatus();
    } catch (error) {
      set({
        error:
          error instanceof Error ? error.message : "Failed to unstage file",
      });
    } finally {
      set({ actionLoading: false });
    }
  },

  async commit(message: string) {
    set({ actionLoading: true, error: null });
    try {
      const result = await commitChanges(message);
      await Promise.all([get().refresh(), get().loadHistory(true)]);
      return result.output;
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Failed to commit";
      set({ error: msg });
      throw error;
    } finally {
      set({ actionLoading: false });
    }
  },

  async pull() {
    set({ actionLoading: true, error: null });
    try {
      const result = await pullChanges();
      await get().refresh();
      return result.output;
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Failed to pull";
      set({ error: msg });
      throw error;
    } finally {
      set({ actionLoading: false });
    }
  },

  async push() {
    set({ actionLoading: true, error: null });
    try {
      const result = await pushChanges();
      await get().refresh();
      return result.output;
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Failed to push";
      set({ error: msg });
      throw error;
    } finally {
      set({ actionLoading: false });
    }
  },

  async loadHistory(reset = true) {
    const offset = reset ? 0 : get().historyOffset;
    set(
      reset
        ? { historyLoading: true, error: null }
        : { historyLoadingMore: true, error: null },
    );
    try {
      const result = await fetchGitLog(offset, HISTORY_PAGE_SIZE);
      set((state) => ({
        history: reset ? result.commits : [...state.history, ...result.commits],
        historyOffset: offset + result.commits.length,
        historyHasMore: result.hasMore,
      }));
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to load history",
      });
    } finally {
      set({ historyLoading: false, historyLoadingMore: false });
    }
  },

  async toggleExpandCommit(hash: string) {
    const state = get();
    if (state.expandedCommit === hash) {
      set({ expandedCommit: null });
      return;
    }

    set({ expandedCommit: hash });
    if (state.commitDetail.has(hash)) return;

    try {
      const detail = await fetchCommitDetail(hash);
      set((s) => {
        const next = new Map(s.commitDetail);
        next.set(hash, { commit: detail.commit, files: detail.files });
        return { commitDetail: next };
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to load commit",
      });
    }
  },

  async loadDiff(hash: string, path: string) {
    const key = `${hash}:${path}`;
    const cached = get().diffCache.get(key);
    if (cached) return cached;

    const detail = await fetchCommitDetail(hash, path);
    const diff = detail.diff ?? { binary: false, lines: [], path };
    set((s) => {
      const next = new Map(s.diffCache);
      next.set(key, diff);
      return { diffCache: next };
    });
    return diff;
  },

  async restoreFile(hash: string, path: string) {
    set({ actionLoading: true, error: null });
    try {
      await restoreFileAt(hash, path);
      await get().loadStatus();
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to restore file",
      });
      throw error;
    } finally {
      set({ actionLoading: false });
    }
  },
}));
