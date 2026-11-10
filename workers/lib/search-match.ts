export function searchMatch(subject: string, body: string, sender: string, recipients: string, query: string) {
	if (!query.trim()) return { fields: [], excerpt: null };
	const needle = query.toLowerCase();
	const text = body.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
		.replace(/<\/?(?:p|div|br|tr|td|li|h[1-6])\b[^>]*>/gi, ' ').replace(/<[^>]*>/g, '')
		.replace(/&#(x[0-9a-f]+|\d+);/gi, (entity, value: string) => {
			const code = value[0].toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : Number(value);
			return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : entity;
		}).replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/\s+/g, ' ').trim();
	const index = text.toLowerCase().indexOf(needle);
	const fields = [subject.toLowerCase().includes(needle) ? 'Subject' : '', index >= 0 ? 'Body' : '', sender.toLowerCase().includes(needle) ? 'Sender' : '', recipients.toLowerCase().includes(needle) ? 'Recipient' : ''].filter(Boolean);
	if (index < 0 && body.toLowerCase().includes(needle)) fields.push('Hidden HTML / link');
	const start = Math.max(0, index - 60);
	return { fields, excerpt: index < 0 ? null : `${start ? '…' : ''}${text.slice(start, index + query.length + 100)}${index + query.length + 100 < text.length ? '…' : ''}` };
}
