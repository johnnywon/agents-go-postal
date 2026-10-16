export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string; icon?: React.ReactNode; disabled?: boolean; title?: string }[]; onChange: (v: T) => void; label: string }) {
	return (
		<div className="pg-segmented" role="radiogroup" aria-label={label}>
			{options.map((o) => (
				<button key={o.value} type="button" role="radio" aria-checked={value === o.value} disabled={o.disabled} title={o.title} onClick={() => onChange(o.value)}>
					{o.icon}{o.label}
				</button>
			))}
		</div>
	);
}
