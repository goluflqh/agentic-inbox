export function searchMatch(subject: string, body: string, sender: string, recipients: string, query: string) {
	if (!query.trim()) return { fields: [], excerpt: null };
	const needle = query.toLowerCase();
	const text = body.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
	const index = text.toLowerCase().indexOf(needle);
	const fields = [subject.toLowerCase().includes(needle) ? 'Subject' : '', index >= 0 ? 'Body' : '', sender.toLowerCase().includes(needle) ? 'Sender' : '', recipients.toLowerCase().includes(needle) ? 'Recipient' : ''].filter(Boolean);
	const start = Math.max(0, index - 60);
	return { fields, excerpt: index < 0 ? null : `${start ? '…' : ''}${text.slice(start, index + query.length + 100)}${index + query.length + 100 < text.length ? '…' : ''}` };
}
