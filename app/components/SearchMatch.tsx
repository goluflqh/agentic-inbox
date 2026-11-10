import type { ReactNode } from "react";

export function highlightSearch(text: string, query: string): ReactNode {
	if (!query.trim()) return text;
	const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return text.split(new RegExp(`(${escaped})`, "gi")).map((part, index) => part.toLowerCase() === query.toLowerCase()
		? <mark key={index} className="rounded-sm bg-yellow-200 text-black">{part}</mark> : part);
}

export function SearchMatchLabel({ fields }: { fields?: string[] }) {
	return fields?.length ? <span className="text-xs text-kumo-subtle">Match: {fields.join(", ")}</span> : null;
}
