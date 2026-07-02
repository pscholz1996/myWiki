"use client";

import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";
import { Toaster } from "@/components/ui/sonner";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";

export function RootProvider({ children }: { children: ReactNode }) {
  useKeyboardShortcuts();

  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem>
      {children}
      {/* bottom-right (Sonner's default) collides with the AI panel's
          Send button, which docks to that same corner. */}
      <Toaster position="top-center" />
    </ThemeProvider>
  );
}
