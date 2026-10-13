export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string; icon?: React.ReactNode }[]; onChange: (v: T) => void; label: string }) {
	return (
		<div className="pg-segmented" role="radiogroup" aria-label={label}>
			{options.map((o) => (
				<button key={o.value} type="button" role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)}>
					{o.icon}{o.label}
				</button>
			))}
		</div>
	);
}
