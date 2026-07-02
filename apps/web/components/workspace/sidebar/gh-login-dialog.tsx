"use client";

import { useEffect, useRef, useState } from "react";
import { CheckIcon, CopyIcon, Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useGithubStore } from "@/stores/github-store";

export function GhLoginDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const authenticated = useGithubStore((s) => s.authenticated);
  const loginCode = useGithubStore((s) => s.loginCode);
  const loginUrl = useGithubStore((s) => s.loginUrl);
  const loginError = useGithubStore((s) => s.loginError);
  const loginFallback = useGithubStore((s) => s.loginFallback);
  const login = useGithubStore((s) => s.login);
  const cancelLogin = useGithubStore((s) => s.cancelLogin);

  const [copied, setCopied] = useState(false);
  const openedBrowserRef = useRef(false);
  const startedRef = useRef(false);

  useEffect(() => {
    if (!open) {
      startedRef.current = false;
      openedBrowserRef.current = false;
      return;
    }
    if (startedRef.current) return;
    startedRef.current = true;
    void login();
  }, [open, login]);

  useEffect(() => {
    if (loginUrl && !openedBrowserRef.current) {
      openedBrowserRef.current = true;
      window.open(loginUrl, "_blank", "noopener,noreferrer");
    }
  }, [loginUrl]);

  useEffect(() => {
    if (open && authenticated) {
      const timeout = setTimeout(onClose, 1200);
      return () => clearTimeout(timeout);
    }
  }, [open, authenticated, onClose]);

  const handleCopy = async () => {
    if (!loginCode) return;
    try {
      await navigator.clipboard.writeText(loginCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy — select and copy the code manually.");
    }
  };

  const handleClose = () => {
    cancelLogin();
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && handleClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Sign in with GitHub</DialogTitle>
          <DialogDescription>
            Uses the GitHub CLI's own device sign-in — OpenLatex never sees
            your password.
          </DialogDescription>
        </DialogHeader>

        {authenticated ? (
          <div className="flex flex-col items-center gap-2 py-4">
            <CheckIcon className="size-8 text-green-500" />
            <div className="text-sm">Signed in</div>
          </div>
        ) : loginError ? (
          <div className="flex flex-col gap-2 py-2 text-sm">
            <div className="text-destructive">{loginError}</div>
            {loginFallback && (
              <div className="rounded-md border bg-muted/30 p-3 text-muted-foreground text-xs">
                Open a terminal, run{" "}
                <code className="rounded bg-muted px-1 py-0.5 font-mono">
                  gh auth login
                </code>
                , complete sign-in there, then click Refresh here.
              </div>
            )}
          </div>
        ) : loginCode && loginUrl ? (
          <div className="flex flex-col items-center gap-3 py-2">
            <div className="text-muted-foreground text-xs">
              A browser tab should have opened. If not, go to
            </div>
            <a
              href={loginUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary text-sm underline underline-offset-2"
            >
              {loginUrl}
            </a>
            <div className="flex items-center gap-2 rounded-md border px-3 py-2">
              <span className="font-mono text-lg tracking-widest">
                {loginCode}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                onClick={() => void handleCopy()}
                title="Copy code"
              >
                {copied ? (
                  <CheckIcon className="size-3.5 text-green-500" />
                ) : (
                  <CopyIcon className="size-3.5" />
                )}
              </Button>
            </div>
            <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
              <Loader2Icon className="size-3 animate-spin" />
              Waiting for authorization…
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center gap-2 py-6 text-muted-foreground text-sm">
            <Loader2Icon className="size-4 animate-spin" />
            Starting…
          </div>
        )}

        <DialogFooter>
          {loginError ? (
            <Button
              size="sm"
              onClick={() => {
                startedRef.current = false;
                void login();
              }}
            >
              Retry
            </Button>
          ) : !authenticated ? (
            <Button variant="ghost" size="sm" onClick={handleClose}>
              Cancel
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
