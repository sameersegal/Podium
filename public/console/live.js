/**
 * The console's half of the live channel.
 *
 * Same socket as `/live.js`, different consequence. The server-rendered pages
 * can only offer a reload; the console can invalidate the exact query that went
 * stale and re-fetch it, which is the behaviour R30 was describing when it
 * called `surfaces/live.ts` "the cache-invalidation channel".
 *
 * The frame still carries no domain data — `{type, subject, occurred_at}` — so
 * a listener learns *what kind of thing changed* and nothing more. The refetch
 * it triggers goes through the ordinary authorized route, so blinding and PII
 * redaction are inherited rather than reimplemented here (`durable/room.ts`).
 */

const listeners = new Set();

let socket = null;
let seq = 0;
let attempt = 0;
let keepalive = null;
let closed = false;
let currentEventId = null;

/**
 * Subscribe to changes. `subjects` filters by `frame.subject.type`; an empty
 * list means everything in the room. Returns an unsubscribe function.
 */
export function onChange(subjects, handler) {
  const entry = { subjects: subjects || [], handler };
  listeners.add(entry);
  return () => listeners.delete(entry);
}

export function connect(eventId) {
  if (!("WebSocket" in window)) return;
  if (socket && currentEventId === eventId) return;
  currentEventId = eventId || null;
  closed = false;
  if (socket) {
    const old = socket;
    socket = null;
    old.close();
  }
  open();
}

export function disconnect() {
  closed = true;
  stopKeepalive();
  if (socket) socket.close();
  socket = null;
}

function endpoint() {
  const url = new URL("/live/subscribe", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (currentEventId) url.searchParams.set("event", currentEventId);
  // Lets the room say it cannot prove continuity rather than leaving the
  // console on a screen that quietly missed a change.
  if (seq > 0) url.searchParams.set("since", String(seq));
  return url.toString();
}

function open() {
  if (closed) return;
  try {
    socket = new WebSocket(endpoint());
  } catch {
    return retry();
  }

  socket.addEventListener("open", () => {
    attempt = 0;
    keepalive = setInterval(() => {
      if (socket && socket.readyState === 1) socket.send("ping");
    }, 30000);
  });

  socket.addEventListener("message", (ev) => {
    if (ev.data === "pong") return;
    let batch;
    try {
      batch = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!batch || batch.v !== 1) return;
    if (typeof batch.seq === "number") seq = batch.seq;
    // A resync means the room cannot prove we saw everything, so every
    // listener refetches rather than guessing which of them missed something.
    if (batch.resync) return fanout(null);
    for (const frame of batch.frames || []) fanout(frame);
  });

  socket.addEventListener("close", (ev) => {
    stopKeepalive();
    // 4001 is "reauthenticate" — the lifetime cap expired or a grant was
    // revoked. Reconnecting re-runs the authorized handshake.
    if (ev.code === 4001) {
      attempt = 0;
      return setTimeout(open, 0);
    }
    retry();
  });

  socket.addEventListener("error", () => {
    if (socket) socket.close();
  });
}

function fanout(frame) {
  for (const entry of listeners) {
    if (frame && entry.subjects.length && !entry.subjects.includes(frame.subject && frame.subject.type)) continue;
    try {
      entry.handler(frame);
    } catch (err) {
      console.error("live listener failed", err);
    }
  }
}

function stopKeepalive() {
  if (keepalive) clearInterval(keepalive);
  keepalive = null;
}

/** Every deploy evicts the room and drops every socket, so backoff is how the console survives a release. */
function retry() {
  if (closed) return;
  attempt += 1;
  if (attempt > 12) return;
  const delay = Math.min(30000, 1000 * Math.pow(2, attempt - 1));
  setTimeout(open, delay * (0.8 + Math.random() * 0.4));
}
