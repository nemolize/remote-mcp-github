import { describe, expect, it } from "vitest";

import { isLoopbackHostname, isLoopbackRedirect, renderInterstitial } from "../src/interstitial.js";

describe("isLoopbackRedirect", () => {
	const loopbackUrls = [
		"http://localhost:12345/callback",
		"http://127.0.0.1:8080/callback?code=x",
		"http://[::1]:9090/callback",
	];
	for (const url of loopbackUrls) {
		it(`treats ${url} as loopback`, () => {
			expect(isLoopbackRedirect(url)).toBe(true);
		});
	}

	// Only spec-defined loopback names/addresses count — RFC1918 and link-local
	// hosts must keep the plain 302.
	const nonLoopbackUrls = [
		"https://example.com/callback",
		"http://10.0.0.1:3000/callback",
		"http://192.168.1.1/callback",
		"http://169.254.169.254/callback",
	];
	for (const url of nonLoopbackUrls) {
		it(`treats ${url} as NOT loopback`, () => {
			expect(isLoopbackRedirect(url)).toBe(false);
		});
	}

	// Unparseable input → NOT loopback, so the caller safely falls back to the
	// existing 302 path.
	for (const bad of ["not a url", ""]) {
		it(`treats ${JSON.stringify(bad)} as NOT loopback`, () => {
			expect(isLoopbackRedirect(bad)).toBe(false);
		});
	}
});

describe("isLoopbackHostname", () => {
	it("accepts the raw and bracketed IPv6 loopback forms", () => {
		expect(isLoopbackHostname("::1")).toBe(true);
		expect(isLoopbackHostname("[::1]")).toBe(true);
	});

	it("rejects non-loopback hostnames", () => {
		expect(isLoopbackHostname("example.com")).toBe(false);
		expect(isLoopbackHostname("10.0.0.1")).toBe(false);
	});
});

describe("renderInterstitial", () => {
	const redirectTo = "http://localhost:12345/callback?code=abc&state=xyz";

	it("returns text/html with no-store and a nonce-based CSP", async () => {
		const res = renderInterstitial(redirectTo);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
		expect(res.headers.get("Cache-Control")).toBe("no-store");

		const csp = res.headers.get("Content-Security-Policy");
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain("base-uri 'none'");
		expect(csp).toContain("form-action 'none'");
		expect(csp).not.toContain("unsafe-inline");

		// The CSP nonce must be the one actually attached to the inline blocks.
		const match = csp.match(/script-src 'nonce-([^']+)'/);
		expect(match).not.toBeNull();
		const html = await res.text();
		expect(html).toContain(`<script nonce="${match[1]}">`);
		expect(html).toContain(`<style nonce="${match[1]}">`);
	});

	it("generates a fresh nonce per response", () => {
		const nonceOf = (res) =>
			res.headers.get("Content-Security-Policy").match(/script-src 'nonce-([^']+)'/)[1];
		expect(nonceOf(renderInterstitial(redirectTo))).not.toBe(
			nonceOf(renderInterstitial(redirectTo)),
		);
	});

	it("navigates immediately via meta refresh and JS replace", async () => {
		const html = await renderInterstitial(redirectTo).text();
		expect(html).toContain(
			'<meta http-equiv="refresh" content="0;url=http://localhost:12345/callback?code=abc&amp;state=xyz" />',
		);
		expect(html).toContain("<script nonce=");
		expect(html).toContain("window.location.replace(redirectTo)");
		expect(html).toContain(
			'const redirectTo = "http://localhost:12345/callback?code=abc\\u0026state=xyz";',
		);
	});

	it("shows the loopback host and the full URL in a code block", async () => {
		const html = await renderInterstitial(redirectTo).text();
		expect(html).toContain("Authorization complete");
		expect(html).toContain("localhost:12345");
		expect(html).toMatch(
			/<code[^>]*>http:\/\/localhost:12345\/callback\?code=abc&amp;state=xyz<\/code>/,
		);
	});

	it("preserves a Set-Cookie header when given", () => {
		const cookie = "__Host-CONSENTED_STATE=; Max-Age=0; Path=/; Secure; HttpOnly";
		const res = renderInterstitial(redirectTo, { setCookie: cookie });
		expect(res.headers.get("Set-Cookie")).toBe(cookie);
	});

	it("omits Set-Cookie when not given", () => {
		expect(renderInterstitial(redirectTo).headers.get("Set-Cookie")).toBeNull();
	});

	it("escapes a hostile redirectTo everywhere it appears", async () => {
		const hostile = "http://localhost:12345/callback?code=<script>alert(1)</script>&state=x";
		const html = await renderInterstitial(hostile).text();

		// The payload must never appear unescaped.
		expect(html).not.toContain("<script>alert(1)</script>");
		// Body / attribute appearances are HTML-escaped ...
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		// ... and the script literal escapes angle brackets so "</script>" cannot
		// break out of the inline script context.
		expect(html).toContain("\\u003cscript\\u003ealert(1)\\u003c/script\\u003e");
	});
});
