# Retool MCP client

Retool Git Sync is not part of the canonical deployment path for this repository.
The supported control plane is Retool's native MCP endpoint:

```text
https://alexmills.retool.com/mcp
```

The repository includes `tools/retool-mcp-client.mjs`, a dependency-free Node 22+
Streamable HTTP MCP client. It performs the MCP initialize handshake, preserves
`Mcp-Session-Id`, handles JSON and SSE responses, lists tools, and invokes tools.
Credentials are supplied only at runtime and are never committed.

## Authentication

Set `RETOOL_MCP_TOKEN` in the current process using a secure shell/session secret
mechanism. Do not put the token in `.env`, repository files, workflow YAML, issue
comments, or command arguments.

The client sends the value as a bearer token to Retool MCP. If Retool rejects the
bearer with HTTP 401, use Retool's OAuth MCP login flow instead and provide the
resulting access token through the same environment variable.

## Discover the live Retool tool schemas

Always discover tool schemas before invoking mutating tools:

```bash
node tools/retool-mcp-client.mjs relevant-tools
```

This is important because Retool controls the current argument schema for tools
such as app lookup, React source inspection, prepared import, approvals, and
publish.

To inspect every exposed MCP tool:

```bash
node tools/retool-mcp-client.mjs tools
```

## Canonical demo reconciliation

The existing canonical demo app is fixed to this UUID:

```text
1cd19646-b3d9-11f1-91c2-077431b23c20
```

Before any import or publish:

1. Discover the live input schema for `retool_get_app` and invoke it for the exact
   UUID above.
2. Discover and invoke the React-app thread/list/read tools.
3. Inventory every current Retool source file with the React app file-list tool.
4. Read every behavior-bearing source file from Retool.
5. Compare those files semantically against the authored `app/` tree and a fresh
   `build/canonical-demo/` generated from GitHub `main`.
6. Port intentional Retool-only behavior back into Git and tests before replacing
   the deployed source.

Generic tool invocation uses the live tool schema returned by `tools/list`:

```bash
node tools/retool-mcp-client.mjs call <tool-name> '<json-arguments>'
```

Do not guess argument names for Retool tools. Read the tool's `inputSchema` first.

## Import GitHub main into the existing Retool app

Generate the candidate from the repository source of truth:

```bash
cargo run --locked --manifest-path tools/project-check/Cargo.toml -- generate . canonical-demo
```

Then use the MCP prepared-import tools returned by `relevant-tools`. The prepared
import must target the exact existing app UUID; never create a second
`canonical-demo` app.

After the prepared import is finalized:

1. inspect the preview thread;
2. test existing save/submit/draft/attachment/review behavior;
3. verify these URL states select the expected questionnaire:
   - `?form=nist_csf_2`
   - `?form=iso_27001`
   - `?form=soc_2`
   - `?view=review`
4. inspect any publish-blocking mutating-function approvals;
5. approve only the expected functions;
6. publish with Retool MCP only after the preview is healthy.

## Safety rules

- Never use Retool Git Sync to overwrite the existing Retool workspace.
- Never create a replacement canonical-demo app when an exact target UUID exists.
- Never print or persist the bearer/OAuth token.
- Never publish before source reconciliation and preview verification.
- GitHub remains the long-lived source of truth after Retool-only behavior has
  been salvaged and reconciled.
