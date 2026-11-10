import { PaperclipIcon, XIcon } from "@phosphor-icons/react";
import { formatBytes } from "~/lib/utils";

export default function ComposeAttachments({ files, onAdd, onRemove, disabled }: {
	files: File[];
	onAdd: (files: File[]) => void;
	onRemove: (index: number) => void;
	disabled: boolean;
}) {
	return (
		<div className="space-y-2">
			<label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-kumo-line px-3 py-2 text-sm text-kumo-strong hover:bg-kumo-tint">
				<PaperclipIcon size={16} /> Attach files
				<input type="file" multiple className="sr-only" disabled={disabled} aria-label="Attach files" onChange={(event) => {
					onAdd(Array.from(event.currentTarget.files || []));
					event.currentTarget.value = "";
				}} />
			</label>
			<p className="text-xs text-kumo-subtle">Up to 10 files, 5 MiB total. Attachments cannot yet be saved in drafts.</p>
			{files.length > 0 && <ul className="space-y-1">{files.map((file, index) => (
				<li key={`${file.name}-${file.size}-${index}`} className="flex items-center gap-2 text-sm text-kumo-strong">
					<span className="min-w-0 truncate">{file.name}</span><span className="shrink-0 text-kumo-subtle">{formatBytes(file.size)}</span>
					<button type="button" disabled={disabled} onClick={() => onRemove(index)} aria-label={`Remove ${file.name}`}><XIcon size={16} /></button>
				</li>
			))}</ul>}
		</div>
	);
}
