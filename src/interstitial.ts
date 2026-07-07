// Loopback-aware interstitial for the OAuth /callback response (issue #174).
//
// MCP clients typically listen on an ephemeral loopback port for the OAuth
// redirect, and that listener can die before the user finishes the consent
// flow. A bare 302 then strands the user on a browser connection-error page
// with no way to recover. For loopback redirect targets we instead serve an
// interstitial page that navigates immediately (meta refresh + JS) and, when
// the navigation fails, leaves the full redirect URL visible and copyable.
// See docs/decisions/0004-interstitial-oauth-callback.md.

// Spec-defined loopback names/addresses only (MCP spec 2025-11-25 "Localhost
// Redirect URI Risks") — RFC1918 and link-local addresses are NOT loopback.
// "[::1]" is the WHATWG URL `hostname` form; the raw "::1" is kept as a guard
// against runtimes that return the address unbracketed.
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isLoopbackHostname(hostname: string): boolean {
	return LOOPBACK_HOSTNAMES.has(hostname);
}

// True when `redirectTo` parses as a URL with a loopback host. Any parse
// failure returns false so callers fall through to the plain 302 unchanged.
export function isLoopbackRedirect(redirectTo: string): boolean {
	let url: URL;
	try {
		url = new URL(redirectTo);
	} catch {
		return false;
	}
	return isLoopbackHostname(url.hostname);
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

// JSON string literal safe to embed inside a <script> block: also escapes the
// characters that could terminate the script context ("</script>").
function jsStringLiteral(value: string): string {
	return JSON.stringify(value)
		.replaceAll("&", "\\u0026")
		.replaceAll("<", "\\u003c")
		.replaceAll(">", "\\u003e");
}

function generateNonce(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin);
}

// Renders the interstitial for a loopback `redirectTo`. Callers must gate on
// `isLoopbackRedirect` first — this parses `redirectTo` unconditionally.
export function renderInterstitial(
	redirectTo: string,
	options: { setCookie?: string | undefined } = {},
): Response {
	const nonce = generateNonce();
	const escapedUrl = escapeHtml(redirectTo);
	const escapedHost = escapeHtml(new URL(redirectTo).host);

	const html = `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<meta http-equiv="refresh" content="0;url=${escapedUrl}" />
		<title>Authorization complete</title>
		<style nonce="${nonce}">
			body {
				font-family: system-ui, sans-serif;
				max-width: 40rem;
				margin: 4rem auto;
				padding: 0 1rem;
			}
			code {
				word-break: break-all;
			}
		</style>
	</head>
	<body>
		<h1>Authorization complete</h1>
		<p>
			You should be redirected back to your MCP client automatically. If your browser is
			showing a connection error, your client isn't listening on <code>${escapedHost}</code> —
			copy the URL below and paste it into the tool that asked you to authenticate.
		</p>
		<p>Redirecting to: <strong>${escapedHost}</strong></p>
		<p>
			<code id="redirect-url">${escapedUrl}</code>
			<button id="copy-button" type="button">Copy</button>
		</p>
		<script nonce="${nonce}">
			const redirectTo = ${jsStringLiteral(redirectTo)};
			const copyButton = document.getElementById("copy-button");
			copyButton.addEventListener("click", () => {
				if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
					navigator.clipboard.writeText(redirectTo).then(
						() => {
							copyButton.textContent = "Copied";
						},
						() => {
							// Clipboard write failed — the URL is still selectable by hand.
						},
					);
				}
			});
			window.location.replace(redirectTo);
		</script>
	</body>
</html>
`;

	const headers = new Headers({
		"Content-Type": "text/html; charset=utf-8",
		"Cache-Control": "no-store",
		"Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'`,
	});
	if (options.setCookie !== undefined && options.setCookie !== "") {
		headers.set("Set-Cookie", options.setCookie);
	}

	return new Response(html, { status: 200, headers });
}
