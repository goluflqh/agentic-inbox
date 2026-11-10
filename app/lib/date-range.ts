export function localDateBounds(start: string, end: string): { start?: string; end?: string } | null {
	const parse = (value: string, isEnd: boolean): string | undefined | null => {
		if (!value) return undefined;
		if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
		const [year, month, day] = value.split('-').map(Number);
		const date = new Date(year, month - 1, day);
		if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
		if (isEnd) date.setHours(23, 59, 59, 999);
		return date.toISOString();
	};
	if (start && end && start > end) return null;
	const from = parse(start, false);
	const to = parse(end, true);
	if (from === null || to === null) return null;
	return { start: from, end: to };
}
