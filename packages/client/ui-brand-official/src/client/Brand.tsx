import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the official mark with the presentation requested by its host surface.
 * @param props - Host-supplied mark presentation.
 * @returns the Candy mark.
 */
export function OfficialBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="currentColor" />
      <path d="M16 8.5a5 5 0 1 0 0 7" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  )
}

/**
 * Render the official name artwork without its independently slotted mark.
 * @returns the Candy product name.
 */
export function OfficialBrandName() {
  return <strong>Candy</strong>
}
