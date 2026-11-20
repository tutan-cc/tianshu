// 本机试玩服务。只提供游戏页面、脚本和资源，支持视频分段加载。
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = fs.realpathSync(__dirname);
const host = "127.0.0.1";
const port = 8790;
const trial = "http://" + host + ":" + port + "/index.html?walk=1";
const wantsBrowser = process.argv.includes("--open");

const pages = new Set([
  "index.html", "城市漫游试玩.html", "three.min.js", "mahjong.js",
  "city-walk.js", "city-vegetation.js", "map3d.js", "breakfast-rig.js",
  "breakfast.js", "jade.js", "slash.js", "clockout.js", "nlroute.js",
]);
const assetFolders = new Set(["art", "audio", "video"]);
const mime = {
  ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8",
  ".css":"text/css; charset=utf-8", ".json":"application/json", ".svg":"image/svg+xml",
  ".png":"image/png", ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".webp":"image/webp",
  ".gif":"image/gif", ".avif":"image/avif", ".ico":"image/x-icon",
  ".mp4":"video/mp4", ".webm":"video/webm", ".ogg":"audio/ogg", ".ogv":"video/ogg",
  ".mp3":"audio/mpeg", ".wav":"audio/wav", ".m4a":"audio/mp4", ".vtt":"text/vtt",
  ".glb":"model/gltf-binary", ".gltf":"model/gltf+json", ".bin":"application/octet-stream",
};

function isPublic(relativeName) {
  if (pages.has(relativeName)) return true;
  const parts = relativeName.split("/");
  return parts.length > 1 && assetFolders.has(parts[0]) &&
    parts.every(part => part && !part.startsWith(".")) &&
    Object.hasOwn(mime, path.extname(relativeName).toLowerCase());
}

function byteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!size || !match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  return Number.isSafeInteger(start) && start <= end ? { start, end } : null;
}

async function serve(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  let name;
  try {
    const pathname = new URL(req.url, trial).pathname;
    name = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (!isPublic(name) || /[:\\\0]/.test(name)) {
    res.writeHead(404).end();
    return;
  }

  let file, info;
  try {
    file = await fs.promises.realpath(path.join(root, name));
    if (!isPublic(path.relative(root, file).split(path.sep).join("/"))) throw new Error();
    info = await fs.promises.stat(file);
    if (!info.isFile()) throw new Error();
  } catch {
    res.writeHead(404).end();
    return;
  }

  const headers = {
    "Content-Type": mime[path.extname(file).toLowerCase()],
    "Cache-Control": "no-store",
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
    "X-Local-Game": "restart-city",
  };
  const range = req.headers.range && byteRange(req.headers.range, info.size);
  if (req.headers.range && !range) {
    res.writeHead(416, { ...headers, "Content-Range": "bytes */" + info.size }).end();
    return;
  }
  if (range) {
    headers["Content-Range"] = "bytes " + range.start + "-" + range.end + "/" + info.size;
  }
  headers["Content-Length"] = range ? range.end - range.start + 1 : info.size;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === "HEAD" || info.size === 0) {
    res.end();
    return;
  }
  const stream = fs.createReadStream(file, range || undefined);
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

function openBrowser() {
  console.log(trial);
  if (!wantsBrowser) return;
  const browser = spawn("explorer.exe", [trial], { detached: true, stdio: "ignore" });
  browser.on("error", () => console.error("Open the URL above in your browser."));
  browser.unref();
}

const server = http.createServer((req, res) => {
  serve(req, res).catch(() => {
    if (res.headersSent) res.destroy();
    else res.writeHead(500).end();
  });
});
server.on("error", async error => {
  if (error.code === "EADDRINUSE" && wantsBrowser) {
    try {
      const existing = await fetch(trial, { method: "HEAD", signal: AbortSignal.timeout(1500) });
      if (existing.ok && existing.headers.get("X-Local-Game") === "restart-city") {
        openBrowser();
        return;
      }
    } catch {}
  }
  console.error(error.message);
  process.exitCode = 1;
});
server.listen(port, host, openBrowser);
