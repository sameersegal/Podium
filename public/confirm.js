/**
 * "Are you sure?" for destructive actions, and the error page's Go back link.
 *
 * These were `onsubmit="return confirm('…')"` attributes and one
 * `href="javascript:history.back()"`. Both are inline script as far as CSP is
 * concerned, and no nonce can rescue them — a nonce applies to an element, and
 * an event-handler attribute is not one. They were the only reason `script-src`
 * still carried `'unsafe-inline'`, which is the directive that makes the rest
 * of the policy worth having.
 *
 * So the markup now declares intent — `data-confirm`, `data-back` — and the
 * behaviour lives here, in a file `script-src 'self'` already allows.
 *
 * Delegated from `document`, so it covers markup that did not exist when this
 * ran. Deliberately not a module: it must run on every admin page including the
 * ones rendered before the console takes over.
 */
(function () {
  "use strict";

  document.addEventListener(
    "submit",
    function (event) {
      var form = event.target;
      if (!form || !form.getAttribute) return;
      var message = form.getAttribute("data-confirm");
      if (!message) return;
      if (!window.confirm(message)) event.preventDefault();
    },
    // Capture: a listener added later by the console must not be able to
    // observe a submit this one is about to cancel.
    true,
  );

  /**
   * Buttons carry their own `data-confirm` where one form has several actions
   * and only one of them is destructive — `submitter` is which button was
   * actually pressed, so the other buttons stay silent.
   */
  document.addEventListener(
    "click",
    function (event) {
      var el = event.target.closest ? event.target.closest("[data-confirm]") : null;
      if (!el || el.tagName === "FORM") return;
      if (el.tagName !== "BUTTON" && el.tagName !== "A") return;
      if (!window.confirm(el.getAttribute("data-confirm"))) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    true,
  );

  document.addEventListener("click", function (event) {
    var back = event.target.closest ? event.target.closest("[data-back]") : null;
    if (!back) return;
    event.preventDefault();
    // No history to go back to (a page opened directly, or the first in a tab)
    // would leave the link dead, so fall through to somewhere real.
    if (window.history.length > 1) window.history.back();
    else window.location.href = "/";
  });
})();
