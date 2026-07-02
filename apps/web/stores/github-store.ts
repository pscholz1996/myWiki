import { create } from "zustand";
import type { GhUser } from "@/lib/git/gh-client";
import {
  fetchGhStatus,
  ghLogout,
  publishToGithub,
  streamGhLogin,
} from "@/lib/git/gh-client";

interface GithubState {
  installed: boolean;
  checking: boolean;
  version: string | null;
  authenticated: boolean;
  user: GhUser | null;

  loginInProgress: boolean;
  loginCode: string | null;
  loginUrl: string | null;
  loginError: string | null;
  loginFallback: boolean;

  publishing: boolean;
  error: string | null;

  checkStatus: () => Promise<void>;
  login: () => Promise<void>;
  cancelLogin: () => void;
  logout: () => Promise<void>;
  publish: (params: {
    name: string;
    description?: string;
    visibility: "public" | "private";
  }) => Promise<{ url: string | null }>;
}

let loginAbortController: AbortController | null = null;

export const useGithubStore = create<GithubState>((set, get) => ({
  installed: true,
  checking: false,
  version: null,
  authenticated: false,
  user: null,

  loginInProgress: false,
  loginCode: null,
  loginUrl: null,
  loginError: null,
  loginFallback: false,

  publishing: false,
  error: null,

  async checkStatus() {
    set({ checking: true, error: null });
    try {
      const status = await fetchGhStatus();
      set({
        installed: status.installed,
        version: status.version,
        authenticated: status.authenticated,
        user: status.user,
      });
    } catch (error) {
      set({
        error:
          error instanceof Error ? error.message : "Failed to check GitHub CLI status",
      });
    } finally {
      set({ checking: false });
    }
  },

  async login() {
    loginAbortController?.abort();
    const controller = new AbortController();
    loginAbortController = controller;

    set({
      loginInProgress: true,
      loginCode: null,
      loginUrl: null,
      loginError: null,
      loginFallback: false,
    });

    try {
      await streamGhLogin((event) => {
        if (event.type === "code") {
          set({ loginCode: event.code, loginUrl: event.url });
        } else if (event.type === "success") {
          set({ loginInProgress: false });
          void get().checkStatus();
        } else if (event.type === "error") {
          set({
            loginInProgress: false,
            loginError: event.message,
            loginFallback: event.fallback,
          });
        }
      }, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) return;
      set({
        loginInProgress: false,
        loginError: error instanceof Error ? error.message : "Sign-in failed",
        loginFallback: true,
      });
    } finally {
      set({ loginInProgress: false });
    }
  },

  cancelLogin() {
    loginAbortController?.abort();
    set({
      loginInProgress: false,
      loginCode: null,
      loginUrl: null,
      loginError: null,
      loginFallback: false,
    });
  },

  async logout() {
    set({ error: null });
    try {
      await ghLogout();
      set({ authenticated: false, user: null });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to sign out",
      });
      throw error;
    }
  },

  async publish(params) {
    set({ publishing: true, error: null });
    try {
      const result = await publishToGithub(params);
      return { url: result.url };
    } catch (error) {
      set({
        error:
          error instanceof Error ? error.message : "Failed to publish to GitHub",
      });
      throw error;
    } finally {
      set({ publishing: false });
    }
  },
}));
