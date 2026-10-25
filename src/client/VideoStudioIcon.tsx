/**
 * The 映流 film mark, rendered at an explicit square size for host slots.
 *
 * The DSH sidebar owns the row, label and colour of its global panel entries
 * and asks every `sidebar.panellist` occupant for `{size, active}`. An inline
 * <svg> that only carries a viewBox resolves to a 0x0 box inside the row's
 * inline-flex glyph slot, so the mark must size itself from the requested
 * `size` instead of relying on surrounding CSS. The plugin header keeps
 * sizing the same mark through `.vs-brandmark svg`.
 */
export function VideoStudioIcon({size=18}:{size?:number}){
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="3" stroke="currentColor" strokeWidth="1.6"/>
      <path d="M8 4v16M16 4v16M3 9h5M3 15h5M16 9h5M16 15h5" stroke="currentColor" strokeWidth="1.4"/>
      <path d="m11 9 4 3-4 3V9Z" fill="currentColor"/>
    </svg>
  );
}
