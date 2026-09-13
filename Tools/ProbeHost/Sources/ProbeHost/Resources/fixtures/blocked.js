// SPDX-License-Identifier: GPL-3.0-or-later
// blocked.js - this file must never execute in a run with the self-check list attached.
// If it does, either the rule list did not block it or nothing was attached; both are
// recorded, and the fixture server's own hit count says which.
window.__probeFixture = window.__probeFixture || {};
window.__probeFixture.blocked = true;
