import { ImageResponse } from 'next/og'

/**
 * iOS ignores SVG favicons and wants a raster for the home screen, so the same
 * cairn is drawn again at 180px rather than shipping a binary asset.
 *
 * This file stays `.tsx` on purpose. Next accepts `icon.svg` but NOT
 * `apple-icon.svg` — an SVG here is silently ignored and the site ends up with
 * no apple icon at all. A route that renders the PNG is the only reliable form.
 */
export const size = { width: 180, height: 180 }
export const contentType = 'image/png'

// The 32-unit mark scaled by 180/32. Solid stones, middle widest, matching
// icon.svg exactly — one mark, two renderers.
const GROUND = '#08090a'
const STONE = '#7b86e8'

const Stone = ({ width, bottom }: { width: number; bottom: number }) => (
  <div
    style={{
      position: 'absolute',
      bottom,
      width,
      height: 31,
      borderRadius: 16,
      background: STONE,
    }}
  />
)

const AppleIcon = () =>
  new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          position: 'relative',
          alignItems: 'center',
          justifyContent: 'center',
          background: GROUND,
        }}
      >
        <Stone width={79} bottom={32} />
        <Stone width={113} bottom={75} />
        <Stone width={68} bottom={117} />
      </div>
    ),
    size,
  )

export default AppleIcon
