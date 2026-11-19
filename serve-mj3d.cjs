/* 极简静态服务：只为预览 mj3d.html（不参与游戏构建） */
const http = require("http");
const fs = require("fs");
const path = require("path");
const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8899);
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".css": "text/css", ".json": "application/json" };
http.createServer((req, res) => {
  let u = decodeURIComponent((req.url || "/").split("?")[0]);
  if (u === "/") u = "/mj3d.html";
  const fp = path.join(ROOT, u);
  if (!fp.startsWith(ROOT)) { res.statusCode = 403; return res.end("forbidden"); }
  fs.readFile(fp, (e, d) => {
    if (e) { res.statusCode = 404; return res.end("not found"); }
    res.setHeader("Content-Type", MIME[path.extname(fp).toLowerCase()] || "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    res.end(d);
  });
}).listen(PORT, "127.0.0.1", () => console.log("mj3d server: http://127.0.0.1:" + PORT + "/mj3d.html"));
