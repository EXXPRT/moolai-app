const FIXTURE_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";

/** Live screen help photographs the study material, not Moolai's own window. Fixture mode never takes
 * a real screenshot (FU1-11). */
export function captureOptions(mode: string) {
  return mode === "fixture"
    ? { fixtureCapture: async () => ({ mimeType: "image/png", bytes: Uint8Array.from(Buffer.from(FIXTURE_PNG, "base64")) }) }
    : { captureExclusions: { bundleIds: ["com.github.Electron"], label: "the Moolai window" } };
}
