// SPDX-License-Identifier: GPL-3.0-or-later
// allowed.js - the control. It must load in every mode; a run where it did not is a run
// that proves nothing about blocking, and every probe treats that as `unknown`.
window.__probeFixture = window.__probeFixture || {};
window.__probeFixture.allowed = true;
