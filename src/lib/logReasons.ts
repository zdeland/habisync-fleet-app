// Parsing `logs.message` for DISPLAY only.
//
// docs/automation-rules.md §11 is emphatic that no decision rule may key off
// this text, and firmware 0.32.0 proved the point: it rewrote the lighting
// outlets' reason from `scheduled day window`/`scheduled night window` to
// `inside its scheduled window`/`outside its scheduled window`, which would
// have silently broken anything matching the old strings. Everything here
// degrades to "render the raw message" when the text changes shape, which is
// the only reason it is allowed to look at the text at all.

// Outlet transition messages read "Heater [1] turned ON — temperature below
// target range" — keep only the reason after the dash for the compact
// per-outlet display, drop the "what turned on/off" part (already shown by
// the icon + ON/OFF label right above it).
export function reasonOnly(message: string) {
  const match = message.match(/[-—]\s*(.*)$/);
  return match ? match[1] : message;
}

// A human pressing a button on the device dashboard drives the real
// ClimateController and real outlets — it's not a sandbox — so a
// test-triggered transition logs through the exact same tag='event' path as
// a real one, and the only distinguishing signal is the reason text.
//
// There are two such prefixes, from two different buttons, and they are not
// one family with a shared convention:
//
//   "test: "     — /climate-test's gauge-drag UI, which feeds a fake
//                  temp/humidity reading through the real decision logic
//                  (docs/known-issues.md). Colon, then the reason the fake
//                  reading produced: "test: temperature below target range".
//   "test pulse" — the manual mister check (firmware 0.32.0, §11's table).
//                  No colon, and the whole reason: "test pulse — manual
//                  mister check" opening, "test pulse complete" closing.
//
// Match them as literal prefixes rather than on a bare leading "test", which
// would also swallow any future reason that merely starts with the word.
//
// Treat this as a list that GROWS. It gained an entry the moment firmware
// added a second manual-action button, under a naming scheme that shares
// nothing with the first; there is no rule to infer, only the current set.
export const TEST_REASON_PREFIXES = ['test:', 'test pulse'];

// True for a transition a person triggered by hand rather than one the
// automation decided on. Render these distinctly so neither is mistaken for
// a real climate decision, and — per §11 — exclude them from any anomaly
// check, which is why this lives in lib/ and not inside the component that
// currently happens to be its only caller.
export function isTestReason(reason: string) {
  const text = reasonOnly(reason).trim().toLowerCase();
  return TEST_REASON_PREFIXES.some((prefix) => text.startsWith(prefix));
}
