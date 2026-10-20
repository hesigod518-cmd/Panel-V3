"use strict";
/* ------------------------------------------------------------------ *
 * 3x-ui-katabump  —  MHSanaei 3x-ui + Xray + Sub behind 1 port       *
 * Two-file edition: index.js + package.json.  No npm dependencies.   *
 *                                                                    *
 * Layout under the KataBump root (persistent):                       *
 *   3x-ui/app        x-ui binary & helper scripts                    *
 *   3x-ui/bin        xray-core + mtg + geoip/geosite assets          *
 *   3x-ui/data       SQLite database x-ui.db (persistent!)           *
 *   3x-ui/certs      self-signed TLS cert for optional TLS inbounds  *
 *   3x-ui/log        panel & xray logs                               *
 *   3x-ui/PANEL.txt  saved credentials, links, and subscription URL  *
 * ------------------------------------------------------------------ */

require("v8").setFlagsFromString("--max-old-space-size=48");
const releaseMemory = () => {
  if (typeof global.gc === "function") {
    try {
      global.gc();
    } catch (e) {}
  }
};

const net = require("net");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

/* ------------------------------ config ---------------------------- */

const WRAPPER = "3x-ui-katabump-1.0";
const UA = "3x-ui-katabump/1.0";
const REPO = "MHSanaei/3x-ui";

const XUI_VERSION = process.env.XUI_VERSION || "v3.10.2";
const STATUS_PATH = "/_kb/status";
const TUNNEL_DEFAULT = "vless:/vless-ws:21001,vless:/mb-vless:21001";
const DEFAULT_INBOUND_REMARK = process.env.XUI_INBOUND_REMARK || "Katabump-VLESS-WS";
const DEFAULT_CLIENT_EMAIL = process.env.XUI_CLIENT_EMAIL || "katabump";
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "";

const ROOT = process.env.KATABUMP_ROOT || process.env.KATABUMP_DIR || process.cwd();
const BASE = path.join(ROOT, "3x-ui");
const APP = path.join(BASE, "app");
const BIN_DIR = path.join(BASE, "bin");
const DATA = path.join(BASE, "data");
const CERT_DIR = path.join(BASE, "certs");
const LOGS = path.join(BASE, "log");
const TMP = path.join(BASE, "tmp");
const STATE_FILE = path.join(BASE, "state.json");
const CRED_FILE = path.join(BASE, "PANEL.txt");
const VERSION_FILE = path.join(APP, ".version");

const SKIP_XRAY = process.env.XUI_SKIP_XRAY === "1";
const FORCE_SETUP = process.env.XUI_FORCE_SETUP === "1";
const KEEP_RU_DAT = process.env.XUI_KEEP_RU_DAT === "1";
const AUTO_HOST_SYNC = process.env.XUI_AUTO_HOST_SYNC !== "0";
const PANEL_MEM_MAX = int(process.env.XUI_PANEL_MEM_MAX, 225); // MB ceiling before graceful restart
const PUBLIC_HOST_ENV = (
  process.env.XUI_PUBLIC_HOST ||
  process.env.PASARGUARD_PUBLIC_HOST ||
  process.env.PUBLIC_HOST ||
  ""
).trim();

/* ------------------------------ ports ----------------------------- */

function int(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}

function firstFreePort(candidates) {
  return new Promise((resolve) => {
    let i = 0;
    const tryNext = () => {
      if (i >= candidates.length) return resolve(candidates[candidates.length - 1]);
      const port = candidates[i++];
      const srv = net.createServer();
      srv.once("error", () => {
        try {
          srv.close();
        } catch (e) {}
        tryNext();
      });
      srv.once("listening", () => srv.close(() => resolve(port)));
      srv.listen(port, "127.0.0.1");
    };
    tryNext();
  });
}

const PUBLIC_PORT = int(process.env.SERVER_PORT || process.env.PORT, 3000);
let PANEL_PORT = int(process.env.PANEL_PORT, 2053);
let SUB_PORT = int(process.env.SUB_PORT, 2096);
let XRAY_PORT = int(process.env.XUI_XRAY_PORT || process.env.PASARGUARD_XRAY_PORT, 21001);

function parseTunnels(spec) {
  const out = [];
  for (const raw of String(spec || "").split(/[,\n]/)) {
    const p = raw.trim().split(":");
    if (p.length < 3) continue;
    const port = int(p[2], 0);
    if (!p[1] || !port) continue;
    out.push({
      proto: (p[0] || "vless").toLowerCase(),
      path: p[1].startsWith("/") ? p[1] : "/" + p[1],
      port,
      source: "static",
    });
  }
  if (!out.length) {
    out.push({ proto: "vless", path: "/vless-ws", port: 21001, source: "static" });
    out.push({ proto: "vless", path: "/mb-vless", port: 21001, source: "static" });
  }
  return out;
}

const TUNNELS = parseTunnels(
  process.env.XUI_TUNNELS || process.env.PASARGUARD_TUNNELS || TUNNEL_DEFAULT
);

// Dynamic routing state populated from 3x-ui's active inbounds & settings
const DYNAMIC_ROUTES = {
  subPaths: ["/sub/", "/json/", "/clash/"],
  pathRoutes: [], // [{ path, port, proto, remark, network }]
  wsDefaultPort: 0,
  tlsRoutes: [], // [{ sni, port, proto, remark }]
  rawTcpPort: 0,
};

/* ------------------------------ logging --------------------------- */

const STATE = {
  wrapper: WRAPPER,
  xui: null,
  xray: null,
  publicPort: PUBLIC_PORT,
  panelPort: PANEL_PORT,
  subPort: SUB_PORT,
  panelUp: false,
  subUp: false,
  coreUp: false,
  step: "booting",
  error: null,
  admin: null,
  publicHost: null,
  tunnels: TUNNELS,
  inbounds: [],
  shareLink: null,
  subUrl: null,
  subJsonUrl: null,
  data: DATA,
};

const C = process.stdout.isTTY || process.env.FORCE_COLOR === "1";
const paint = (c, s) => (C ? `\x1b[${c}m${s}\x1b[0m` : s);
const log = (...a) => console.log("[3x-ui]", ...a);
const ok = (...a) => console.log(paint("32", "  ✓"), ...a);
const warn = (...a) => console.log(paint("33", "  !"), ...a);
const err = (...a) => console.log(paint("31", "  ✗"), ...a);
const step = (s) => {
  STATE.step = s;
  console.log(paint("36", "  ›"), s);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtBytes(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + " GB";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + " MB";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + " KB";
  return n + " B";
}

function randomToken(len) {
  return crypto
    .randomBytes(Math.ceil(len * 0.75))
    .toString("base64")
    .replace(/[+/=]/g, "")
    .slice(0, len);
}

function randomLowerNum(len) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}

function uuid4() {
  const b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/* ------------------------------ state ----------------------------- */

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (e) {
    return {};
  }
}

function saveState(patch) {
  try {
    const cur = readState();
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify(Object.assign(cur, patch, { at: Date.now() }), null, 2)
    );
  } catch (e) {}
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function ensureDirs() {
  for (const d of [BASE, APP, BIN_DIR, DATA, CERT_DIR, LOGS, TMP]) ensureDir(d);
}

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch (e) {
    try {
      fs.rmdirSync(p, { recursive: true });
    } catch (e2) {}
  }
}

/* ------------------------------ http ------------------------------ */

