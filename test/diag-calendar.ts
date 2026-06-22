import { withFreshPage } from "../src/browser/connect.js";

const PROBE = `(() => {
  const main = document.querySelector('[role="main"]');
  if (!main) return null;
  const el = main.querySelector('[data-eventid]');
  if (!el) return { none: true };
  const kids = Array.from(el.children).map((c) => ({
    tag: c.tagName,
    role: c.getAttribute('role'),
    al: c.getAttribute('aria-label'),
    cls: (c.className || '').toString().slice(0, 40),
    text: (c.textContent || '').trim().slice(0, 90),
  }));
  // also: does any descendant carry the full label as aria-label or jslog?
  const labelled = Array.from(el.querySelectorAll('[aria-label]')).map(
    (n) => n.getAttribute('aria-label'),
  );
  return {
    ownTag: el.tagName,
    ownRole: el.getAttribute('role'),
    ownAl: el.getAttribute('aria-label'),
    html: el.innerHTML.slice(0, 400),
    kids,
    labelled,
  };
})()`;

await withFreshPage(async (page) => {
  await page.goto("https://calendar.google.com/calendar/u/0/r/month/2026/4/1", {
    waitUntil: "domcontentloaded",
  });
  await page
    .waitForSelector('[role="main"] [data-eventid]', { timeout: 12000, state: "attached" })
    .catch(() => {});
  const res = await page.evaluate(PROBE);
  console.log(JSON.stringify(res, null, 2));
});
process.exit(0);
