/**
 * Dragging, on pointer events.
 *
 * Not HTML5 drag-and-drop: `dragstart` never fires on a touchscreen, so a
 * builder built on it is a builder that cannot be used on the device half the
 * organizers will open it on. Pointer events cover mouse, pen and touch with
 * one code path.
 *
 * Dragging is never the only way to do anything here. Every draggable row also
 * carries move-up and move-down buttons, because a drag is not reachable from a
 * keyboard and "reorder the form" is not an optional capability. This module is
 * the pointing-device affordance for an operation that already exists.
 *
 * The DOM contract, so a view can opt in by rendering attributes rather than
 * by wiring handlers:
 *
 *   [data-dnd-group="<kind>"][data-dnd-id="<groupId>"]   a drop container
 *   [data-dnd-item="<kind>"][data-dnd-id="<itemId>"]     something in it
 *
 * The view renders the insertion line itself from `drag.over`, so the drop
 * indicator is part of the same render pass as everything else and cannot
 * disagree with it.
 */

import { redraw } from "./kit.js";

export const drag = {
  /** `{kind, id, label, fromGroup}` while a drag is in flight, else null. */
  item: null,
  /** `{groupId, index}` — where it would land right now. */
  over: null,
  /** Viewport coordinates of the floating label. */
  x: 0,
  y: 0,
};

let onDrop = null;
let pointerId = null;
let moved = false;
let frame = null;

/**
 * Begin a drag from a grip's `onpointerdown`.
 *
 * `item.kind` must match the `data-dnd-group` of the containers it may be
 * dropped into, which is what keeps a field from being dropped into the list of
 * steps.
 */
export function beginDrag(ev, item, handler) {
  // Only the primary button, and never a modifier-click (which is a selection
  // gesture on every platform).
  if (ev.button !== 0 || ev.ctrlKey || ev.metaKey) return;
  ev.preventDefault();
  drag.item = item;
  drag.over = { groupId: item.fromGroup, index: item.fromIndex };
  drag.x = ev.clientX;
  drag.y = ev.clientY;
  onDrop = handler;
  pointerId = ev.pointerId;
  moved = false;

  // Captured on the document rather than the grip: the pointer leaves a 16px
  // grip immediately, and a drag that ends outside the element it started in
  // must still end.
  document.addEventListener("pointermove", onMove, { passive: false });
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onCancel);
  document.body.classList.add("console-dragging");
  redraw();
}

function onMove(ev) {
  if (drag.item == null || ev.pointerId !== pointerId) return;
  ev.preventDefault();
  drag.x = ev.clientX;
  drag.y = ev.clientY;
  moved = true;
  // Hit-testing reads layout, so it runs once per frame rather than once per
  // pointermove — a trackpad emits them faster than the page paints.
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = null;
    const next = hitTest(drag.item.kind, drag.x, drag.y);
    if (next && (!drag.over || next.groupId !== drag.over.groupId || next.index !== drag.over.index)) {
      drag.over = next;
    }
    redraw();
  });
}

function onUp() {
  const item = drag.item;
  const over = drag.over;
  const handler = onDrop;
  cleanup();
  if (!item || !over || !handler) return redraw();
  // A click that never moved is a click. The row's own handler already ran.
  if (!moved) return redraw();
  if (over.groupId === item.fromGroup && over.index === item.fromIndex) return redraw();
  handler(item, over.groupId, over.index);
  redraw();
}

function onCancel() {
  cleanup();
  redraw();
}

function cleanup() {
  drag.item = null;
  drag.over = null;
  onDrop = null;
  pointerId = null;
  if (frame) cancelAnimationFrame(frame);
  frame = null;
  document.removeEventListener("pointermove", onMove);
  document.removeEventListener("pointerup", onUp);
  document.removeEventListener("pointercancel", onCancel);
  document.body.classList.remove("console-dragging");
}

/**
 * Which container the pointer is over, and which index within it.
 *
 * Index is decided by each item's vertical midpoint: above the midpoint the
 * drop goes before that item, below it goes after. The dragged item is skipped
 * so that hovering over the gap it came from does not read as a move.
 */
function hitTest(kind, x, y) {
  const groups = document.querySelectorAll('[data-dnd-group="' + kind + '"]');
  let group = null;
  let nearest = Infinity;
  for (const el of groups) {
    const rect = el.getBoundingClientRect();
    if (y >= rect.top && y <= rect.bottom && x >= rect.left && x <= rect.right) {
      group = el;
      break;
    }
    // Outside every container — fall back to the closest one vertically, so a
    // drag that strays into a gutter still has somewhere to land.
    const distance = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
    if (distance < nearest) {
      nearest = distance;
      group = group || el;
      if (distance === 0) group = el;
    }
  }
  if (!group) return null;

  const items = group.querySelectorAll('[data-dnd-item="' + kind + '"]');
  let index = 0;
  for (const el of items) {
    if (el.dataset.dndId === drag.item.id) continue;
    const rect = el.getBoundingClientRect();
    if (y > rect.top + rect.height / 2) index++;
  }
  return { groupId: group.dataset.dndId, index };
}

/** True when the insertion line belongs immediately before `index` in `groupId`. */
export function dropsAt(groupId, index) {
  return Boolean(drag.item && drag.over && drag.over.groupId === groupId && drag.over.index === index);
}

/** True while `id` is the thing being dragged, so the view can dim its row. */
export function isDragging(id) {
  return Boolean(drag.item && drag.item.id === id);
}