function request(url, opts = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return reject(new Error("bad url " + url));
    }
    const mod = u.protocol === "https:" ? https : http;
    const payload = opts.body ? Buffer.from(opts.body) : null;
    const headers = Object.assign({ "User-Agent": UA }, opts.headers || {});
    if (payload) headers["Content-Length"] = payload.length;
    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: opts.method || (payload ? "POST" : "GET"),
        headers,
        timeout: opts.timeout || 30000,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          if ((opts.redirects || 0) > 6) return reject(new Error("too many redirects"));
          return resolve(
            request(next, Object.assign({}, opts, { redirects: (opts.redirects || 0) + 1 }))
          );
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
        );
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function downloadFile(url, dest, label) {
  const tmp = dest + ".part";
  rmrf(tmp);
  let done = 0;
  let last = 0;
  await new Promise((resolve, reject) => {
    const doit = (target, redirects = 0) => {
      let u;
      try {
        u = new URL(target);
      } catch (e) {
        return reject(e);
      }
      const mod = u.protocol === "https:" ? https : http;
      const req = mod.get(
        {
          hostname: u.hostname,
          port: u.port || (u.protocol === "https:" ? 443 : 80),
          path: u.pathname + u.search,
          headers: { "User-Agent": UA },
          timeout: 180000,
        },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            if (redirects > 6) return reject(new Error(`${label}: too many redirects`));
            return doit(new URL(res.headers.location, target).toString(), redirects + 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`${label}: HTTP ${res.statusCode}`));
          }
          const total = int(res.headers["content-length"], 0);
          const out = fs.createWriteStream(tmp);
          res.on("data", (c) => {
            done += c.length;
            const now = Date.now();
            if (now - last > 3500) {
              last = now;
              process.stdout.write(
                `\r  … ${label} ${fmtBytes(done)}${total ? " / " + fmtBytes(total) : ""}   `
              );
            }
          });
          res.on("error", reject);
          out.on("error", reject);
          out.on("finish", () => {
            if (total && done < total * 0.98) return reject(new Error(`${label}: truncated`));
            process.stdout.write(`\r  … ${label} ${fmtBytes(done)}          \n`);
            out.close(() => resolve());
          });
          res.pipe(out);
        }
      );
      req.on("timeout", () => req.destroy(new Error(`${label}: timeout`)));
      req.on("error", reject);
    };
    doit(url);
  });
  fs.renameSync(tmp, dest);
  return fs.statSync(dest).size;
}

/* ------------------------------ tar ------------------------------- */

function octal(buf, start, len) {
  const s = buf.toString("ascii", start, start + len).replace(/\0/g, " ").trim();
  if (!s) return 0;
  return parseInt(s, 8) || 0;
}

function parsePax(buf) {
  const out = {};
  let i = 0;
  while (i < buf.length) {
    const sp = buf.indexOf(32, i);
    if (sp < 0) break;
    const len = parseInt(buf.toString("ascii", i, sp), 10);
    if (!len) break;
    const rec = buf.toString("utf8", i, i + len);
    const eq = rec.indexOf("=");
    if (eq > 0) {
      const k = rec.slice(rec.indexOf(" ") + 1, eq);
      const v = rec.slice(eq + 1).replace(/\n$/, "");
      out[k] = v;
    }
    i += len;
  }
  return out;
}

function parseTarHeader(h, longName, longLink, pax) {
  let name = h.toString("utf8", 0, 100).replace(/\0.*$/, "");
  if (longName) name = longName;
  else if (pax && pax.path) name = pax.path;
  const size = pax && pax.size !== undefined ? parseInt(pax.size, 10) : octal(h, 124, 12);
  const typeflag = String.fromCharCode(h[156] || 0);
  let linkname = h.toString("utf8", 157, 257).replace(/\0.*$/, "");
  if (longLink) linkname = longLink;
  else if (pax && pax.linkpath) linkname = pax.linkpath;
  const mode = octal(h, 100, 8) & 0o777;
  const prefix = h.toString("utf8", 345, 500).replace(/\0.*$/, "");
  if (prefix && !name.startsWith("/") && typeflag !== "L" && typeflag !== "K") {
    name = prefix + "/" + name;
  }
  return { name, size, typeflag, linkname, mode, mtime: octal(h, 136, 12) };
}

function isZeroBlock(b) {
  for (let i = 0; i < b.length; i++) if (b[i] !== 0) return false;
  return true;
}

function safeJoin(destDir, name) {
  const norm = path.normalize(name).replace(/^(\.\.[/\\])+/, "");
  const full = path.join(destDir, norm);
  if (!full.startsWith(path.resolve(destDir))) return null;
  return full;
}

function readExact(fd, buf, len) {
  let got = 0;
  while (got < len) {
    let r = 0;
    try {
      r = fs.readSync(fd, buf, got, len - got, null);
    } catch (e) {
      r = 0;
    }
    if (!r) return false;
    got += r;
  }
  return true;
}

function skipBytes(fd, n) {
  if (n <= 0) return true;
  const b = Buffer.allocUnsafe(Math.min(n, 1 << 16));
  let left = n;
  while (left > 0) {
    let r = 0;
    try {
      r = fs.readSync(fd, b, 0, Math.min(b.length, left), null);
    } catch (e) {
      return false;
    }
    if (!r) return false;
    left -= r;
  }
  return true;
}

function extractTarFile(tarPath, destDir, strip = 0, filterFn = null) {
  fs.mkdirSync(destDir, { recursive: true });
  const fd = fs.openSync(tarPath, "r");
  const hdr = Buffer.allocUnsafe(512);
  const chunk = Buffer.allocUnsafe(1 << 18);
  let longName = null;
  let longLink = null;
  let pax = null;
  let count = 0;
  try {
    for (;;) {
      if (!readExact(fd, hdr, 512)) break;
      if (isZeroBlock(hdr)) break;
      const h = parseTarHeader(hdr, longName, longLink, pax);
      const size = h.size;
      const padded = Math.ceil(size / 512) * 512;

      if (h.typeflag === "L" || h.typeflag === "K" || h.typeflag === "x" || h.typeflag === "g") {
        const p = Buffer.allocUnsafe(size);
        if (!readExact(fd, p, size)) break;
        skipBytes(fd, padded - size);
        const txt = p.toString("utf8");
        if (h.typeflag === "L") {
          longName = txt.replace(/\0.*$/, "");
          pax = null;
        } else if (h.typeflag === "K") {
          longLink = txt.replace(/\0.*$/, "");
        } else {
          pax = parsePax(p);
        }
        continue;
      }
      longName = null;
      longLink = null;
      pax = null;

      let name = h.name;
      if (strip) {
        const parts = name.split("/");
        if (parts.length <= strip) {
          skipBytes(fd, padded);
          continue;
        }
        name = parts.slice(strip).join("/");
      }
      if (!name || name === "." || name === "./") {
        skipBytes(fd, padded);
        continue;
      }
      if (filterFn && !filterFn(name)) {
        skipBytes(fd, padded);
        continue;
      }
      const target = safeJoin(destDir, name);
      if (!target) {
        skipBytes(fd, padded);
        continue;
      }

      if (h.typeflag === "5") {
        fs.mkdirSync(target, { recursive: true });
        skipBytes(fd, padded);
      } else if (h.typeflag === "0" || h.typeflag === "" || h.typeflag === "7") {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const out = fs.openSync(target, "w");
        let left = size;
        while (left > 0) {
          const want = Math.min(chunk.length, left);
          let r = 0;
          try {
            r = fs.readSync(fd, chunk, 0, want, null);
          } catch (e) {
            r = 0;
          }
          if (!r) break;
          fs.writeSync(out, chunk, 0, r);
          left -= r;
        }
        fs.closeSync(out);
        if (left > 0) skipBytes(fd, left);
        skipBytes(fd, padded - size);
        if (h.mode & 0o111) {
          try {
            fs.chmodSync(target, 0o755);
          } catch (e) {}
        }
        count++;
      } else if (h.typeflag === "2") {
        try {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          try {
            fs.unlinkSync(target);
          } catch (e) {}
          fs.symlinkSync(h.linkname, target);
        } catch (e) {
          try {
            const src = safeJoin(destDir, h.linkname);
            if (src && fs.existsSync(src)) fs.copyFileSync(src, target);
          } catch (e2) {}
        }
        skipBytes(fd, padded);
      } else if (h.typeflag === "1") {
        try {
          const src = safeJoin(destDir, h.linkname);
          if (src) fs.linkSync(src, target);
        } catch (e) {}
        skipBytes(fd, padded);
      } else {
        skipBytes(fd, padded);
      }
    }
  } finally {
    try {
      fs.closeSync(fd);
    } catch (e) {}
  }
  return count;
}

function streamDecompress(src, dest) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const rs = fs.createReadStream(src, { highWaterMark: 1 << 18 });
    const ws = fs.createWriteStream(dest, { highWaterMark: 1 << 18 });
    const dz = zlib.createGunzip();
    const fail = (e) => {
      if (settled) return;
      settled = true;
      try {
        rs.destroy();
      } catch (x) {}
      try {
        dz.destroy();
      } catch (x) {}
      try {
        ws.destroy();
      } catch (x) {}
      reject(e);
    };
    rs.on("error", fail);
    dz.on("error", fail);
    ws.on("error", fail);
    ws.on("finish", () => {
      if (settled) return;
      settled = true;
      resolve(true);
    });
    rs.pipe(dz).pipe(ws);
  });
}

