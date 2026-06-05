# Claude LiteLLM local proxy

This proxy is for debugging Claude Code requests that go through an
Anthropic-compatible LiteLLM endpoint.

It forwards requests unchanged to the upstream base URL and logs both request
and response bodies locally. Sensitive headers are redacted in log metadata by
default, but they are still forwarded unchanged to the upstream server.

## Start

```powershell
npm run claude-proxy -- --port 18081 --upstream https://litellm.hypergryph.net
```

Defaults:

```text
listen:   http://127.0.0.1:18081
upstream: https://litellm.hypergryph.net
logs:     %USERPROFILE%\.chatccc\logs\litellm-proxy
```

## Point Claude Code at the proxy

Temporarily set the Claude base URL to the local proxy:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:18081"
  }
}
```

Keep the existing auth token and model environment variables unchanged.

For ChatCCC's `config.json`, use:

```json
{
  "claude": {
    "baseUrl": "http://127.0.0.1:18081"
  }
}
```

## Logs

Each day gets its own directory:

```text
%USERPROFILE%\.chatccc\logs\litellm-proxy\YYYY-MM-DD\
```

Files:

```text
events.jsonl
<request-id>.request.body
<request-id>.response.body
```

`events.jsonl` records method, path, upstream URL, status, headers, body file
paths, byte counts, and duration.

To log sensitive headers in metadata for a short controlled debugging session:

```powershell
npm run claude-proxy -- --log-secrets
```

Do not share logs created with `--log-secrets`.
