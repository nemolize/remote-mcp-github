import type { Props } from "./utils";

/**
 * The dedicated mount prefix for PAT (GitHub Personal Access Token) Bearer auth.
 *
 * A Bearer-only MCP client (e.g. Codex desktop, whose custom-MCP form exposes
 * only a URL + a Bearer-token env var and no OAuth consent affordance) connects
 * to `<origin>/pat/mcp` (or `/pat/sse`) instead of the canonical `/mcp`. Routing
 * by path — rather than a custom header or a token-prefix sniff — is what lets a
 * header-less client opt into PAT auth, and it confines PAT resolution to this
 * one route so the canonical `/mcp` keeps rejecting any unknown Bearer with 401.
 *
 * See docs/decisions/0004-pat-bearer-auth-for-non-oauth-clients.md.
 */
export const PAT_ROUTE_PREFIX = "/pat";

/** GitHub PAT prefixes — classic (`ghp_`) and fine-grained (`github_pat_`). */
const PAT_TOKEN_PREFIXES = ["ghp_", "github_pat_"] as const;

/** True when `pathname` is on the dedicated PAT mount (`/pat/mcp`, `/pat/sse`). */
export const isPatRoute = (pathname: string): boolean =>
	pathname === PAT_ROUTE_PREFIX || pathname.startsWith(`${PAT_ROUTE_PREFIX}/`);

/** True when `token` looks like a GitHub PAT (sanity check, not the route gate). */
export const looksLikePat = (token: string): boolean =>
	typeof token === "string" && PAT_TOKEN_PREFIXES.some((p) => token.startsWith(p));

/**
 * The `Props` an accepted PAT yields: the token in `accessToken` (the same field
 * the OAuth callback populates) and empty identity fields, since no tool reads
 * `login`/`name`/`email` and the PAT path makes no `GET /user` call. Single point
 * of truth for the shape so adding a `Props` field touches one place.
 */
export const patProps = (token: string): Props => ({
	accessToken: token,
	login: "",
	name: "",
	email: "",
});

/**
 * Resolves an external Bearer token into MCP `Props` for the PAT path.
 *
 * Wired as `@cloudflare/workers-oauth-provider`'s `resolveExternalToken`, this
 * fires only on a KV-miss (a Bearer the provider did not issue). It accepts the
 * token **only** when the request is on the `/pat/*` route, so a stray PAT-shaped
 * Bearer on the canonical `/mcp` still falls through to a normal `401`.
 *
 * The PAT is placed directly in `props.accessToken` — the same field the OAuth
 * callback populates — so the tool layer is identical. No `GET /user` call is
 * made: tools read only `accessToken` (`login`/`name`/`email` are unused by any
 * tool), and validity is established by use (the first tool call's GitHub
 * `401`/`403` surfaces an invalid or under-scoped PAT). The token is never
 * logged: returning `null` here yields a generic `401` with no token in it.
 */
export const resolvePatToken = ({
	token,
	pathname,
}: {
	token: string;
	pathname: string;
}): { props: Props } | null => {
	if (!isPatRoute(pathname)) return null;
	if (!looksLikePat(token)) return null;
	return { props: patProps(token) };
};
