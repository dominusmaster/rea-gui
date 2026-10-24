// Password sign-in for server deployments. On your own machine REA GUI needs no password: it
// listens on 127.0.0.1 and the per-launch token in the page keeps other websites out. On a
// server, anyone who can load the page would get that token, so a password guards the page
// itself and a session cookie proves the sign-in.
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const COOKIE = "rea_gui_session";
const SESSION_DAYS = 30;
const MAX_FAILURES = 10; // per address, per window
const FAILURE_WINDOW = 15 * 60 * 1000;

export class PasswordAuth {
  constructor(password) {
    // Compare hashes, never the raw strings, so timing doesn't leak the password's length.
    this.salt = randomBytes(16);
    this.hash = scryptSync(password, this.salt, 32);
    this.sessions = new Map(); // session id → expiry (ms)
    this.failures = new Map(); // address → { count, since }
  }

  check(password) {
    return typeof password === "string" && timingSafeEqual(scryptSync(password, this.salt, 32), this.hash);
  }

  // Returns { ok, cookie } on success, { ok: false, status, error } otherwise.
  signIn(password, req) {
    const address = clientAddress(req);
    const now = Date.now();
    const record = this.failures.get(address);
    if (record && now - record.since < FAILURE_WINDOW && record.count >= MAX_FAILURES) {
      return { ok: false, status: 429, error: "Too many wrong passwords. Wait 15 minutes and try again." };
    }
    if (!this.check(password)) {
      const fresh = !record || now - record.since >= FAILURE_WINDOW;
      this.failures.set(address, fresh ? { count: 1, since: now } : { ...record, count: record.count + 1 });
      return { ok: false, status: 401, error: "Wrong password." };
    }
    this.failures.delete(address);
    const id = randomBytes(32).toString("hex");
    this.sessions.set(id, now + SESSION_DAYS * 86400_000);
    return { ok: true, cookie: cookie(id, SESSION_DAYS * 86400, isHttps(req)) };
  }

  signOut(req) {
    this.sessions.delete(sessionId(req));
    return cookie("", 0, isHttps(req));
  }

  signedIn(req) {
    const id = sessionId(req);
    const expiry = id && this.sessions.get(id);
    if (!expiry) return false;
    if (expiry < Date.now()) {
      this.sessions.delete(id);
      return false;
    }
    return true;
  }
}

function sessionId(req) {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === COOKIE) return value.join("=");
  }
  return null;
}

function cookie(value, maxAge, secure) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

// Behind a reverse proxy (the usual way to add HTTPS), the proxy says what the browser used.
const isHttps = (req) => Boolean(req.socket.encrypted) || req.headers["x-forwarded-proto"] === "https";
// X-Forwarded-For can be forged by any client, so it's only trusted when a proxy is declared.
const clientAddress = (req) =>
  (process.env.REA_GUI_TRUST_PROXY === "1" && String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim()) || req.socket.remoteAddress || "unknown";

export const isLoopback = (host) => ["127.0.0.1", "::1", "localhost"].includes(host);
