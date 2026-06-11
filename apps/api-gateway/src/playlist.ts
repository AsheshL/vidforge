// Rewrites every media URI in an HLS playlist via the provided signer.
// Variant playlist references (.m3u8) stay relative so they keep flowing
// through the authenticated gateway route; media segments are rewritten
// (in practice, to presigned object-storage URLs).
export async function rewritePlaylist(
  text: string,
  keyDir: string,
  sign: (key: string) => Promise<string>,
): Promise<string> {
  const lines = await Promise.all(
    text.split("\n").map(async (line) => {
      const uri = line.trim();
      if (!uri || uri.startsWith("#") || uri.endsWith(".m3u8")) return line;
      return sign(`${keyDir}${uri}`);
    }),
  );
  return lines.join("\n");
}
