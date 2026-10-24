// GitHub's Search API caps reachable results at 1000; comparing `pageNum * perPage`
// against that cap (not `totalCount` alone) avoids a false "more" hint on the final
// reachable page when `items.length` is less than `totalCount`.
const SEARCH_RESULT_CAP = 1000;

const SCOPE_QUALIFIER = /(?:^|[\s"'(])(?:repo|user|org):/i;

const OWNER_REPO_NAME = /^[A-Za-z0-9_.-]+$/;

export type ScopeInput = {
	query: string;
	owner?: string | undefined;
	repo?: string | undefined;
};

export type ScopedQuery = { query: string } | { error: string };

export const scopeQuery = ({ query, owner, repo }: ScopeInput): ScopedQuery => {
	if (owner === undefined && repo === undefined) return { query };
	if (owner === undefined) return { error: "`repo` requires `owner`." };
	if (!OWNER_REPO_NAME.test(owner) || (repo !== undefined && !OWNER_REPO_NAME.test(repo))) {
		return {
			error: "`owner` and `repo` may contain only letters, digits, `_`, `.` and `-`.",
		};
	}
	if (SCOPE_QUALIFIER.test(query)) {
		return {
			error:
				"`query` already has a `repo:`, `user:` or `org:` qualifier; remove it, because `owner` / `repo` already set the scope.",
		};
	}
	const qualifier = repo === undefined ? `user:${owner}` : `repo:${owner}/${repo}`;
	return { query: `${query} ${qualifier}` };
};

export type SearchHeaderInput = {
	label: string;
	query: string;
	page: number | undefined;
	perPage: number;
	totalCount: number;
	shownCount: number;
};

export const searchHeader = ({
	label,
	query,
	page,
	perPage,
	totalCount,
	shownCount,
}: SearchHeaderInput): string => {
	const pageNum = page ?? 1;
	const hasMore = pageNum * perPage < Math.min(totalCount, SEARCH_RESULT_CAP);
	return hasMore
		? `# ${label} for \`${query}\` (page ${pageNum}, showing ${shownCount} of ${totalCount}; pass next \`page\` for more)`
		: `# ${label} for \`${query}\` (showing ${shownCount} of ${totalCount})`;
};
