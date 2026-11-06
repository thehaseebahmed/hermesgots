/** One group of an app's tools, headed by what the app may do with them; nothing where there are none. */
export function ToolList({ label, tools }: { label: string; tools: string[] }) {
  if (tools.length === 0) return null
  return (
    <section aria-label={label} className="flex flex-col gap-1">
      <h3 className="text-sm font-medium">{label}</h3>
      <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
        {tools.map((tool) => (
          <li key={tool}>{tool}</li>
        ))}
      </ul>
    </section>
  )
}
