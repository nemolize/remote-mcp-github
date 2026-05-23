// GitHub's Search API caps reachable results at 1000; comparing `pageNum * perPage`
// against that cap (not `totalCount` alone) avoids a false "more" hint on the final
// reachable page when `items.length` is less than `totalCount`.
const SEARCH_RESULT_CAP = 1000;

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
