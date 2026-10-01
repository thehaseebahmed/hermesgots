import { cn } from "@/lib/utils"

/** Memento's droplet buddy. Bobs gently while Hermes is working. */
export function Mascot({ className, busy = false }: { className?: string; busy?: boolean }) {
  return (
    <svg
      viewBox="0 0 48 56"
      aria-hidden="true"
      className={cn("size-8 shrink-0", busy && "animate-mascot-bob", className)}
    >
      <path d="M24 2C24 2 6 22 6 35a18 18 0 0 0 36 0C42 22 24 2 24 2Z" className="fill-mascot" />
      <path
        d="M42 35a18 18 0 0 1-30.5 13A18 18 0 0 0 38 30c0-3-1-6.5-2.6-10C39.5 25.6 42 30.8 42 35Z"
        className="fill-mascot-shade opacity-60"
      />
      <ellipse cx="14" cy="28" rx="3" ry="5" className="fill-white/40" />
      <g className="animate-mascot-blink">
        <rect x="16" y="30" width="5" height="10" rx="2.5" className="fill-mascot-eye" />
        <rect x="27" y="30" width="5" height="10" rx="2.5" className="fill-mascot-eye" />
      </g>
    </svg>
  )
}
