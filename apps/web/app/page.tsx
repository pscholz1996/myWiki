"use client";

import { WorkspaceLayout } from "@/components/workspace/workspace-layout";
import { WelcomeScreen } from "@/components/project/welcome-screen";
import { useCurrentProject } from "@/hooks/use-current-project";

export default function Home() {
  const { current, recent, loading, error } = useCurrentProject();

  if (loading) {
    return (
      <main className="flex h-full items-center justify-center text-muted-foreground text-sm">
        Loading…
      </main>
    );
  }

  if (error) {
    return (
      <main className="flex h-full items-center justify-center text-destructive text-sm">
        Failed to load project state: {error}
      </main>
    );
  }

  if (!current) {
    return (
      <main className="h-full">
        <WelcomeScreen recent={recent} />
      </main>
    );
  }

  return (
    <main className="h-full">
      <WorkspaceLayout current={current} recent={recent} />
    </main>
  );
}
