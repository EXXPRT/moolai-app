const { resolve, relative, isAbsolute } = require("node:path");

// Only the built UI can be served by the desktop's private protocol.
function localContentPath(url, directory) {
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "moolai:" ||
      parsed.hostname !== "app" ||
      parsed.port ||
      parsed.username ||
      parsed.password
    )
      return null;
    const pathname = decodeURIComponent(parsed.pathname);
    if (pathname.includes("\\") || pathname.includes("\0")) return null;
    const root = resolve(directory);
    const file = resolve(
      root,
      `.${pathname === "/" ? "/index.html" : pathname}`,
    );
    const within = relative(root, file);
    return within && !within.startsWith("..") && !isAbsolute(within)
      ? file
      : null;
  } catch {
    return null;
  }
}

function trustedFrame(event, contents, documentURL) {
  return Boolean(
    contents &&
      event.sender === contents &&
      event.senderFrame === contents.mainFrame &&
      event.senderFrame?.url === documentURL,
  );
}

// Paths selected by the user are granted through a separate native dialog IPC.
// In particular, the renderer cannot grant an arbitrary local path.
function allowedRequest(method, path) {
  if (method === "GET")
    return (
      ["/api/state", "/api/native", "/api/local-folders"].includes(path) ||
      /^\/api\/(related|attachment)\/[a-zA-Z0-9._-]+$/.test(path)
    );
  if (method !== "POST") return false;
  return (
    [
      "/api/session", "/api/input", "/api/end", "/api/end/resolve",
      "/api/subject", "/api/retry", "/api/speech/stop", "/api/response/cancel", "/api/voice",
      "/api/local-folders/revoke",
    ].includes(path) || /^\/api\/record\/[a-zA-Z0-9_-]+$/.test(path)
  );
}

function externalURL(value) {
  if(typeof value!=="string" || value.length>8192 || /[\u0000-\u0020]/.test(value)) return null;
  try {
    const url=new URL(value);
    return ["https:","http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {return null;}
}
module.exports = { localContentPath, trustedFrame, allowedRequest, externalURL };
