import { create } from "zustand";
import {
  claudeLogout,
  fetchClaudeAuthStatus,
  streamClaudeLogin,
  submitClaudeLoginCode,
} from "@/lib/ai/claude-auth-client";

interface ClaudeAuthState {
  checking: boolean;
  loggedIn: boolean;
  email: string | null;
  organization: string | null;
  subscriptionType: string | null;

  loginInProgress: boolean;
  loginId: string | null;
  loginUrl: string | null;
  loginError: string | null;
  loginFallback: boolean;

  error: string | null;

  checkStatus: () => Promise<void>;
  login: () => Promise<void>;
  submitCode: (code: string) => Promise<void>;
  cancelLogin: () => void;
  logout: () => Promise<void>;
}

let loginAbortController: AbortController | null = null;

export const useClaudeAuthStore = create<ClaudeAuthState>((set, get) => ({
  checking: false,
  loggedIn: false,
  email: null,
  organization: null,
  subscriptionType: null,

  loginInProgress: false,
  loginId: null,
  loginUrl: null,
  loginError: null,
  loginFallback: false,

  error: null,

  async checkStatus() {
    set({ checking: true, error: null });
    try {
      const status = await fetchClaudeAuthStatus();
      set({
        loggedIn: status.loggedIn,
        email: status.email,
        organization: status.organization,
        subscriptionType: status.subscriptionType,
      });
    } catch (error) {
      set({
        error:
          error instanceof Error
            ? error.message
            : "Failed to check Claude sign-in status",
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
      loginId: null,
      loginUrl: null,
      loginError: null,
      loginFallback: false,
    });

    try {
      await streamClaudeLogin((event) => {
        if (event.type === "login-id") {
          set({ loginId: event.loginId });
        } else if (event.type === "url") {
          set({ loginUrl: event.url });
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

  async submitCode(code: string) {
    const { loginId } = get();
    if (!loginId) return;
    try {
      await submitClaudeLoginCode(loginId, code);
    } catch (error) {
      set({
        loginError:
          error instanceof Error ? error.message : "Failed to submit code",
        loginFallback: false,
      });
    }
  },

  cancelLogin() {
    loginAbortController?.abort();
    set({
      loginInProgress: false,
      loginId: null,
      loginUrl: null,
      loginError: null,
      loginFallback: false,
    });
  },

  async logout() {
    set({ error: null });
    try {
      await claudeLogout();
      set({
        loggedIn: false,
        email: null,
        organization: null,
        subscriptionType: null,
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to sign out",
      });
      throw error;
    }
  },
}));
