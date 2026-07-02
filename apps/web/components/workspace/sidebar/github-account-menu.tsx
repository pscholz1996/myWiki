"use client";

import { useEffect, useState } from "react";
import { GithubIcon, RocketIcon, ExternalLinkIcon, LogOutIcon } from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { useGithubStore } from "@/stores/github-store";
import { useGitStore } from "@/stores/git-store";
import { remoteToHttpsUrl } from "@/lib/git/git-remote-url";
import { GhLoginDialog } from "./gh-login-dialog";
import { GithubPublishDialog } from "./github-publish-dialog";

export function GithubAccountMenu() {
  const installed = useGithubStore((s) => s.installed);
  const authenticated = useGithubStore((s) => s.authenticated);
  const user = useGithubStore((s) => s.user);
  const checkStatus = useGithubStore((s) => s.checkStatus);
  const logout = useGithubStore((s) => s.logout);

  const isGitRepo = useGitStore((s) => s.isGitRepo);
  const remote = useGitStore((s) => s.remote);
  const githubUrl = remoteToHttpsUrl(remote);

  const [loginOpen, setLoginOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);

  useEffect(() => {
    void checkStatus();
  }, [checkStatus]);

  const handleLogout = async () => {
    try {
      await logout();
      toast.success("Signed out of GitHub");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to sign out");
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            title={
              authenticated && user
                ? `Signed in as @${user.login}`
                : "GitHub account"
            }
          >
            {authenticated && user?.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={user.avatarUrl}
                alt=""
                className="size-4 rounded-full"
              />
            ) : (
              <GithubIcon className="size-3.5" />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          {!installed ? (
            <>
              <DropdownMenuLabel className="text-muted-foreground text-xs">
                GitHub CLI not installed
              </DropdownMenuLabel>
              <DropdownMenuItem asChild>
                <a
                  href="https://cli.github.com"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLinkIcon className="mr-2 size-4" />
                  Install gh
                </a>
              </DropdownMenuItem>
            </>
          ) : !authenticated ? (
            <DropdownMenuItem onSelect={() => setLoginOpen(true)}>
              <GithubIcon className="mr-2 size-4" />
              Sign in with GitHub
            </DropdownMenuItem>
          ) : (
            <>
              <DropdownMenuLabel className="truncate text-muted-foreground text-xs">
                Signed in as @{user?.login}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {isGitRepo && !remote && (
                <DropdownMenuItem onSelect={() => setPublishOpen(true)}>
                  <RocketIcon className="mr-2 size-4" />
                  Publish to GitHub…
                </DropdownMenuItem>
              )}
              {githubUrl && (
                <DropdownMenuItem asChild>
                  <a href={githubUrl} target="_blank" rel="noopener noreferrer">
                    <ExternalLinkIcon className="mr-2 size-4" />
                    Open on GitHub
                  </a>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => void handleLogout()}>
                <LogOutIcon className="mr-2 size-4" />
                Sign out
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <GhLoginDialog open={loginOpen} onClose={() => setLoginOpen(false)} />
      <GithubPublishDialog
        open={publishOpen}
        onClose={() => setPublishOpen(false)}
      />
    </>
  );
}
