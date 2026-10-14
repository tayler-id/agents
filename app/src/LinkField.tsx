import { useId } from 'react'

// A link to copy by hand, such as a Tailscale invite link. Focusing it selects
// it all. The clipboard API needs a secure page, which the tailnet's plain HTTP is not.
export function LinkField({ label, link }: { label: string; link: string }) {
  const id = useId()
  return (
    <>
      <label htmlFor={id} className="small muted">{label}</label>
      <input id={id} className="link-field" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
    </>
  )
}
