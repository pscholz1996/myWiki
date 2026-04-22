export async function compileLatex(): Promise<Uint8Array> {
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
  return new Uint8Array(arrayBuffer);
}
