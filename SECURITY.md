# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| latest  | ✅ Yes    |

## Reporting a Vulnerability

If you discover a security vulnerability, please **do not** open a public issue.

Instead, use [GitHub's private reporting feature](https://github.com/blixten85/product-describer-cloudflare/security/advisories/new) to report it confidentially.

You should receive a response within 48 hours. If the issue is confirmed, we will work on a fix as soon as possible.

## Security Best Practices

- Always use Wrangler secrets or environment variables for credentials; never commit keys or tokens
- `PROVIDER_CONFIG_KEY` must stay secret and must match between `app/` and `processor/`
- Provider API keys for Anthropic, OpenAI, Gemini, Azure OpenAI, and `SCRAPER_API_KEY` must only be stored as secrets
- Provider configuration is stored encrypted; raw provider credentials should never be logged, echoed, or committed
- Keep dependencies updated and review automated dependency/security alerts before deploy
