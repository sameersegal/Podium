/**
 * The admin console's render kit — R30's "client-rendered admin console".
 *
 * Roughly 200 lines of keyed virtual DOM, deliberately, because the thing R30
 * bought with a second UI stack was drag-and-drop and data-dense screens, and
 * both of those are ruined by a renderer that replaces DOM it could have
 * patched: a re-render that recreates the node under the pointer cancels the
 * drag, and one that recreates an input loses the caret. So children are keyed
 * and moved rather than rebuilt, and a node whose position has not changed is
 * not touched at all.
 *
 * There is no build step. These are ES modules the browser loads directly, the
 * same way `/live.js` and `/admin.css` are served — an asset from the edge, no
 * bundler, no transpiler, no lockfile of its own. That constraint is what keeps
 * "two UI stacks" (R30's accepted cost) from also meaning two toolchains.
 */

const TEXT = "#text";
const SVG_NS = "http://www.w3.org/2000/svg";

/** Properties that must be set on the node, not as attributes. */
const DOM_PROPS = new Set(["value", "checked", "selected", "indeterminate", "disabled"]);

/* -------------------------------------------------------------------------- */
/* Building                                                                    */
/* -------------------------------------------------------------------------- */

export function h(tag, props, ...children) {
  let p = props && typeof props === "object" && props.tag === undefined && !Array.isArray(props) ? props : null;
  const rest = p ? children : [props, ...children];
  p = p || {};
  let key = null;
  if (p.key != null) {
    key = String(p.key);
    p = Object.assign({}, p);
    delete p.key;
  }
  return { tag, key, props: p, children: normalise(rest), text: null, _dom: null };
}

