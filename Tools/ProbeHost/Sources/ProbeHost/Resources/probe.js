// SPDX-License-Identifier: GPL-3.0-or-later
//
// probe.js - the page-side half of the measurement (01-probehost.md section 4).
//
// Injected at document start into every frame, in the page world, so what it sees is
// what the page sees: an ad iframe's own resource timings, its own DOM, its own console.
// It observes and reports; it never blocks anything and never changes layout.
//
// Two deliberate limits, both recorded rather than hidden. Resource entries from a
// cross-origin response without Timing-Allow-Origin report transferSize 0, so byte
// totals are a lower bound. And the centre tap dispatched here is synthetic: isTrusted
// is false and WebKit grants it no user activation, so popup counts taken after it are
// indicative, never a pass criterion.

(function () {
  "use strict";

  if (window.__probe) { return; }

  var MAX_BATCH = 60;
  var FLUSH_MS = 250;
  // The sample of overlays kept per frame. `seen` is reported alongside it, so a cap
  // never turns "25 overlays" into "10" without saying so.
  var MAX_OVERLAYS = 10;
  var frameId = "f" + Math.random().toString(36).slice(2, 10);
  var pending = [];
  var flushTimer = null;

  function post(message) {
    try {
      window.webkit.messageHandlers.probe.postMessage(message);
    } catch (error) {
      // No handler in this frame (or the page removed it). Nothing to do: the Swift
      // side counts frames it heard from, so a silent frame is visible as an absence.
    }
  }

  function flush() {
    flushTimer = null;
    if (!pending.length) { return; }
    var batch = pending.splice(0, pending.length);
    post({ k: "res", fid: frameId, e: batch });
  }

  function scheduleFlush() {
    if (flushTimer !== null) { return; }
    flushTimer = setTimeout(flush, FLUSH_MS);
  }

  // ---- resources -----------------------------------------------------------------

  try {
    var observer = new PerformanceObserver(function (list) {
      var entries = list.getEntries();
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        pending.push([
          String(entry.name || ""),
          String(entry.initiatorType || "other"),
          Math.max(0, Math.round(entry.transferSize || 0)),
          Math.max(0, Math.round(entry.duration || 0)),
        ]);
        if (pending.length >= MAX_BATCH) { flush(); }
      }
      scheduleFlush();
    });
    observer.observe({ type: "resource", buffered: true });
  } catch (error) {
    post({ k: "console", level: "warn", text: "PerformanceObserver unavailable: " + error });
  }

  // ---- popups --------------------------------------------------------------------

  try {
    var nativeOpen = window.open;
    Object.defineProperty(window, "open", {
      configurable: true,
      writable: true,
      value: function () {
        var target = arguments.length ? String(arguments[0] || "") : "";
        var active = null;
        try {
          active = navigator.userActivation ? !!navigator.userActivation.isActive : null;
        } catch (error) { active = null; }
        post({ k: "open", u: target, act: active });
        try {
          return nativeOpen.apply(window, arguments);
        } catch (error) {
          return null;
        }
      },
    });
  } catch (error) {
    post({ k: "console", level: "warn", text: "window.open could not be wrapped" });
  }

  // ---- console and errors --------------------------------------------------------

  function wrapConsole(level) {
    try {
      var original = console[level];
      console[level] = function () {
        var parts = [];
        for (var i = 0; i < arguments.length; i++) {
          try { parts.push(String(arguments[i])); } catch (error) { parts.push("?"); }
        }
        post({ k: "console", level: level, text: parts.join(" ").slice(0, 300) });
        if (typeof original === "function") { original.apply(console, arguments); }
      };
    } catch (error) { /* a page may freeze console; not measurable, not fatal */ }
  }
  wrapConsole("error");
  wrapConsole("warn");

  window.addEventListener("error", function (event) {
    var text = event && event.message ? String(event.message) : "error";
    post({ k: "console", level: "error", text: text.slice(0, 300) });
  }, true);

  window.addEventListener("unhandledrejection", function (event) {
    var reason = "";
    try { reason = String(event.reason); } catch (error) { reason = "?"; }
    post({ k: "console", level: "error", text: ("unhandledrejection: " + reason).slice(0, 300) });
  }, true);

  // Free, and useful ahead of the M3 $csp work: a violation names the directive that
  // stopped a load, which is exactly the evidence a CSP experiment needs.
  document.addEventListener("securitypolicyviolation", function (event) {
    post({
      k: "console",
      level: "warn",
      text: ("csp: " + (event.violatedDirective || "") + " " + (event.blockedURI || "")).slice(0, 300),
    });
  }, true);

  // ---- measurement helpers -------------------------------------------------------

  function isVisible(element) {
    try {
      if (!element.getClientRects().length) { return false; }
      var style = getComputedStyle(element);
      if (!style) { return false; }
      if (style.display === "none" || style.visibility === "hidden") { return false; }
      if (parseFloat(style.opacity || "1") < 0.1) { return false; }
      return true;
    } catch (error) {
      return false;
    }
  }

  // Per-selector counts double-count: the @common ad selectors overlap, so one element
  // matching three of them was counted three times in `totalMatched`. The rows are kept
  // as they were (they say which selector fired), and `uniqueTotal`/`uniqueVisible` add
  // the count of distinct elements in this frame, which is what "ads visible" means.
  // `frameVisible` says whether this frame is itself on screen: an element inside an
  // iframe the page has hidden is not visible to a person, however visible it is to
  // getComputedStyle inside that frame.
  function count(selectors) {
    var rows = [];
    var list = selectors || [];
    var seen = [];
    var seenVisible = [];
    var hasSet = typeof Set === "function";
    var uniqueAll = hasSet ? new Set() : null;
    var uniqueVisible = hasSet ? new Set() : null;
    for (var i = 0; i < list.length; i++) {
      var selector = list[i];
      var row = { selector: String(selector), total: 0, visible: 0, error: null };
      var found = null;
      try {
        found = document.querySelectorAll(selector);
      } catch (error) {
        // An invalid selector records the error and counts zero; it never throws, so
        // one bad entry in a scenario cannot cost a whole run.
        row.error = String(error && error.message ? error.message : error).slice(0, 120);
        rows.push(row);
        continue;
      }
      row.total = found.length;
      for (var j = 0; j < found.length; j++) {
        var node = found[j];
        var visible = isVisible(node);
        if (visible) { row.visible += 1; }
        if (hasSet) {
          uniqueAll.add(node);
          if (visible) { uniqueVisible.add(node); }
        } else {
          if (seen.indexOf(node) === -1) { seen.push(node); }
          if (visible && seenVisible.indexOf(node) === -1) { seenVisible.push(node); }
        }
      }
      rows.push(row);
    }
    var frameVisible = true;
    try {
      if (window !== window.top) {
        frameVisible = !!(document.documentElement &&
          document.documentElement.getClientRects().length > 0) &&
          window.innerWidth > 0 && window.innerHeight > 0;
      }
    } catch (error) { frameVisible = true; }
    return {
      rows: rows,
      uniqueTotal: hasSet ? uniqueAll.size : seen.length,
      uniqueVisible: hasSet ? uniqueVisible.size : seenVisible.length,
      frameVisible: frameVisible,
    };
  }

  // `seen` is every overlay that met the threshold; `rows` is the sample kept. Without
  // the pair, a page with 25 overlays and a page with 10 both reported 10 and the
  // blocked-minus-none delta was silently zero.
  function overlays() {
    var found = [];
    var seen = 0;
    var viewport = Math.max(1, window.innerWidth * window.innerHeight);
    var all;
    try { all = document.body ? document.body.querySelectorAll("*") : []; } catch (error) { all = []; }
    for (var i = 0; i < all.length; i++) {
      var element = all[i];
      var tag = (element.tagName || "").toLowerCase();
      if (tag === "html" || tag === "body") { continue; }
      var style;
      try { style = getComputedStyle(element); } catch (error) { continue; }
      if (!style || (style.position !== "fixed" && style.position !== "sticky")) { continue; }
      if (!isVisible(element)) { continue; }
      var rect = element.getBoundingClientRect();
      var fraction = (rect.width * rect.height) / viewport;
      if (fraction < 0.25) { continue; }
      seen += 1;
      if (found.length >= MAX_OVERLAYS) { continue; }
      var classes = String(element.className || "").split(/\s+/).filter(Boolean).slice(0, 2);
      found.push({
        tag: tag,
        id: String(element.id || ""),
        "class": classes.join(" "),
        areaFraction: Math.round(fraction * 1000) / 1000,
        zIndex: parseInt(style.zIndex, 10) || 0,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        position: style.position,
      });
    }
    return { rows: found, seen: seen, truncated: seen > found.length };
  }

  function state(config) {
    var matched = [];
    var text = "";
    try { text = (document.body ? document.body.innerText || "" : "").slice(0, 20000).toLowerCase(); }
    catch (error) { text = ""; }
    var names = Object.keys(config || {});
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var matcher = config[name] || {};
      var fragments = matcher.text || [];
      for (var j = 0; j < fragments.length; j++) {
        var fragment = String(fragments[j]).toLowerCase();
        if (fragment && text.indexOf(fragment) !== -1) { matched.push([name, "text:" + fragment]); }
      }
      var selectors = matcher.selectors || [];
      for (var k = 0; k < selectors.length; k++) {
        try {
          var element = document.querySelector(selectors[k]);
          if (element && isVisible(element)) { matched.push([name, "selector:" + selectors[k]]); }
        } catch (error) { /* an unparseable matcher matches nothing */ }
      }
    }
    return { title: String(document.title || ""), matched: matched };
  }

  function tap() {
    var x = Math.round(window.innerWidth / 2);
    var y = Math.round(window.innerHeight / 2);
    var target = null;
    try { target = document.elementFromPoint(x, y); } catch (error) { target = null; }
    if (!target) {
      return { performed: false, x: x, y: y, targetTag: null, targetOrigin: location.origin,
               userActivationAfter: false };
    }
    var options = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
    var kinds = [
      ["pointerdown", "PointerEvent"], ["mousedown", "MouseEvent"],
      ["pointerup", "PointerEvent"], ["mouseup", "MouseEvent"], ["click", "MouseEvent"],
    ];
    for (var i = 0; i < kinds.length; i++) {
      try {
        var constructor = window[kinds[i][1]] || window.Event;
        target.dispatchEvent(new constructor(kinds[i][0], options));
      } catch (error) { /* an event type this WebKit lacks is skipped, not fatal */ }
    }
    try {
      var anchor = target.closest ? target.closest("a") : null;
      if (anchor && typeof anchor.click === "function") { anchor.click(); }
    } catch (error) { /* the anchor refused; the dispatched click already happened */ }
    var active = false;
    try { active = navigator.userActivation ? !!navigator.userActivation.isActive : false; }
    catch (error) { active = false; }
    return {
      performed: true,
      x: x,
      y: y,
      targetTag: (target.tagName || "").toLowerCase(),
      targetOrigin: location.origin,
      userActivationAfter: active,
    };
  }

  function scroll(dy) {
    try { if (dy) { window.scrollBy(0, dy); } } catch (error) { /* ignore */ }
    return Math.round(window.scrollY || 0);
  }

  function fixture() {
    // A fixture may expose a snapshot function when the facts are live rather than
    // static - whether the ad slot is visible right now, for instance. Falling back
    // to the plain object keeps every other fixture working unchanged.
    try {
      if (typeof window.__probeFixtureSnapshot === "function") {
        return window.__probeFixtureSnapshot();
      }
    } catch (error) { /* a fixture that throws reports the static object instead */ }
    return window.__probeFixture || null;
  }

  window.__probe = {
    fid: frameId,
    count: count,
    overlays: overlays,
    state: state,
    tap: tap,
    scroll: scroll,
    fixture: fixture,
    flush: flush,
  };

  post({ k: "hello", fid: frameId, href: String(location.href).split("?")[0], main: window === window.top });
  window.addEventListener("pagehide", flush, true);
})();
