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
} from "@/lib/git/git-client";

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

  // Actions
  loadInfo: () => Promise<void>;
  loadStatus: () => Promise<void>;
  refresh: () => Promise<void>;
  stageFile: (path: string) => Promise<void>;
  unstageFile: (path: string) => Promise<void>;
  commit: (message: string) => Promise<string>;
  pull: () => Promise<string>;
  push: () => Promise<string>;
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
        error: error instanceof Error ? error.message : "Failed to load git info",
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
      await get().refresh();
      return result.output;
    } catch (error) {
      const msg =
        error instanceof Error ? error.message : "Failed to commit";
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
}));