/** `null`, `false` and `undefined` are "render nothing", so a view can use `&&`. */
function normalise(list, out = []) {
  for (const c of list) {
    if (c == null || c === false || c === true) continue;
    if (Array.isArray(c)) normalise(c, out);
    else if (typeof c === "object" && c.tag !== undefined) out.push(c);
    else out.push({ tag: TEXT, key: null, props: {}, children: [], text: String(c), _dom: null });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Patching                                                                    */
/* -------------------------------------------------------------------------- */

export function render(vnode, container) {
  const old = container._vnode ? [container._vnode] : [];
  const next = vnode ? [vnode] : [];
  patchChildren(container, old, next, false);
  container._vnode = next[0] || null;
}

function createDom(v, isSvg) {
  if (v.tag === TEXT) return document.createTextNode(v.text);
  return isSvg || v.tag === "svg" ? document.createElementNS(SVG_NS, v.tag) : document.createElement(v.tag);
}

function patch(ov, nv, isSvg) {
  const svg = isSvg || nv.tag === "svg";
  if (!ov || ov.tag !== nv.tag) {
    const dom = (nv._dom = createDom(nv, isSvg));
    if (nv.tag !== TEXT) {
      patchProps(dom, {}, nv.props, svg);
      patchChildren(dom, [], nv.children, svg);
      // `ref` fires once, on creation. Firing it every render would mean an
      // inline arrow re-running on every keystroke somewhere on the screen.
      if (typeof nv.props.ref === "function") nv.props.ref(dom);
    }
    return dom;
  }
  const dom = (nv._dom = ov._dom);
  if (nv.tag === TEXT) {
    if (nv.text !== ov.text) dom.nodeValue = nv.text;
    return dom;
  }
  patchProps(dom, ov.props, nv.props, svg);
  patchChildren(dom, ov.children, nv.children, svg);
  return dom;
}

function patchProps(dom, oldP, newP, isSvg) {
  for (const k in oldP) if (!(k in newP)) removeProp(dom, k, isSvg);
  for (const k in newP) {
    if (k === "ref") continue;
    const next = newP[k];
    // A DOM property is re-asserted even when the vnode value is unchanged:
    // the user may have typed into it since the last render, and the view is
    // the authority on what it should say.
    if (next === oldP[k] && !DOM_PROPS.has(k)) continue;
    setProp(dom, k, next, isSvg);
  }
}

function setProp(dom, k, v, isSvg) {
  if (k.charCodeAt(0) === 111 && k.charCodeAt(1) === 110) {
    // on*, assigned rather than addEventListener'd so replacing a handler
    // needs no bookkeeping and a removed one cannot leak.
    dom[k.toLowerCase()] = typeof v === "function" ? v : null;
    return;
  }
  if (k === "style") {
    if (typeof v === "string") dom.style.cssText = v;
    else {
      dom.style.cssText = "";
      for (const s in v) if (v[s] != null) dom.style.setProperty(s, String(v[s]));
    }
    return;
  }
  if (k === "class" || k === "className") {
    const value = v == null || v === false ? "" : String(v);
    if (isSvg) dom.setAttribute("class", value);
    else if (dom.className !== value) dom.className = value;
    return;
  }
  if (k === "html") {
    if (dom.innerHTML !== v) dom.innerHTML = v == null ? "" : String(v);
    return;
  }
  if (DOM_PROPS.has(k)) {
    const value = v == null ? (k === "value" ? "" : false) : v;
    if (dom[k] !== value) dom[k] = value;
    return;
  }
  if (v == null || v === false) {
    dom.removeAttribute(k);
    return;
  }
  const attr = v === true ? "" : String(v);
  if (dom.getAttribute(k) !== attr) dom.setAttribute(k, attr);
}

function removeProp(dom, k, isSvg) {
  if (k.charCodeAt(0) === 111 && k.charCodeAt(1) === 110) {
    dom[k.toLowerCase()] = null;
    return;
  }
  if (k === "ref") return;
  if (k === "style") {
    dom.style.cssText = "";
    return;
  }
  if (k === "class" || k === "className") {
    if (isSvg) dom.setAttribute("class", "");
    else dom.className = "";
    return;
  }
  if (k === "html") {
    dom.innerHTML = "";
    return;
  }
  if (DOM_PROPS.has(k)) {
    dom[k] = k === "value" ? "" : false;
    return;
  }
  dom.removeAttribute(k);
}

/**
 * Keyed children. Matching is by `key` where one is given and by position
 * among the unkeyed remainder where none is, so a list may mix the two — a
 * heading followed by keyed rows is the common case and should not force keys
 * onto the heading.
 */
function patchChildren(parent, oldCh, newCh, isSvg) {
  const byKey = new Map();
  const unkeyed = [];
  for (const c of oldCh) {
    if (c.key != null) byKey.set(c.key, c);
    else unkeyed.push(c);
  }

  const matched = new Set();
  let cursor = 0;
  for (const nv of newCh) {
    let ov = null;
    if (nv.key != null) {
      ov = byKey.get(nv.key) || null;
      // Consumed on match, so two children that share a key cannot both claim
      // the same DOM node — the second would then be *the same element* as the
      // first, and the tree would silently lose a node. Duplicate keys in one
      // parent are a bug in the view; this keeps them from becoming a bug in
      // the renderer as well.
      if (ov) byKey.delete(nv.key);
    } else {
      while (cursor < unkeyed.length) {
        const cand = unkeyed[cursor++];
        if (cand.tag === nv.tag) {
          ov = cand;
          break;
        }
      }
    }
    if (ov) matched.add(ov);
    patch(ov, nv, isSvg);
  }

  // Place in order, walking backwards so each node's reference point is the
  // node that should follow it. A node already in position is left alone —
  // moving it would blur a focused input and abort an in-flight drag.
  let ref = null;
  for (let i = newCh.length - 1; i >= 0; i--) {
    const dom = newCh[i]._dom;
    if (dom.parentNode !== parent || dom.nextSibling !== ref) parent.insertBefore(dom, ref);
    ref = dom;
  }

  for (const ov of oldCh) {
    if (matched.has(ov)) continue;
    if (ov._dom && ov._dom.parentNode === parent) parent.removeChild(ov._dom);
  }
}

/* -------------------------------------------------------------------------- */
/* The redraw loop                                                             */
/* -------------------------------------------------------------------------- */

let rootView = null;
let rootNode = null;
let scheduled = false;

export function mount(container, view) {
  rootNode = container;
  rootView = view;
  draw();
}

/**
 * Coalesced to one paint. Every mutation in the console calls this without
 * checking whether anything else already did, so the guard is the contract.
 */
export function redraw() {
  if (scheduled || !rootView) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    draw();
  });
}

function draw() {
  if (!rootView || !rootNode) return;
  try {
    render(rootView(), rootNode);
  } catch (err) {
    console.error("console render failed", err);
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/* Small helpers the views share                                               */
/* -------------------------------------------------------------------------- */

/** Class list from strings and conditionals: `cx("btn", active && "on")`. */
export function cx(...parts) {
  return parts.filter(Boolean).join(" ");
}

/** Debounce a handler — search boxes, autosaving inspectors. */
export function debounce(fn, ms) {
  let t = null;
  return function (...args) {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      fn.apply(this, args);
    }, ms);
  };
}
