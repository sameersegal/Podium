# The four readings

One `browser_evaluate` per screen, after you have looked at the screenshot and before you
write the note. This is not a driver and never becomes one: it presses nothing, decides
nothing and cannot move you through the product. It reads the page you are already standing
on, for the four things an eye is unreliable about — especially an eye that has just spent ten
minutes on this flow and has started seeing what it expects.

Pass it to `browser_evaluate` as the `function` argument, exactly as it is. It takes no
arguments and returns a plain object.

```js
() => {
  const INTERACTIVE =
    'a[href], button, input, select, textarea, summary, [role="button"], [tabindex]:not([tabindex="-1"])';

  // Words on a screen that belong to the people who built it rather than the
  // person reading it. The repository forbids these in rendered strings, so one
  // showing up here is the cheapest possible evidence that a screen was finished
  // by somebody thinking about the schema.
  const JARGON = [
    ["invariant citation", /\bINV-\d{2}-\d+\b/g],
    ["decision record", /\bR\d{1,2}\b(?=[\s,.)—:])/g],
    ["column or entity name", /\b[a-z]{3,}(?:_[a-z]{2,}){1,}\b/g],
    ["context number", /\((?:0[0-9]|1[0-5])\)/g],
  ];

  const text = document.body.innerText || "";
  const jargon = [];
  for (const [kind, re] of JARGON) {
    const seen = new Set();
    let m;
    while ((m = re.exec(text)) !== null) {
      if (seen.has(m[0])) continue;
      seen.add(m[0]);
      const at = Math.max(0, m.index - 40);
      jargon.push({
        kind,
        term: m[0],
        context: text.slice(at, m.index + m[0].length + 40).replace(/\s+/g, " "),
      });
    }
  }

  const phone = window.innerWidth <= 600;
  const smallTargets = [];
  if (phone) {
    for (const el of document.querySelectorAll(INTERACTIVE)) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (getComputedStyle(el).visibility === "hidden") continue;
      if (r.height < 44 || r.width < 24) {
        smallTargets.push({
          text: (el.innerText || el.value || el.getAttribute("aria-label") || el.tagName)
            .trim()
            .slice(0, 40),
          size: Math.round(r.width) + "x" + Math.round(r.height),
        });
      }
    }
  }

  const fields = [...document.querySelectorAll("input, select, textarea")].filter(
    (el) => !["hidden", "submit", "button"].includes(el.type),
  );
  const unlabelled = fields
    .filter(
      (el) =>
        !(
          el.labels?.length > 0 ||
          el.getAttribute("aria-label") ||
          el.getAttribute("aria-labelledby") ||
          el.closest("label")
        ),
    )
    .map((el) => el.name || el.id || el.tagName);

  return {
    viewport: window.innerWidth + "x" + window.innerHeight,
    horizontalScroll:
      document.documentElement.scrollWidth > window.innerWidth + 1
        ? { scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }
        : null,
    jargon,
    smallTargets,
    unlabelledFields: unlabelled,
    fieldCount: fields.length,
    requiredFieldCount: fields.filter(
      (el) => el.required || el.getAttribute("aria-required") === "true",
    ).length,
    title: document.title || null,
    h1: document.querySelector("h1")?.innerText?.trim() ?? null,
  };
}
```

## What each reading is for, and what it is not

| | Catches | Never means |
|---|---|---|
| `horizontalScroll` | A layout that overflows at this width. Invisible on a desktop, infuriating on a phone | That the page is fine when it is null |
| `jargon` | The maker's vocabulary on a user's screen — a column name, an invariant, an internal code | That every hit is a defect. Read the `context`; ordinary English contains underscores rarely and false positives happen |
| `smallTargets` | Tap targets under 44 px, phone widths only. The ones that matter are the ones in the flow you are walking | That a small link in a footer ruined anything |
| `unlabelledFields` | A field a screen reader cannot name, and usually one a person cannot either | Anything about whether the label is *good* |
| `fieldCount` / `requiredFieldCount` | What this screen is about to charge you. Useful beside how many of those answers the product already had | A judgement on its own |

A screen can pass all five and be miserable. A screen can fail one and be a delight everywhere
that matters. These are evidence for a sentence you were going to write anyway — never the
sentence.
