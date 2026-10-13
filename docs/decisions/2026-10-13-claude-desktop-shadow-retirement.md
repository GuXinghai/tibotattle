---
title: Retire the unavailable Claude Desktop shadow prototype
date: 2026-10-13
type: decision-record
status: accepted
---

# Retire the unavailable Claude Desktop shadow prototype

The owner approved retirement of the unavailable Claude Desktop shadow feature
as part of the [Windows-only cutover](2026-10-12-windows-only.md).
The existing prototype had no working Windows collection implementation and no
shipping settings, route, UI, or upload surface.

Remove the provider-isolated shadow modules, their synthetic fixtures and tests,
the benchmark worker and inventory record, companion injection and path
configuration, and shadow-only refresh callback. Add retired modules to the
architecture ratchet so they cannot return as compatibility shims.

Generic Claude provider normalization and published hosted telemetry contracts
remain separate capabilities. This decision does not change their schemas.
No source data or existing local state is deleted. Previously written prototype
artifacts require a separately authorized, receipt-backed deletion workflow.

The August prototype decision, research, and implementation receipt remain
historical audit evidence. Their retired source references identify the old
implementation rather than maintained interfaces. This source retirement does
not establish installed-artifact, release, updater, or deployment qualification.
