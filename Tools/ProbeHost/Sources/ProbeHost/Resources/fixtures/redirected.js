// SPDX-License-Identifier: GPL-3.0-or-later
// redirected.js - the redirect target. Its execution is the whole evidence that
// WKWebpagePreferences._activeContentRuleListActionPatterns let a redirect action run.
window.__probeFixture = window.__probeFixture || {};
window.__probeFixture.redirected = true;
