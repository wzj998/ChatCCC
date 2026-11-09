# Claude LiteLLM local proxy

This proxy is for debugging Claude Code requests that go through an
Anthropic-compatible LiteLLM endpoint.

It forwards requests unchanged to the upstream base URL and logs both request
and response bodies locally. Sensitive headers are redacted in log metadata by
default, but they are still forwarded unchanged to the upstream server.

## Start

```powershell
npm run claude-proxy -- --port 18081 --upstream https://api.example.com
```

Defaults:

```text
listen:   http://127.0.0.1:18081
upstream: required via --upstream or CHATCCC_LITELLM_PROXY_UPSTREAM
logs:     %USERPROFILE%\.chatccc\logs\litellm-proxy
```

Replace the example URL with your own HTTP(S) endpoint. The proxy has no built-in
upstream address and exits before listening or creating logs if no address is
configured. Command-line `--upstream` takes precedence over the environment.

Alternatively, set the upstream only in your local environment:

```powershell
$env:CHATCCC_LITELLM_PROXY_UPSTREAM = "https://api.example.com"
npm run claude-proxy -- --port 18081
```

Do not commit real internal endpoints or credentials. This standalone debugging
proxy does not read its upstream from ChatCCC's `config.json`; the configuration
below only points Claude Code at the local proxy.

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
npm run claude-proxy -- --upstream https://api.example.com --log-secrets
```

Do not share logs created with `--log-secrets`.
