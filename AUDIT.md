# Fiducia MCP test-harness security audit

Date: 2026-08-19

## Findings addressed

1. The generator-owned integration workflow accepted a protected-token fallback and only validated generated metadata; it did not execute the pinned MCP source.
2. A successful generic plan-only job could be confused with product-source certification.
3. The generated workflow path is fleet-owned, so product-specific executable checks placed there could be overwritten by a future fleet regeneration.
4. The public source and its Rust client dependency were not tested together from the paired `fiducia-cloud-test` organization.
5. Workflow and pin documents used ordinary JSON parsing and did not independently reject duplicate keys.

## Remediation

- Restored the generator-owned `integration.yml` as a source-access-only lane that can never set `certified: true`.
- Added the product-owned `exact-public-source-certification.yml` overlay.
- Pinned both the MCP server and Rust client dependency by full commit SHA.
- Added explicit HEAD verification, read-only permissions, no checkout token, non-persisted credentials, locked format, strict Clippy, release build, all-target tests, and documentation.
- Added a durable certification artifact whose `certified` value is true only after the exact executable job succeeds.
- Added strict JSON parsing, hostile workflow/pin mutations, and a scheduled policy-drift lane.

## Evidence boundary

The status artifact contains repository identities, immutable commit SHAs, execution result, and a bounded reason. It contains no provider response, user prompt, customer data, or credential.
