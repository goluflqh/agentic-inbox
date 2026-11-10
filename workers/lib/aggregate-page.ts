export async function fetchPrefix<T>(count: number, fetchPage: (page: number, limit: number) => Promise<T[]>): Promise<T[]> {
	const pageSize = 100;
	const results: T[] = [];
	for (let page = 1; results.length < count; page++) {
		const batch = await fetchPage(page, pageSize);
		results.push(...batch);
		if (batch.length < pageSize) break;
	}
	return results.slice(0, count);
}
