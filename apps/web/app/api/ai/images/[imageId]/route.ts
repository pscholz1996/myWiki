import { NextResponse } from "next/server";
import { getProjectDir, NoProjectSelectedError } from "@/lib/fs/project-dir";
import { getImageRecord, readImagePng } from "@/lib/ai/images";

export const dynamic = "force-dynamic";

/**
 * Serves a registered source image (page render, slide media, crop, or
 * annotated variant) by id. The attribution is exposed as a response header
 * so the chat UI can caption images without a second round trip.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ imageId: string }> },
) {
  const { imageId } = await params;

  let projectDir: string;
  try {
    projectDir = getProjectDir();
  } catch (error) {
    if (error instanceof NoProjectSelectedError) {
      return NextResponse.json({ error: "no-project" }, { status: 400 });
    }
    throw error;
  }

  const [record, png] = await Promise.all([
    getImageRecord(projectDir, imageId),
    readImagePng(projectDir, imageId),
  ]);
  if (!record || !png) {
    return NextResponse.json({ error: "not-found" }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(png), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Image-Attribution": encodeURIComponent(record.attribution),
    },
  });
}
