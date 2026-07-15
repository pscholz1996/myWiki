"use client";

import { useEffect, useState } from "react";
import { LogOutIcon } from "lucide-react";
import { SiClaude } from "@icons-pack/react-simple-icons";
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
import { useClaudeAuthStore } from "@/stores/claude-auth-store";
import { ClaudeLoginDialog } from "./claude-login-dialog";

export function ClaudeAccountMenu() {
  const loggedIn = useClaudeAuthStore((s) => s.loggedIn);
  const email = useClaudeAuthStore((s) => s.email);
  const subscriptionType = useClaudeAuthStore((s) => s.subscriptionType);
  const checkStatus = useClaudeAuthStore((s) => s.checkStatus);
  const logout = useClaudeAuthStore((s) => s.logout);

  const [loginOpen, setLoginOpen] = useState(false);

  useEffect(() => {
    void checkStatus();
  }, [checkStatus]);

  const handleLogout = async () => {
    try {
      await logout();
      toast.success("Signed out of Claude");
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
            className="size-7"
            title={
              loggedIn && email
                ? `Signed in to Claude as ${email}`
                : "Claude account"
            }
          >
            <SiClaude
              className="size-5"
              color={loggedIn ? "#D97757" : "currentColor"}
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          {!loggedIn ? (
            <DropdownMenuItem onSelect={() => setLoginOpen(true)}>
              <SiClaude className="mr-2 size-4" color="#D97757" />
              Sign in with Claude
            </DropdownMenuItem>
          ) : (
            <>
              <DropdownMenuLabel className="truncate text-muted-foreground text-xs">
                {email ?? "Signed in"}
                {subscriptionType ? ` · ${subscriptionType}` : ""}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void handleLogout()}>
                <LogOutIcon className="mr-2 size-4" />
                Sign out
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <ClaudeLoginDialog open={loginOpen} onClose={() => setLoginOpen(false)} />
    </>
  );
}
