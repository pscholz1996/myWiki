"use client";

import { useEffect, useRef, useState } from "react";
import { CheckIcon, Loader2Icon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useClaudeAuthStore } from "@/stores/claude-auth-store";

export function ClaudeLoginDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const loggedIn = useClaudeAuthStore((s) => s.loggedIn);
  const loginUrl = useClaudeAuthStore((s) => s.loginUrl);
  const loginError = useClaudeAuthStore((s) => s.loginError);
  const loginFallback = useClaudeAuthStore((s) => s.loginFallback);
  const login = useClaudeAuthStore((s) => s.login);
  const submitCode = useClaudeAuthStore((s) => s.submitCode);
  const cancelLogin = useClaudeAuthStore((s) => s.cancelLogin);

  const [code, setCode] = useState("");
  const [codeSubmitted, setCodeSubmitted] = useState(false);
  const openedBrowserRef = useRef(false);
  const startedRef = useRef(false);

  useEffect(() => {
    if (!open) {
      startedRef.current = false;
      openedBrowserRef.current = false;
      setCode("");
      setCodeSubmitted(false);
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
    if (open && loggedIn) {
      const timeout = setTimeout(onClose, 1200);
      return () => clearTimeout(timeout);
    }
  }, [open, loggedIn, onClose]);

  // A failed code (or any other CLI error) surfaces via loginError — let the
  // user try pasting again instead of getting stuck on "verifying forever".
  useEffect(() => {
    if (loginError) setCodeSubmitted(false);
  }, [loginError]);

  const handleClose = () => {
    cancelLogin();
    onClose();
  };

  const handleSubmitCode = async () => {
    if (!code.trim()) return;
    setCodeSubmitted(true);
    await submitCode(code.trim());
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && handleClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Sign in with Claude</DialogTitle>
          <DialogDescription>
            Uses the Claude CLI's own sign-in — myWiki never sees your password.
          </DialogDescription>
        </DialogHeader>

        {loggedIn ? (
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
                  claude auth login
                </code>
                , complete sign-in there, then click Refresh here.
              </div>
            )}
          </div>
        ) : loginUrl && codeSubmitted ? (
          <div className="flex items-center justify-center gap-2 py-6 text-muted-foreground text-sm">
            <Loader2Icon className="size-4 animate-spin" />
            Verifying…
          </div>
        ) : loginUrl ? (
          <div className="flex flex-col items-center gap-3 py-2">
            <div className="text-muted-foreground text-xs">
              A browser tab should have opened. If not, go to
            </div>
            <a
              href={loginUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="break-all text-primary text-sm underline underline-offset-2"
            >
              {loginUrl}
            </a>
            <div className="text-center text-muted-foreground text-xs">
              After approving there, paste the code it gives you back here:
            </div>
            <div className="flex w-full items-center gap-2">
              <Input
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="Paste code…"
                className="h-8 text-xs"
                autoFocus
                onKeyDown={(event) => {
                  if (event.key === "Enter") void handleSubmitCode();
                }}
              />
              <Button
                size="sm"
                onClick={() => void handleSubmitCode()}
                disabled={!code.trim()}
              >
                Submit
              </Button>
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
          ) : !loggedIn ? (
            <Button variant="ghost" size="sm" onClick={handleClose}>
              Cancel
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