async function extractTarGz(gzPath, destDir, strip = 0, filterFn = null) {
  fs.mkdirSync(TMP, { recursive: true });
  const tarPath = path.join(TMP, `kb-${process.pid}-${Date.now()}.tar`);
  try {
    await streamDecompress(gzPath, tarPath);
    return extractTarFile(tarPath, destDir, strip, filterFn);
  } finally {
    try {
      fs.unlinkSync(tarPath);
    } catch (e) {}
  }
}

/* ------------------------------ shell ----------------------------- */

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(cmd, args, {
      cwd: opts.cwd || APP,
      env: Object.assign({}, process.env, opts.env || {}),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timer = null;
    if (opts.timeout) {
      timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch (e) {}
      }, opts.timeout);
    }
    const onData = (d) => {
      const s = d.toString();
      out += s;
      if (out.length > 65536) out = out.slice(-49152);
      if (opts.quiet === false) process.stdout.write(s);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 127, out: out + "\n" + e.message });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code == null ? 1 : code, out });
    });
  });
}

/* ---------------------------- utilities --------------------------- */

function portOpen(port, timeout = 1200) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    const done = (v) => {
      try {
        s.destroy();
      } catch (e) {}
      resolve(v);
    };
    s.setTimeout(timeout, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

async function detectPublicIp() {
  if (PUBLIC_HOST_ENV) return PUBLIC_HOST_ENV;
  const saved = readState().publicHost;
  const endpoints = [
    "https://api.ipify.org",
    "https://icanhazip.com",
    "https://ident.me",
    "https://ifconfig.me/ip",
    "https://checkip.amazonaws.com",
  ];
  for (const u of endpoints) {
    try {
      const r = await request(u, { timeout: 6000 });
      const ip = r.body.toString().trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip;
    } catch (e) {}
  }
  return saved || null;
}

function killOrphans() {
  try {
    for (const entry of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      if (pid === process.pid || pid <= 1) continue;
      let argv0 = "";
      try {
        argv0 = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[0] || "";
      } catch (e) {
        continue;
      }
      if (
        argv0.endsWith("/3x-ui/app/x-ui") ||
        argv0.includes("/3x-ui/bin/xray-") ||
        argv0.includes("/3x-ui/bin/mtg-")
      ) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (e) {}
      }
    }
  } catch (e) {}
}

function rssOf(pid) {
  try {
    const s = fs.readFileSync(`/proc/${pid}/statm`, "utf8").split(" ");
    return (Number(s[1]) * 4096) / 1048576; // resident pages -> MB
  } catch (e) {
    return 0;
  }
}

function tailFile(file, lines) {
  try {
    const s = fs.readFileSync(file, "utf8");
    return s.split("\n").slice(-lines).join("\n");
  } catch (e) {
    return "(no log)";
  }
}

/* -------------------------- 3x-ui binary -------------------------- */

function archAsset() {
  const m = os.arch();
  if (m === "x64") return { tar: "x-ui-linux-amd64.tar.gz", xray: "xray-linux-amd64" };
  if (m === "arm64") return { tar: "x-ui-linux-arm64.tar.gz", xray: "xray-linux-arm64" };
  if (m === "arm") return { tar: "x-ui-linux-armv7.tar.gz", xray: "xray-linux-armv7" };
  if (m === "ia32") return { tar: "x-ui-linux-386.tar.gz", xray: "xray-linux-386" };
  if (m === "s390x") return { tar: "x-ui-linux-s390x.tar.gz", xray: "xray-linux-s390x" };
  throw new Error("unsupported CPU architecture: " + m);
}

async function resolveXuiReleaseTag() {
  if (XUI_VERSION !== "latest") return XUI_VERSION;
  try {
    const r = await request(`https://api.github.com/repos/${REPO}/releases/latest`, {
      timeout: 15000,
    });
    if (r.status === 200) {
      const d = JSON.parse(r.body.toString());
      if (d && d.tag_name) return d.tag_name;
    }
  } catch (e) {}
  return "v3.10.2";
}

function xuiEnv(extra = {}) {
  return Object.assign(
    {},
    process.env,
    {
      XUI_DB_FOLDER: DATA,
      XUI_LOG_FOLDER: LOGS,
      XUI_BIN_FOLDER: BIN_DIR,
      XUI_SKIP_HSTS: "true",
      XUI_GOGC: process.env.XUI_GOGC || "35",
      GOMEMLIMIT: process.env.GOMEMLIMIT || "180MiB",
      TZ: process.env.TZ || "UTC",
    },
    extra
  );
}

async function installXui(force) {
  const { tar, xray } = archAsset();
  const xuiExe = path.join(APP, "x-ui");
  const xrayExe = path.join(BIN_DIR, xray);
  const tag = await resolveXuiReleaseTag();

  let currentVer = "";
  try {
    currentVer = fs.readFileSync(VERSION_FILE, "utf8").trim();
  } catch (e) {}

  if (!force && fs.existsSync(xuiExe) && fs.existsSync(xrayExe) && currentVer === tag) {
    ok(`3x-ui ${tag} present`);
  } else {
    step(`downloading 3x-ui ${tag} (${tar})`);
    const gzPath = path.join(TMP, "x-ui.tar.gz");
    const url = `https://github.com/${REPO}/releases/download/${tag}/${tar}`;
    await downloadFile(url, gzPath, `3x-ui ${tag}`);
    step("extracting 3x-ui & xray-core");
    const count = await extractTarGz(gzPath, APP, 1, (entryName) => {
      if (!KEEP_RU_DAT && (entryName.endsWith("_RU.dat") || entryName.endsWith("_RU.db"))) {
        return false;
      }
      return true;
    });
    rmrf(gzPath);
    if (!count || !fs.existsSync(xuiExe)) {
      throw new Error("3x-ui archive extraction failed");
    }

    // Move bundled bin/* into persistent BIN_DIR while preserving any custom files
    const extractedBin = path.join(APP, "bin");
    if (fs.existsSync(extractedBin)) {
      ensureDir(BIN_DIR);
      for (const item of fs.readdirSync(extractedBin)) {
        const src = path.join(extractedBin, item);
        const dst = path.join(BIN_DIR, item);
        try {
          fs.renameSync(src, dst);
        } catch (e) {
          fs.copyFileSync(src, dst);
          rmrf(src);
        }
      }
      rmrf(extractedBin);
    }

    // Also keep a symlink APP/bin -> BIN_DIR in case anything references relative ./bin
    try {
      fs.symlinkSync(BIN_DIR, path.join(APP, "bin"));
    } catch (e) {}

    try {
      fs.chmodSync(xuiExe, 0o755);
    } catch (e) {}
    for (const item of fs.readdirSync(BIN_DIR)) {
      if (item.startsWith("xray-") || item.startsWith("mtg-")) {
        try {
          fs.chmodSync(path.join(BIN_DIR, item), 0o755);
        } catch (e) {}
      }
    }
    fs.writeFileSync(VERSION_FILE, tag + "\n");
    ok(`3x-ui ${tag} installed`);
  }

  const vPanel = await run(xuiExe, ["-v"], { quiet: true, timeout: 15000, env: xuiEnv() });
  STATE.xui = (vPanel.out || "").trim().split("\n")[0] || tag;

  if (fs.existsSync(xrayExe)) {
    const vXray = await run(xrayExe, ["version"], { quiet: true, timeout: 15000 });
    STATE.xray = (vXray.out || "").trim().split("\n")[0] || xray;
  }
  return { xuiExe, xrayExe };
}

/* ------------------------- runtime & api -------------------------- */

const CHILD = { panel: null };

function openLog(name) {
  return fs.openSync(path.join(LOGS, name), "a");
}

function startPanelProcess(xuiExe) {
  const fd = openLog("panel.log");
  const child = spawn(xuiExe, ["run"], {
    cwd: APP,
    env: xuiEnv(),
    stdio: ["ignore", fd, fd],
    detached: false,
  });
  child.on("exit", (code) => {
    log(`3x-ui panel exited (code ${code})`);
  });
  child._logFd = fd;
  CHILD.panel = child;
  return child;
}

