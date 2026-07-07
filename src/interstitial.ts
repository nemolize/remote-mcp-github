// Loopback-aware interstitial for the OAuth /callback response (issue #174).
//
// MCP clients typically listen on an ephemeral loopback port for the OAuth
// redirect, and that listener can die before the user finishes the consent
// flow. A bare 302 then strands the user on a browser connection-error page
// with no way to recover. For loopback redirect targets we serve an
// interstitial page whose PRIMARY content is the redirect URL + a Copy
// button, and which then navigates via `location.assign` after a visible
// countdown so:
//
//   * on a live listener, the countdown elapses and the client catches
//     the redirect normally (~2s extra latency);
//   * on a dead listener, the URL has already been on-screen for the
//     countdown, and `assign` (not `replace`) leaves the interstitial in
//     history so Back returns to a page with the URL + Copy button after
//     the browser's connection-error page appears.
//
// A JS-side "probe" (fetch/img/XHR with a timeout) is NOT used: this page
// is served over HTTPS from the Worker while the loopback target is HTTP,
// so the browser's mixed-content policy blocks every probe channel
// uniformly — the probe can't distinguish a dead listener from a browser
// block, and a silent-fail probe would strand every user.
//
// See docs/decisions/0004-interstitial-oauth-callback.md.

import { sanitizeText } from "./workers-oauth-utils";

// Spec-defined loopback names/addresses only (MCP spec 2025-11-25 "Localhost
// Redirect URI Risks") — RFC1918 and link-local addresses are NOT loopback.
// "[::1]" is the WHATWG URL `hostname` form; the raw "::1" is kept as a guard
// against runtimes that return the address unbracketed.
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

// How long the interstitial stays visible before auto-navigating. Chosen so
// the fallback URL + Copy button are legible even when the redirect will
// succeed, and so the "dead listener" case degrades to a still-legible page
// via the browser Back button after the connection-error interstitial.
const AUTO_REDIRECT_SECONDS = 2;

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
// `options.setCookie` is passed through to a Set-Cookie header when non-empty,
// so the caller can hand its raw session-cookie string in without a ternary.
export function renderInterstitial(
	redirectTo: string,
	options: { setCookie?: string | undefined } = {},
): Response {
	const nonce = generateNonce();
	const escapedUrl = sanitizeText(redirectTo);
	const escapedHost = sanitizeText(new URL(redirectTo).host);

	const html = `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
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
			.url-block {
				background: #f5f5f5;
				padding: 0.75rem;
				border-radius: 4px;
			}
			.countdown {
				color: #555;
			}
		</style>
	</head>
	<body>
		<h1>Authorization complete</h1>
		<p>
			Return to your MCP client at <strong>${escapedHost}</strong>. If your browser shows a
			connection error after the redirect, your client isn't listening on that port — copy
			the URL below and paste it into the tool that asked you to authenticate.
		</p>
		<p class="url-block">
			<code id="redirect-url">${escapedUrl}</code>
			<button id="copy-button" type="button">Copy</button>
		</p>
		<p class="countdown" id="status">
			Redirecting in <span id="countdown">${AUTO_REDIRECT_SECONDS}</span> seconds…
		</p>
		<noscript><p><a href="${escapedUrl}">Continue manually</a></p></noscript>
		<script nonce="${nonce}">
			const target = ${jsStringLiteral(redirectTo)};
			const copyButton = document.getElementById("copy-button");
			copyButton.addEventListener("click", () => {
				if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
					navigator.clipboard.writeText(target).then(
						() => {
							copyButton.textContent = "Copied";
						},
						() => {
							// Clipboard write failed — the URL is still selectable by hand.
						},
					);
				}
			});
			const countdownEl = document.getElementById("countdown");
			const statusEl = document.getElementById("status");
			let remaining = ${AUTO_REDIRECT_SECONDS};
			const tick = () => {
				remaining -= 1;
				if (remaining <= 0) {
					statusEl.textContent = "Redirecting…";
					// assign (not replace) so a dead loopback listener's connection-error
					// page leaves this interstitial in history — Back returns to the URL.
					window.location.assign(target);
					return;
				}
				countdownEl.textContent = String(remaining);
				setTimeout(tick, 1000);
			};
			setTimeout(tick, 1000);
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
