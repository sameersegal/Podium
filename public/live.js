/**
 * Live updates — the client half of workers/api/src/ui/live.ts.
 *
 * The only JavaScript file in this project, and it stays that way: no
 * framework, no build step, no bundler. It is here rather than inline because
 * reconnect logic is not readable inside a tagged template literal, and
 * because /live.js is a static asset the edge can serve without waking the
 * Worker (wrangler.jsonc deliberately leaves it out of `run_worker_first`).
 *
 * It runs only on authenticated screens that opted in. A page that did not
 * opt in never renders the element or the script tag, so "public surfaces
 * render fully with scripts blocked" (08, "Degrade gracefully") holds by
 * construction rather than by anyone remembering it.
 *
 * The socket carries no domain data — just {type, subject, occurred_at}. The
 * two modes below are the only things it can do with that: say so, or re-ask
 * the server. Neither one renders anything the server did not.
 */
(function () {
  "use strict";

  var el = document.getElementById("podium-live");
  if (!el || !("WebSocket" in window)) return;

  var mode = el.getAttribute("data-live-mode") || "nudge";
  var subjects = (el.getAttribute("data-live-subjects") || "").split(",").filter(Boolean);
  var url = el.getAttribute("data-live-url");
  if (!url) return;

  var socket = null;
  var seq = 0;
  var pending = 0;
  var attempt = 0;
  var keepalive = null;
  var refreshTimer = null;
  var closed = false;

  // ---------------------------------------------------------------------------
  // Connection
  // ---------------------------------------------------------------------------

  function endpoint() {
    var base = new URL(url, location.href);
    base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    // Lets the room tell us it cannot prove continuity, rather than leaving us
    // on a page that quietly missed a change.
    if (seq > 0) base.searchParams.set("since", String(seq));
    return base.toString();
  }

  function connect() {
    if (closed) return;
    try {
      socket = new WebSocket(endpoint());
    } catch (err) {
      return retry();
    }

    socket.addEventListener("open", function () {
      attempt = 0;
      // The room answers this without waking up (setWebSocketAutoResponse), so
      // a keepalive costs nothing but keeps intermediaries from dropping us.
      keepalive = setInterval(function () {
        if (socket && socket.readyState === 1) socket.send("ping");
      }, 30000);
    });

    socket.addEventListener("message", function (ev) {
      if (ev.data === "pong") return;
      var batch;
      try {
        batch = JSON.parse(ev.data);
      } catch (err) {
        return;
      }
      if (!batch || batch.v !== 1) return;
      if (typeof batch.seq === "number") seq = batch.seq;
      if (batch.resync) return announce(1);

      var relevant = (batch.frames || []).filter(function (f) {
        return subjects.length === 0 || subjects.indexOf(f.subject && f.subject.type) !== -1;
      });
      if (relevant.length > 0) announce(relevant.length);
    });

    socket.addEventListener("close", function (ev) {
      stopKeepalive();
      // 4001 is "reauthenticate": the lifetime cap expired, or a grant was
      // revoked. Reconnecting immediately re-runs the authorized handshake,
      // which either succeeds with fresh permissions or is refused.
      if (ev.code === 4001) {
        attempt = 0;
        return setTimeout(connect, 0);
      }
      retry();
    });

    socket.addEventListener("error", function () {
      if (socket) socket.close();
    });
  }

  function stopKeepalive() {
    if (keepalive) clearInterval(keepalive);
    keepalive = null;
  }

  /**
   * Every deploy evicts the Durable Object and drops every socket, so backoff
   * is not a nicety — it is how the page survives a release. Jittered, so a
   * roomful of organizers does not reconnect in lockstep.
   */
  function retry() {
    if (closed) return;
    attempt += 1;
    if (attempt > 12) return give_up();
    var delay = Math.min(30000, 1000 * Math.pow(2, attempt - 1));
    setTimeout(connect, delay * (0.8 + Math.random() * 0.4));
  }

  function give_up() {
    el.hidden = false;
    el.textContent = "Live updates disconnected. ";
    el.appendChild(reloadLink("Reload"));
  }

  // ---------------------------------------------------------------------------
  // What a change does
  // ---------------------------------------------------------------------------

  function announce(count) {
    pending += count;
    if (mode === "refresh") return scheduleRefresh();
    nudge();
  }

  function nudge() {
    el.hidden = false;
    el.textContent = pending === 1 ? "1 change since you loaded this. " : pending + " changes since you loaded this. ";
    el.appendChild(reloadLink("Reload"));
  }

  function reloadLink(label) {
    var a = document.createElement("a");
    a.href = location.href;
    a.textContent = label;
    return a;
  }

  /**
   * Refresh mode re-fetches the URL we are already on and swaps `<main>`. No
   * new endpoint, so authorization, redaction and blinding are byte-identical
   * to a normal load — there is nothing here for a second rendering contract
   * to get wrong.
   */
  function scheduleRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 1000);
  }

  function refresh() {
    // The guard that makes this safe rather than clever: never swap HTML out
    // from under someone who is typing. Falling back to the nudge lets them
    // finish and reload when they choose.
    if (isDirty()) return nudge();

    fetch(location.href, { headers: { accept: "text/html" }, credentials: "same-origin" })
      .then(function (res) {
        var type = res.headers.get("content-type") || "";
        if (!res.ok || type.indexOf("text/html") === -1) throw new Error("not html");
        return res.text();
      })
      .then(function (body) {
        var next = new DOMParser().parseFromString(body, "text/html").querySelector("main");
        var current = document.querySelector("main");
        if (!next || !current || isDirty()) throw new Error("nothing to swap");
        current.replaceChildren.apply(current, Array.prototype.slice.call(next.childNodes));
        pending = 0;
        el.hidden = true;
        el.textContent = "";
      })
      .catch(function () {
        // Anything unexpected — a redirect to the login page, a 500, a race
        // with an edit — degrades to the mode that cannot lose anything.
        nudge();
      });
  }

  /** Any control inside `<main>` the reader has touched. */
  function isDirty() {
    var main = document.querySelector("main");
    if (!main) return false;
    var controls = main.querySelectorAll("input, textarea, select");
    for (var i = 0; i < controls.length; i++) {
      var c = controls[i];
      if (c.type === "hidden" || c.type === "submit" || c.type === "button") continue;
      if (c.tagName === "SELECT" || c.type === "checkbox" || c.type === "radio") {
        if (c.dataset.podiumTouched) return true;
        continue;
      }
      if (c.defaultValue !== undefined && c.value !== c.defaultValue) return true;
    }
    return false;
  }

  // `defaultValue` cannot see a changed select or checkbox, so those announce
  // themselves once and are then remembered.
  document.addEventListener(
    "change",
    function (ev) {
      var t = ev.target;
      if (t && t.dataset) t.dataset.podiumTouched = "1";
    },
    true,
  );

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  // A backgrounded tab holding a socket is most of what a room would cost.
  var hiddenSince = null;
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      hiddenSince = setTimeout(function () {
        if (socket) socket.close(1000, "hidden");
        stopKeepalive();
        socket = null;
      }, 60000);
      return;
    }
    if (hiddenSince) clearTimeout(hiddenSince);
    hiddenSince = null;
    if (!socket || socket.readyState > 1) {
      attempt = 0;
      connect();
    }
  });

  window.addEventListener("pagehide", function () {
    closed = true;
    stopKeepalive();
    if (socket) socket.close(1000, "navigating");
  });

  connect();
})();
