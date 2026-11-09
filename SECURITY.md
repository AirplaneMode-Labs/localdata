# Security policy

## Reporting a vulnerability

Email jtushar53@gmail.com with a description of the issue, steps to reproduce, and the affected
version or commit. You will receive an acknowledgement within 7 days.

We follow a 90-day coordinated disclosure window: we ask reporters to withhold public details for
up to 90 days from the first report, or until a fix is released, whichever comes first. We will
credit reporters who wish to be credited.

## Supported versions

| Version | Supported                                                                 |
| ------- | ------------------------------------------------------------------------- |
| none    | No release has been published yet. Only the `main` branch receives fixes. |

## Test key material

Any Ed25519 key material appearing in Airplane Mode Labs repositories (the RFC 8032 section 7.1
test vector) is published, non-secret test data. It must never be trusted outside tests. This
repository contains no key material of its own.

## Telemetry

This library collects no telemetry and makes no network requests, so there is nothing to opt out
of. Data written through the SDK stays in the browser's origin storage (OPFS or IndexedDB) of the
page that wrote it.
