/**
 * Remounts on every navigation between pages (a layout does not), so each
 * page fades in as it arrives rather than snapping into place. Opacity only:
 * see .enter-page in globals.css for why there is no transform.
 */
const Template = ({ children }: { children: React.ReactNode }) => (
  <div className="enter-page h-full">{children}</div>
)

export default Template
