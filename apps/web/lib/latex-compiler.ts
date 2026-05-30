export interface CompileResult {
  data: Uint8Array;
  buildId: string | null;
}

export async function compileLatex(): Promise<CompileResult> {
  const response = await fetch("/api/compile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const message = data.details
      ? `${data.error}\n\n${data.details}`
      : data.error || "Compilation failed";
    throw new Error(message);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buildId = response.headers.get("x-build-id");
  return {
    data: new Uint8Array(arrayBuffer),
    buildId: buildId && buildId.length > 0 ? buildId : null,
  };
}