async function waitForPanel(timeoutMs = 120000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (CHILD.panel && CHILD.panel.exitCode !== null) {
      const tail = tailFile(path.join(LOGS, "panel.log"), 30);
      throw new Error("3x-ui exited during startup:\n" + tail);
    }
    if (await portOpen(PANEL_PORT, 1000)) {
      try {
        const r = await request(`http://127.0.0.1:${PANEL_PORT}/`, { timeout: 3000 });
        if (r.status >= 200 && r.status < 500) return true;
      } catch (e) {}
    }
    await sleep(600);
  }
  throw new Error("3x-ui did not become ready in time:\n" + tailFile(path.join(LOGS, "panel.log"), 30));
}

function strongPassword(seed) {
  const base = seed && seed.length >= 8 ? seed : "Katabump" + randomToken(6);
  let p = base.replace(/[^A-Za-z0-9!@#$%^&*_\-]/g, "");
  if (!/[A-Z]/.test(p)) p += "AB";
  if (p.replace(/[^A-Z]/g, "").length < 2) p += "CD";
  if (p.replace(/[^0-9]/g, "").length < 2) p += "19" + (p.length % 10) + "8";
  if (!/[!@#$%^&*_\-]/.test(p)) p += "!";
  if (p.length < 12) p += "Kb" + randomToken(4) + "9";
  return p.slice(0, 40);
}

async function configureCliSettings(xuiExe) {
  const st = readState();
  const user = ADMIN_USER;
  const password = ADMIN_PASS || st.adminPass || strongPassword("Katabump" + randomToken(5));

  step("configuring 3x-ui panel credentials & port");
  const r = await run(
    xuiExe,
    [
      "setting",
      "-username",
      user,
      "-password",
      password,
      "-port",
      String(PANEL_PORT),
      "-webBasePath",
      "/",
      "-listenIP",
      "127.0.0.1",
    ],
    { quiet: true, timeout: 30000, env: xuiEnv() }
  );
  if (r.code !== 0) {
    throw new Error("x-ui setting failed:\n" + (r.out || ""));
  }

  const rTok = await run(xuiExe, ["setting", "-getApiToken"], {
    quiet: true,
    timeout: 30000,
    env: xuiEnv(),
  });
  const m = (rTok.out || "").match(/apiToken:\s*(\S+)/);
  if (!m || !m[1]) {
    throw new Error("could not mint 3x-ui API token:\n" + (rTok.out || ""));
  }
  const token = m[1].trim();
  saveState({ adminUser: user, adminPass: password, apiToken: token });
  ok(`admin credentials ready (${user})`);
  return { user, password, token };
}

async function api(method, urlPath, { token, json: body, timeout } = {}) {
  const headers = {};
  let payload = null;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  if (token) headers["Authorization"] = "Bearer " + token;
  const r = await request(`http://127.0.0.1:${PANEL_PORT}${urlPath}`, {
    method,
    headers,
    body: payload,
    timeout: timeout || 20000,
  });
  let parsed = null;
  try {
    parsed = JSON.parse(r.body.toString());
  } catch (e) {
    parsed = r.body.toString();
  }
  return { status: r.status, data: parsed };
}

function reloadPanelInProcess() {
  if (CHILD.panel && CHILD.panel.exitCode === null) {
    try {
      CHILD.panel.kill("SIGHUP");
    } catch (e) {}
  }
}

async function ensurePanelAndSubSettings(token, publicHost) {
  const host = publicHost || "127.0.0.1";
  const r = await api("POST", "/panel/api/setting/all", { token });
  if (r.status !== 200 || !r.data || !r.data.success || !r.data.obj) {
    throw new Error("could not read 3x-ui settings: " + JSON.stringify(r.data).slice(0, 300));
  }
  const cur = r.data.obj;
  const wantSubURI = `http://${host}:${PUBLIC_PORT}/sub/`;
  const wantJsonURI = `http://${host}:${PUBLIC_PORT}/json/`;
  const wantClashURI = `http://${host}:${PUBLIC_PORT}/clash/`;

  const subChanged =
    cur.subEnable !== true ||
    cur.subJsonEnable !== true ||
    cur.subClashEnable !== true ||
    cur.subListen !== "127.0.0.1" ||
    cur.subPort !== SUB_PORT ||
    cur.subPath !== "/sub/" ||
    cur.subJsonPath !== "/json/" ||
    cur.subClashPath !== "/clash/" ||
    cur.subURI !== wantSubURI ||
    cur.subJsonURI !== wantJsonURI ||
    cur.subClashURI !== wantClashURI;

  if (subChanged) {
    const next = Object.assign({}, cur, {
      webListen: "127.0.0.1",
      webPort: PANEL_PORT,
      webBasePath: "/",
      trustedProxyCIDRs: "127.0.0.1/32,::1/128",
      subEnable: true,
      subJsonEnable: true,
      subClashEnable: true,
      subListen: "127.0.0.1",
      subPort: SUB_PORT,
      subPath: "/sub/",
      subJsonPath: "/json/",
      subClashPath: "/clash/",
      subURI: wantSubURI,
      subJsonURI: wantJsonURI,
      subClashURI: wantClashURI,
    });
    const up = await api("POST", "/panel/api/setting/update", { token, json: next });
    if (up.status !== 200 || !up.data || !up.data.success) {
      warn("could not update sub settings: " + JSON.stringify(up.data).slice(0, 250));
    } else {
      reloadPanelInProcess();
      await sleep(1200);
      await waitForPanel(30000);
      ok(`subscription service configured on 127.0.0.1:${SUB_PORT} -> ${wantSubURI}`);
    }
  } else {
    ok(`subscription service ready (${wantSubURI})`);
  }

  DYNAMIC_ROUTES.subPaths = ["/sub/", "/json/", "/clash/"];
  STATE.subUp = await portOpen(SUB_PORT, 1500);
}

function parseJsonSafe(v, fallback = {}) {
  if (v && typeof v === "object") return v;
  try {
    return JSON.parse(String(v || ""));
  } catch (e) {
    return fallback;
  }
}

function getInboundTransportPath(stream, proto, id) {
  const netType = String((stream && stream.network) || "tcp").toLowerCase();
  if (netType === "ws") {
    const ws = (stream && stream.wsSettings) || {};
    return ws.path || "/";
  }
  if (netType === "httpupgrade") {
    const hu = (stream && stream.httpupgradeSettings) || {};
    return hu.path || "/";
  }
  if (netType === "xhttp") {
    const xh = (stream && stream.xhttpSettings) || {};
    return xh.path || "/";
  }
  if (netType === "grpc") {
    const gr = (stream && stream.grpcSettings) || {};
    const svc = gr.serviceName || "";
    return svc ? `/${svc.replace(/^\/+/, "")}` : "";
  }
  if (netType === "tcp") {
    const tcp = (stream && stream.tcpSettings) || {};
    const hdr = tcp.header || {};
    if (hdr.type === "http" && hdr.request && Array.isArray(hdr.request.path) && hdr.request.path[0]) {
      return hdr.request.path[0];
    }
  }
  return "";
}

function setInboundTransportPath(stream, newPath) {
  const netType = String((stream && stream.network) || "tcp").toLowerCase();
  if (netType === "ws") {
    stream.wsSettings = Object.assign({ acceptProxyProtocol: false, host: "", headers: {} }, stream.wsSettings || {}, {
      path: newPath,
    });
  } else if (netType === "httpupgrade") {
    stream.httpupgradeSettings = Object.assign({ acceptProxyProtocol: false, host: "", headers: {} }, stream.httpupgradeSettings || {}, {
      path: newPath,
    });
  } else if (netType === "xhttp") {
    stream.xhttpSettings = Object.assign({ host: "", mode: "auto" }, stream.xhttpSettings || {}, {
      path: newPath,
    });
  }
}

async function ensureDefaultInbound(token, publicHost) {
  const list = await api("GET", "/panel/api/inbounds/list", { token });
  const inbounds = list.status === 200 && list.data && Array.isArray(list.data.obj) ? list.data.obj : [];
  if (inbounds.length > 0) {
    ok(`existing inbound(s) found (${inbounds.length})`);
    return inbounds;
  }

  const st = readState();
  const clientUuid = st.defaultClientUuid || uuid4();
  const clientSubId = st.defaultClientSubId || "kb" + randomLowerNum(12);
  saveState({ defaultClientUuid: clientUuid, defaultClientSubId: clientSubId });

  const host = publicHost || "127.0.0.1";
  const wsPath = TUNNELS[0] ? TUNNELS[0].path : "/vless-ws";

  step(`creating default inbound (${DEFAULT_INBOUND_REMARK} on 127.0.0.1:${XRAY_PORT})`);
  const body = {
    up: 0,
    down: 0,
    total: 0,
    remark: DEFAULT_INBOUND_REMARK,
    enable: true,
    expiryTime: 0,
    listen: "127.0.0.1",
    port: XRAY_PORT,
    protocol: "vless",
    shareAddrStrategy: "custom",
    shareAddr: host,
    settings: JSON.stringify(
      {
        clients: [
          {
            id: clientUuid,
            flow: "",
            email: DEFAULT_CLIENT_EMAIL,
            limitIp: 0,
            totalGB: 0,
            expiryTime: 0,
            enable: true,
            tgId: 0,
            subId: clientSubId,
            comment: "KataBump ready-to-use config",
            reset: 0,
          },
        ],
        decryption: "none",
        encryption: "none",
        fallbacks: [],
      },
      null,
      2
    ),
    streamSettings: JSON.stringify(
      {
        network: "ws",
        security: "none",
        externalProxy: [
          {
            forceTls: "same",
            dest: host,
            port: PUBLIC_PORT,
            remark: "",
          },
        ],
        wsSettings: {
          acceptProxyProtocol: false,
          path: wsPath,
          host: "",
          headers: {},
        },
      },
      null,
      2
    ),
    sniffing: JSON.stringify(
      {
        enabled: true,
        destOverride: ["http", "tls", "quic", "fakedns"],
        metadataOnly: false,
        routeOnly: false,
      },
      null,
      2
    ),
  };

  const add = await api("POST", "/panel/api/inbounds/add", { token, json: body });
  if (add.status !== 200 || !add.data || !add.data.success) {
    throw new Error("could not create default inbound: " + JSON.stringify(add.data).slice(0, 400));
  }
  ok(`default inbound & client created (${DEFAULT_CLIENT_EMAIL})`);

  const after = await api("GET", "/panel/api/inbounds/list", { token });
  return after.status === 200 && after.data && Array.isArray(after.data.obj) ? after.data.obj : [];
}

async function syncInboundsAndHosts(token, publicHost) {
  const host = publicHost || STATE.publicHost || "127.0.0.1";
  const wantHostEntry = `${host}:${PUBLIC_PORT}`;

  const [inbRes, hostRes] = await Promise.all([
    api("GET", "/panel/api/inbounds/list", { token }),
    api("GET", "/panel/api/hosts/list", { token }),
  ]);

  const inbounds =
    inbRes.status === 200 && inbRes.data && Array.isArray(inbRes.data.obj) ? inbRes.data.obj : [];
  const hostGroups =
    hostRes.status === 200 && hostRes.data && Array.isArray(hostRes.data.obj) ? hostRes.data.obj : [];

  const pathRoutes = [];
  const tlsRoutes = [];
  let wsDefaultPort = 0;
  let rawTcpPort = 0;
  let xrayNeedsRestart = false;

  const reservedPrefixes = ["/panel", "/login", "/logout", "/assets", "/sub", "/json", "/clash", "/_kb", "/ws"];
  const usedPaths = new Set();

  for (const ib of inbounds) {
    if (!ib || ib.nodeId != null) continue;
    const settings = parseJsonSafe(ib.settings, {});
    const stream = parseJsonSafe(ib.streamSettings, {});
    const sniffing = parseJsonSafe(ib.sniffing, { enabled: true, destOverride: ["http", "tls", "quic", "fakedns"] });
    const netType = String(stream.network || "tcp").toLowerCase();
    const secType = String(stream.security || "none").toLowerCase();

    let trPath = getInboundTransportPath(stream, ib.protocol, ib.id);
    let streamModified = false;

    // Ensure path-based transports (ws/httpupgrade/xhttp) have a non-conflicting path on the single public port
    if (AUTO_HOST_SYNC && (netType === "ws" || netType === "httpupgrade" || netType === "xhttp")) {
      const collidesWithPanel =
        !trPath ||
        trPath === "/" ||
        reservedPrefixes.some((p) => trPath === p || trPath.startsWith(p + "/")) ||
        usedPaths.has(trPath);

      if (collidesWithPanel) {
        trPath = ib.port === XRAY_PORT && !usedPaths.has(TUNNELS[0].path)
          ? TUNNELS[0].path
          : `/${ib.protocol}-${ib.id}`;
        setInboundTransportPath(stream, trPath);
        streamModified = true;
      }
      usedPaths.add(trPath);
    }

    // Ensure externalProxy on the inbound always advertises publicHost:PUBLIC_PORT for the Inbounds page UI
    if (AUTO_HOST_SYNC) {
      const eps = Array.isArray(stream.externalProxy) ? stream.externalProxy : [];
      const epOk =
        eps.length === 1 &&
        eps[0] &&
        eps[0].dest === host &&
        Number(eps[0].port) === PUBLIC_PORT;
      const shareOk = ib.shareAddrStrategy === "custom" && ib.shareAddr === host;

      if (!epOk || !shareOk || streamModified) {
        stream.externalProxy = [
          {
            forceTls: "same",
            dest: host,
            port: PUBLIC_PORT,
            remark: "",
          },
        ];
        const updatePayload = {
          up: ib.up || 0,
          down: ib.down || 0,
          total: ib.total || 0,
          remark: ib.remark || `${ib.protocol}-${ib.id}`,
          enable: ib.enable !== false,
          expiryTime: ib.expiryTime || 0,
          TrafficReset: ib.trafficReset || "never",
          TrafficResetDay: ib.trafficResetDay || 1,
          listen: ib.listen || "127.0.0.1",
          port: ib.port,
          protocol: ib.protocol,
          shareAddrStrategy: "custom",
          shareAddr: host,
          disableFlow: Boolean(ib.disableFlow),
          settings: JSON.stringify(settings),
          streamSettings: JSON.stringify(stream),
          sniffing: JSON.stringify(sniffing),
        };
        const upRes = await api("POST", `/panel/api/inbounds/update/${ib.id}`, {
          token,
          json: updatePayload,
        });
        if (upRes.status === 200 && upRes.data && upRes.data.success) {
          if (streamModified) xrayNeedsRestart = true;
        }
      }

      // Ensure Hosts table (/panel/api/hosts) has a clean entry pointing to publicHost:PUBLIC_PORT
      const existingHost = hostGroups.find(
        (g) => g && Array.isArray(g.inboundIds) && g.inboundIds.includes(ib.id)
      );
      const wantRemark = `Katabump (${ib.remark || ib.protocol})`;
      const hostBody = {
        groupId: existingHost ? existingHost.groupId : `kbhost_${ib.id}`,
        inboundIds: existingHost ? existingHost.inboundIds : [ib.id],
        hosts: [wantHostEntry],
        sortOrder: existingHost ? existingHost.sortOrder || 0 : 0,
        remark:
          existingHost && existingHost.remark && !/^imported\s+\d+$/i.test(existingHost.remark)
            ? existingHost.remark
            : wantRemark,
        serverDescription: "",
        isDisabled: false,
        isHidden: false,
        port: PUBLIC_PORT,
        security: "same",
        path: trPath || "",
      };

      if (!existingHost) {
        await api("POST", "/panel/api/hosts/add", { token, json: hostBody });
      } else {
        const sameAddr =
          Array.isArray(existingHost.hosts) &&
          existingHost.hosts.length === 1 &&
          existingHost.hosts[0] === wantHostEntry &&
          existingHost.port === PUBLIC_PORT &&
          !existingHost.isDisabled &&
          !existingHost.serverDescription &&
          !/^imported\s+\d+$/i.test(existingHost.remark || "") &&
          (existingHost.path || "") === (trPath || "");
        if (!sameAddr) {
          await api("POST", `/panel/api/hosts/update/${encodeURIComponent(existingHost.groupId)}`, {
            token,
            json: hostBody,
          });
        }
      }
    }

    if (ib.enable !== false) {
      if (trPath && trPath !== "/") {
        pathRoutes.push({
          path: trPath,
          port: ib.port,
          proto: ib.protocol,
          remark: ib.remark,
          network: netType,
        });
      }
      if (netType === "ws" && !wsDefaultPort) {
        wsDefaultPort = ib.port;
      }
      if (secType === "reality" || secType === "tls") {
        let sni = "";
        if (secType === "reality" && stream.realitySettings && Array.isArray(stream.realitySettings.serverNames)) {
          sni = stream.realitySettings.serverNames[0] || "";
        } else if (secType === "tls" && stream.tlsSettings) {
          sni = stream.tlsSettings.serverName || "";
        }
        tlsRoutes.push({ sni: sni.toLowerCase(), port: ib.port, proto: ib.protocol, remark: ib.remark });
      } else if (netType === "tcp" && !trPath && !rawTcpPort) {
        rawTcpPort = ib.port;
      }
    }
  }

  if (xrayNeedsRestart) {
    await api("POST", "/panel/api/server/restartXrayService", { token });
  }

  DYNAMIC_ROUTES.pathRoutes = pathRoutes;
  DYNAMIC_ROUTES.wsDefaultPort = wsDefaultPort || XRAY_PORT;
  DYNAMIC_ROUTES.tlsRoutes = tlsRoutes;
  DYNAMIC_ROUTES.rawTcpPort = rawTcpPort;

  STATE.inbounds = inbounds.map((ib) => {
    const stream = parseJsonSafe(ib.streamSettings, {});
    return {
      id: ib.id,
      remark: ib.remark,
      protocol: ib.protocol,
      network: stream.network || "tcp",
      port: ib.port,
      path: getInboundTransportPath(stream, ib.protocol, ib.id) || "-",
      enable: ib.enable !== false,
    };
  });

  // Refresh ready-to-use links for state & PANEL.txt
  try {
    const allLinks = await api("GET", "/panel/api/inbounds/allLinks", { token });
    if (allLinks.status === 200 && allLinks.data && Array.isArray(allLinks.data.obj) && allLinks.data.obj.length) {
      STATE.shareLink = allLinks.data.obj[0];
    }
  } catch (e) {}

  try {
    for (const ib of inbounds) {
      const settings = parseJsonSafe(ib.settings, {});
      const clients = Array.isArray(settings.clients) ? settings.clients : [];
      const firstSub = clients.find((c) => c && c.subId);
      if (firstSub && firstSub.subId) {
        STATE.subUrl = `http://${host}:${PUBLIC_PORT}/sub/${firstSub.subId}`;
        STATE.subJsonUrl = `http://${host}:${PUBLIC_PORT}/json/${firstSub.subId}`;
        break;
      }
    }
  } catch (e) {}
}

/* --------------------------- public port -------------------------- */

function statusHtml() {
  const s = STATE;
  const esc = (x) =>
    String(x == null ? "" : x).replace(
      /[<>&"]/g,
      (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]
    );
  const allTunnels = [];
  const seen = new Set();
  for (const t of s.tunnels || []) {
    const k = `${t.path}:${t.port}`;
    if (!seen.has(k)) {
      seen.add(k);
      allTunnels.push({ proto: t.proto, path: t.path, port: t.port, note: "static tunnel" });
    }
  }
  for (const r of DYNAMIC_ROUTES.pathRoutes || []) {
    const k = `${r.path}:${r.port}`;
    if (!seen.has(k)) {
      seen.add(k);
      allTunnels.push({ proto: r.proto, path: r.path, port: r.port, note: r.remark || r.network });
    }
  }
  const rows = allTunnels
    .map(
      (t) =>
        `<tr><td>${esc(t.proto)}</td><td><code>${esc(t.path)}</code></td><td>${t.port}</td><td>${esc(t.note || "")}</td></tr>`
    )
    .join("");
  const color = s.error ? "#ff6b6b" : s.panelUp ? "#4ade80" : "#fbbf24";
  const shareSection = s.shareLink
    ? `<div class="card"><b>Ready-to-Use Config &amp; Subscription</b><br>
<div style="margin-top:8px"><b>Share Link:</b><br><code style="word-break:break-all;display:block;padding:8px;margin-top:4px">${esc(s.shareLink)}</code></div>
${s.subUrl ? `<div style="margin-top:8px"><b>Subscription URL:</b> <a href="${esc(s.subUrl)}">${esc(s.subUrl)}</a></div>` : ""}
</div>`
    : "";

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>3x-ui on KataBump</title>
<style>body{margin:0;background:#0b1020;color:#e6e9f2;font:15px/1.6 system-ui,-apple-system,Segoe UI,sans-serif}
.wrap{max-width:780px;margin:0 auto;padding:32px 20px}
h1{font-size:22px;margin:0 0 4px}.sub{color:#8b93ad;margin-bottom:24px}
.card{background:#111832;border:1px solid #1f2a44;border-radius:14px;padding:20px;margin-bottom:16px}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};margin-right:8px}
table{width:100%;border-collapse:collapse;margin-top:8px}td,th{padding:6px 8px;border-bottom:1px solid #1f2a44;text-align:left;font-size:14px}
code{background:#0b1020;padding:2px 6px;border-radius:6px;font-size:13px}
a{color:#7dd3fc}</style></head><body><div class="wrap">
<h1><span class="dot"></span>3x-ui (Sanaei) on KataBump</h1>
<div class="sub">${esc(WRAPPER)} — panel ${esc(s.xui || "?")} · ${esc(s.xray || "xray-core")}</div>
<div class="card"><b>Status:</b> ${esc(s.step)} ${s.error ? "— " + esc(s.error) : ""}<br>
<b>Public port:</b> ${s.publicPort} · <b>Panel:</b> 127.0.0.1:${s.panelPort} (${s.panelUp ? "up" : "down"}) · <b>Sub:</b> 127.0.0.1:${s.subPort} (${s.subUp ? "up" : "down"}) · <b>Core:</b> ${s.coreUp ? "up" : "down"}<br>
<b>Public host:</b> ${esc(s.publicHost || "detecting…")}</div>
<div class="card"><b>Links</b><br>
<a href="/panel/">/panel/</a> — 3x-ui web panel<br>
<a href="/panel/inbounds">/panel/inbounds</a> — Inbounds · <a href="/panel/hosts">/panel/hosts</a> — Hosts<br>
<a href="${STATUS_PATH}">${STATUS_PATH}</a> — KataBump wrapper status</div>
${shareSection}
<div class="card"><b>Multiplexed Tunnels on Public Port ${s.publicPort}</b>
<table><tr><th>proto</th><th>path</th><th>local port</th><th>remark</th></tr>${rows}</table></div>
</div></body></html>`;
}

function writeResponse(socket, status, body, ctype, extraHeaders) {
  const b = Buffer.from(body);
  let head = `HTTP/1.1 ${status}\r\nContent-Type: ${ctype}\r\nContent-Length: ${b.length}\r\nCache-Control: no-store\r\n`;
  if (extraHeaders) {
    for (const k of Object.keys(extraHeaders)) head += `${k}: ${extraHeaders[k]}\r\n`;
  }
  head += "Connection: close\r\n\r\n";
  try {
    socket.end(Buffer.concat([Buffer.from(head, "latin1"), b]));
  } catch (e) {
    try {
      socket.destroy();
    } catch (e2) {}
  }
}

function withForwarded(buf, ip) {
  const s = buf.toString("latin1");
  const idx = s.indexOf("\r\n");
  if (idx < 0) return buf;
  const hostMatch = s.match(/\r\nHost:\s*([^\r\n]*)/i);
  const cleanIp = String(ip || "127.0.0.1").replace(/^::ffff:/, "");
  const extra =
    `X-Forwarded-For: ${cleanIp}\r\nX-Forwarded-Proto: http\r\n` +
    (hostMatch ? `X-Forwarded-Host: ${hostMatch[1].trim()}\r\n` : "");
  return Buffer.from(s.slice(0, idx + 2) + extra + s.slice(idx + 2), "latin1");
}

const HTTP_METHODS_RE = /^(GET|POST|HEAD|PUT|DELETE|OPTIONS|PATCH|CONNECT|TRACE|PRI)\s+/;

function parseTlsSni(buf) {
  try {
    if (buf.length < 43 || buf[0] !== 0x16 || buf[1] !== 0x03) return "";
    if (buf[5] !== 0x01) return ""; // ClientHello
    let pos = 43;
    if (pos >= buf.length) return "";
    const sessIdLen = buf[pos];
    pos += 1 + sessIdLen;
    if (pos + 2 > buf.length) return "";
    const cipherLen = buf.readUInt16BE(pos);
    pos += 2 + cipherLen;
    if (pos + 1 > buf.length) return "";
    const compLen = buf[pos];
    pos += 1 + compLen;
    if (pos + 2 > buf.length) return "";
    const extTotalLen = buf.readUInt16BE(pos);
    pos += 2;
    const end = Math.min(buf.length, pos + extTotalLen);
    while (pos + 4 <= end) {
      const extType = buf.readUInt16BE(pos);
      const extLen = buf.readUInt16BE(pos + 2);
      pos += 4;
      if (extType === 0x0000 && pos + 5 <= end) {
        const nameLen = buf.readUInt16BE(pos + 3);
        if (pos + 5 + nameLen <= end) {
          return buf.toString("ascii", pos + 5, pos + 5 + nameLen).toLowerCase();
        }
      }
      pos += extLen;
    }
  } catch (e) {}
  return "";
}

function pipeToLocalPort(client, port, buf, addForwarded, ip) {
  const upstream = net.connect({ host: "127.0.0.1", port }, () => {
    upstream.write(addForwarded ? withForwarded(buf, ip) : buf);
    upstream.pipe(client);
    client.pipe(upstream);
    if (port === PANEL_PORT) {
      client.on("data", (chunk) => {
        const s = chunk.toString("latin1", 0, Math.min(chunk.length, 512));
        if (s.includes("/panel/api/inbounds/") || s.includes("/panel/api/clients/")) {
          scheduleQuickSync();
        }
      });
    }
  });
  upstream.on("error", () => {
    try {
      client.end(
        "HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nContent-Length: 21\r\nConnection: close\r\n\r\nupstream unavailable\n"
      );
    } catch (e) {}
  });
  client.on("error", () => {
    try {
      upstream.destroy();
    } catch (e) {}
  });
  upstream.setNoDelay(true);
}

function route(client, buf, ip) {
  // 1. Check TLS / REALITY ClientHello (0x16 0x03)
  if (buf.length >= 3 && buf[0] === 0x16 && buf[1] === 0x03) {
    if (DYNAMIC_ROUTES.tlsRoutes.length > 0) {
      const sni = parseTlsSni(buf);
      const matched =
        (sni && DYNAMIC_ROUTES.tlsRoutes.find((r) => r.sni === sni)) ||
        DYNAMIC_ROUTES.tlsRoutes[0];
      return pipeToLocalPort(client, matched.port, buf, false, ip);
    }
  }

  const head = buf.toString("latin1", 0, Math.min(buf.length, 4096));

  // 2. Check non-HTTP binary TCP protocol (e.g. raw VLESS / VMess / Shadowsocks TCP)
  if (!HTTP_METHODS_RE.test(head)) {
    const rawPort = DYNAMIC_ROUTES.rawTcpPort || XRAY_PORT;
    return pipeToLocalPort(client, rawPort, buf, false, ip);
  }

  const line = head.split("\r\n")[0] || "";
  const [, urlPath] = line.split(" ");
  const clean = (urlPath || "/").split("?")[0];

  // 3. Wrapper status endpoint
  if (clean === STATUS_PATH) {
    const body = JSON.stringify(STATE, null, 2);
    const html = /text\/html/i.test(head);
    return writeResponse(
      client,
      200,
      html ? statusHtml() : body,
      html ? "text/html; charset=utf-8" : "application/json"
    );
  }

  // 4. Static & dynamic Xray tunnel paths (WS, HTTPUpgrade, XHTTP/SplitHTTP, gRPC, TCP-HTTP)
  const staticTun = TUNNELS.find((t) => clean === t.path || clean.startsWith(t.path + "/"));
  if (staticTun) {
    return pipeToLocalPort(client, staticTun.port, buf, false, ip);
  }
  const dynTun = DYNAMIC_ROUTES.pathRoutes.find(
    (r) => clean === r.path || clean.startsWith(r.path + "/")
  );
  if (dynTun) {
    return pipeToLocalPort(client, dynTun.port, buf, false, ip);
  }

  // 5. Non-panel WebSocket Upgrade fallback (e.g. WS inbound with path "/")
  if (/\r\nUpgrade:\s*websocket/i.test(head) && clean !== "/ws" && !clean.endsWith("/ws")) {
    const wsPort = DYNAMIC_ROUTES.wsDefaultPort || XRAY_PORT;
    return pipeToLocalPort(client, wsPort, buf, false, ip);
  }

  // 6. Subscription service paths (/sub/..., /json/..., /clash/...)
  const isSubPath = DYNAMIC_ROUTES.subPaths.some(
    (sp) => clean === sp.replace(/\/$/, "") || clean.startsWith(sp)
  );
  if (isSubPath) {
    return pipeToLocalPort(client, SUB_PORT, buf, true, ip);
  }

  // 7. 3x-ui Web Panel
  if (!STATE.panelUp) {
    return writeResponse(
      client,
      503,
      statusHtml().replace("<title>3x-ui on KataBump</title>", "<title>3x-ui — starting</title>"),
      "text/html; charset=utf-8"
    );
  }

  if (
    /^POST\s+/i.test(line) &&
    (clean.startsWith("/panel/api/inbounds/") || clean.startsWith("/panel/api/clients/"))
  ) {
    scheduleQuickSync();
  }

  return pipeToLocalPort(client, PANEL_PORT, buf, true, ip);
}

function startProxy() {
  const server = net.createServer((client) => {
    client.setNoDelay(true);
    let first = null;
    const onData = (chunk) => {
      if (first) return;
      first = chunk;
      client.removeListener("data", onData);
      route(client, first, client.remoteAddress || "127.0.0.1");
    };
    client.on("data", onData);
    client.on("error", () => {});
    client.on("end", () => {
      if (!first) client.destroy();
    });
  });
  server.on("error", (e) => {
    err("public port error: " + e.message);
    STATE.error = e.message;
  });
  return new Promise((resolve) => {
    server.listen(PUBLIC_PORT, "0.0.0.0", () => resolve(server));
  });
}

/* ---------------------------- watchdog ---------------------------- */

let lastSyncAt = 0;
let quickSyncTimer = null;
let runtimeCtx = null;

function scheduleQuickSync() {
  if (!runtimeCtx || !runtimeCtx.token) return;
  if (quickSyncTimer) clearTimeout(quickSyncTimer);
  quickSyncTimer = setTimeout(async () => {
    quickSyncTimer = null;
    try {
      await syncInboundsAndHosts(runtimeCtx.token, STATE.publicHost);
      writeCredFile(runtimeCtx.user, runtimeCtx.password, STATE.publicHost);
      lastSyncAt = Date.now();
    } catch (e) {}
  }, 900);
}

async function watchdog(xuiExe, ctx) {
  runtimeCtx = ctx;
  releaseMemory();
  while (true) {
    await sleep(15000);
    try {
      let up = await portOpen(PANEL_PORT, 1500);
      const panelRss = CHILD.panel ? rssOf(CHILD.panel.pid) : 0;
      STATE.panelRss = Math.round(panelRss);

      if (up && panelRss > PANEL_MEM_MAX) {
        warn(`3x-ui is using ${Math.round(panelRss)} MB (ceiling ${PANEL_MEM_MAX} MB) — restarting`);
        up = false;
      }

      if (!up || !CHILD.panel || CHILD.panel.exitCode !== null) {
        warn("3x-ui panel is down — restarting");
        if (CHILD.panel && CHILD.panel.exitCode === null) {
          try {
            CHILD.panel.kill("SIGTERM");
          } catch (e) {}
          await sleep(1500);
          try {
            CHILD.panel.kill("SIGKILL");
          } catch (e) {}
        }
        STATE.panelUp = false;
        startPanelProcess(xuiExe);
        await waitForPanel(90000);
        STATE.panelUp = true;
        ok("3x-ui panel is back");
      } else {
        STATE.panelUp = true;
      }

      STATE.subUp = await portOpen(SUB_PORT, 1200);
      if (!SKIP_XRAY) {
        STATE.coreUp = await portOpen(XRAY_PORT, 1200);
      }

      // Periodically sync any new inbounds/clients/hosts created by the user in the UI
      if (ctx.token && Date.now() - lastSyncAt > 15000) {
        lastSyncAt = Date.now();
        try {
          await syncInboundsAndHosts(ctx.token, STATE.publicHost);
          writeCredFile(ctx.user, ctx.password, STATE.publicHost);
        } catch (e) {}
      }

      releaseMemory();
    } catch (e) {
      log("watchdog: " + e.message);
    }
  }
}

/* ----------------------------- banner ----------------------------- */

function writeCredFile(user, password, publicHost) {
  const host = publicHost || "YOUR-SERVER-IP";
  const lines = [
    "3x-ui (MHSanaei) on KataBump",
    "============================",
    "",
    `Panel URL        : http://${host}:${PUBLIC_PORT}/panel/`,
    `Hosts Manager    : http://${host}:${PUBLIC_PORT}/panel/hosts`,
    `Wrapper Status   : http://${host}:${PUBLIC_PORT}${STATUS_PATH}`,
    "",
    `Username         : ${user}`,
    `Password         : ${password}`,
    "",
    `3x-ui Version    : ${STATE.xui || "unknown"}`,
    `Xray Core        : ${STATE.xray || "unknown"}`,
    `Default Inbound  : ${DEFAULT_INBOUND_REMARK} -> 127.0.0.1:${XRAY_PORT} (ws path ${TUNNELS[0].path})`,
    `External Host    : ${host}:${PUBLIC_PORT}`,
    "",
  ];
  if (STATE.subUrl) {
    lines.push(`Subscription URL : ${STATE.subUrl}`);
  }
  if (STATE.subJsonUrl) {
    lines.push(`JSON Sub URL     : ${STATE.subJsonUrl}`);
  }
  if (STATE.shareLink) {
    lines.push("", "Ready-to-Use VLESS Config:", STATE.shareLink);
  }
  lines.push("", "Data (persistent): " + DATA, "Logs             : " + LOGS, "");
  try {
    fs.writeFileSync(CRED_FILE, lines.join("\n"));
  } catch (e) {}
  return lines.join("\n");
}

function banner(user, password, publicHost) {
  const host = publicHost || "YOUR-SERVER-IP";
  const line = "─".repeat(66);
  console.log("");
  console.log(paint("35", "  " + line));
  console.log(paint("35", "   3x-ui (MHSanaei) is ready on KataBump"));
  console.log(paint("35", "  " + line));
  console.log(`   panel       http://${host}:${PUBLIC_PORT}/panel/`);
  console.log(`   status      http://${host}:${PUBLIC_PORT}${STATUS_PATH}`);
  if (STATE.subUrl) {
    console.log(`   sub url     ${STATE.subUrl}`);
  }
  console.log("");
  console.log(`   username    ${user}`);
  console.log(`   password    ${password}`);
  if (STATE.shareLink) {
    console.log("");
    console.log(`   vless link  ${STATE.shareLink}`);
  }
  console.log("");
  console.log(`   3x-ui ${STATE.xui || "?"} · ${STATE.xray || "xray"}`);
  console.log(`   data  ${DATA}`);
  console.log(paint("35", "  " + line));
  console.log("");
}

/* ---------------------------- selftest ---------------------------- */

async function selfTest() {
  log("selftest: checking structure only (no network)");
  const checks = [
    ["wrapper constants", typeof WRAPPER === "string" && typeof PUBLIC_PORT === "number"],
    ["tunnels parsed", Array.isArray(TUNNELS) && TUNNELS.length >= 2],
    ["tar extractor", typeof extractTarFile === "function" && typeof extractTarGz === "function"],
    ["arch asset resolver", (() => { const a = archAsset(); return Boolean(a.tar && a.xray); })()],
    [
      "password policy",
      (() => {
        const p = strongPassword("Katabump123");
        return (
          p.length >= 12 &&
          /[A-Z].*[A-Z]/.test(p) &&
          /[0-9].*[0-9]/.test(p) &&
          /[!@#$%^&*_\-]/.test(p)
        );
      })(),
    ],
    ["status page html", statusHtml().includes("3x-ui (Sanaei) on KataBump")],
  ];
  let bad = 0;
  for (const [name, pass] of checks) {
    console.log(`   ${pass ? paint("32", "✓") : paint("31", "✗")} ${name}`);
    if (!pass) bad++;
  }
  console.log(`   ${bad ? paint("31", bad + " failed") : paint("32", "all good")}`);
  process.exit(bad ? 1 : 0);
}

/* ------------------------------ main ------------------------------ */

async function bootstrap() {
  ensureDirs();
  killOrphans();

  step("opening public port " + PUBLIC_PORT);
  await startProxy();
  ok("public port " + PUBLIC_PORT + " open");
  releaseMemory();

  const { xuiExe } = await installXui(FORCE_SETUP);
  releaseMemory();

  const creds = await configureCliSettings(xuiExe);
  releaseMemory();

  step("starting 3x-ui panel");
  startPanelProcess(xuiExe);
  await waitForPanel();
  STATE.panelUp = true;
  ok(`3x-ui panel listening on 127.0.0.1:${PANEL_PORT}`);
  releaseMemory();

  const publicHost = await detectPublicIp();
  STATE.publicHost = publicHost;
  ok(`public host detected: ${publicHost || "127.0.0.1"}`);

  step("provisioning subscription service, default inbound & hosts");
  await ensurePanelAndSubSettings(creds.token, publicHost);
  await ensureDefaultInbound(creds.token, publicHost);
  await syncInboundsAndHosts(creds.token, publicHost);
  releaseMemory();

  if (!SKIP_XRAY) {
    step("waiting for xray inbound to start");
    let coreUp = false;
    for (let i = 0; i < 25; i++) {
      coreUp = await portOpen(XRAY_PORT, 1200);
      if (coreUp) break;
      await sleep(1000);
    }
    STATE.coreUp = coreUp;
    if (coreUp) ok(`xray inbound listening on 127.0.0.1:${XRAY_PORT}`);
    else warn("xray inbound is not listening yet — check " + path.join(LOGS, "panel.log"));
  }

  STATE.step = "ready";
  STATE.admin = creds.user;
  saveState({ adminUser: creds.user, adminPass: creds.password, publicHost });

  writeCredFile(creds.user, creds.password, publicHost);
  banner(creds.user, creds.password, publicHost);
  releaseMemory();

  lastSyncAt = Date.now();
  watchdog(xuiExe, creds);
}

function shutdown(sig) {
  log("shutting down (" + sig + ")");
  if (CHILD.panel && CHILD.panel.exitCode === null) {
    try {
      CHILD.panel.kill("SIGTERM");
    } catch (e) {}
  }
  setTimeout(() => process.exit(0), 1500).unref();
}

async function main() {
  console.log("");
  console.log(paint("35", "  3x-ui-katabump ") + paint("90", WRAPPER));
  console.log(
    paint(
      "90",
      "  MHSanaei 3x-ui " + XUI_VERSION + " · single public port " + PUBLIC_PORT
    )
  );
  console.log("");
  if (process.env.SELFTEST === "1") return selfTest();

  const used = new Set([PUBLIC_PORT]);
  const pick = async (preferred, fallbackStart) => {
    if (!used.has(preferred) && !(await portOpen(preferred, 400))) {
      used.add(preferred);
      return preferred;
    }
    const p = await firstFreePort([
      fallbackStart,
      fallbackStart + 1,
      fallbackStart + 2,
      fallbackStart + 3,
    ]);
    used.add(p);
    return p;
  };

  PANEL_PORT = await pick(PANEL_PORT, 18080);
  SUB_PORT = await pick(SUB_PORT, 18096);
  XRAY_PORT = await pick(XRAY_PORT, 21001);
  for (const t of TUNNELS) {
    if (t.port === 21001) t.port = XRAY_PORT;
  }
  STATE.panelPort = PANEL_PORT;
  STATE.subPort = SUB_PORT;

  try {
    await bootstrap();
  } catch (e) {
    STATE.error = e.message;
    STATE.step = "error";
    err(e.message);
    console.error(e.stack || e);
    while (true) await sleep(60000);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main();
