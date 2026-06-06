export const isNonEmpty = (s: string | null | undefined): s is string => s != null && s !== "";

export const isHttpStatus = (e: unknown, status: number): boolean => {
	if (e == null || typeof e !== "object" || !("status" in e)) return false;
	return e.status === status || e.status === String(status);
};

/**
 * Narrows `T` so the keys that *could* be `undefined` become optional (with
 * `undefined` excluded from their value) while always-present keys stay
 * required — the type-level counterpart to {@link stripUndefined}.
 */
export type StripUndefined<T> = {
	[K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
} & {
	[K in keyof T as undefined extends T[K] ? never : K]: T[K];
};

/**
 * Drops keys whose value is `undefined`, leaving every other value (including
 * `null`) intact.
 *
 * Under `exactOptionalPropertyTypes`, Octokit's request methods reject an
 * explicit `undefined` on an optional field (`body?: string` does not accept
 * `body: undefined`), so optional schema inputs cannot be spread into a request
 * object directly. Passing the object through this helper omits the unset keys
 * so the remaining shape matches Octokit's `T?` optionals.
 *
 * `null` is preserved (the key is kept) because some fields — e.g.
 * `update_issue`'s `state_reason` / `milestone` — accept `null` as a meaningful
 * "clear" signal that must still be sent.
 */
export const stripUndefined = <T extends object>(obj: T): StripUndefined<T> =>
	// `Object.fromEntries` returns a structurally-lossy type, so recovering the
	// narrowed StripUndefined<T> shape requires this one assertion — there is no
	// assertion-free expression of a key-remapped result. Scoped to this line.
	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
	Object.fromEntries(
		Object.entries(obj).filter(([, value]) => value !== undefined),
	) as StripUndefined<T>;

/**
 * Constructs an authorization URL for an upstream service.
 *
 * @param {Object} options
 * @param {string} options.upstream_url - The base URL of the upstream service.
 * @param {string} options.client_id - The client ID of the application.
 * @param {string} options.redirect_uri - The redirect URI of the application.
 * @param {string} [options.state] - The state parameter.
 *
 * @returns {string} The authorization URL.
 */
export function getUpstreamAuthorizeUrl({
	upstream_url,
	client_id,
	scope,
	redirect_uri,
	state,
}: {
	upstream_url: string;
	client_id: string;
	scope: string;
	redirect_uri: string;
	state?: string;
}) {
	const upstream = new URL(upstream_url);
	upstream.searchParams.set("client_id", client_id);
	upstream.searchParams.set("redirect_uri", redirect_uri);
	upstream.searchParams.set("scope", scope);
	if (isNonEmpty(state)) upstream.searchParams.set("state", state);
	upstream.searchParams.set("response_type", "code");
	return upstream.href;
}

/**
 * Fetches an authorization token from an upstream service.
 *
 * @param {Object} options
 * @param {string} options.client_id - The client ID of the application.
 * @param {string} options.client_secret - The client secret of the application.
 * @param {string} options.code - The authorization code.
 * @param {string} options.redirect_uri - The redirect URI of the application.
 * @param {string} options.upstream_url - The token endpoint URL of the upstream service.
 *
 * @returns {Promise<[string, null] | [null, Response]>} A promise that resolves to an array containing the access token or an error response.
 */
export async function fetchUpstreamAuthToken({
	client_id,
	client_secret,
	code,
	redirect_uri,
	upstream_url,
}: {
	code: string | undefined;
	upstream_url: string;
	client_secret: string;
	redirect_uri: string;
	client_id: string;
}): Promise<[string, null] | [null, Response]> {
	if (!isNonEmpty(code)) {
		return [null, new Response("Missing code", { status: 400 })];
	}

	const resp = await fetch(upstream_url, {
		body: new URLSearchParams({ client_id, client_secret, code, redirect_uri }).toString(),
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
		},
		method: "POST",
	});
	if (!resp.ok) {
		console.log(await resp.text());
		return [null, new Response("Failed to fetch access token", { status: 500 })];
	}
	const body = await resp.formData();
	const accessToken = body.get("access_token");
	if (typeof accessToken !== "string" || accessToken === "") {
		return [null, new Response("Missing access token", { status: 400 })];
	}
	return [accessToken, null];
}

// Context from the auth process, encrypted & stored in the auth token
// and provided to the DurableMCP as this.props
export type Props = {
	login: string;
	name: string;
	email: string;
	accessToken: string;
};
