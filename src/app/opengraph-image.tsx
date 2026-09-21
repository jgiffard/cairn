import { ImageResponse } from 'next/og'

/**
 * The social card. Without one, every Cairn link pasted into Slack or a pull
 * request renders as a bare URL.
 *
 * Colours are the app's own dark tokens read from globals.css (--bg, --fg,
 * --fg-muted, --border, --accent) rather than invented here, and the mark is
 * the same three solid stones as icon.svg and apple-icon.tsx — the card is the
 * third surface carrying one glyph, not a fourth piece of artwork.
 *
 * No webfont is fetched: next/og would have to pull IBM Plex over the network
 * on every cold render, and a card that sometimes fails is worse than a card
 * set in the default face.
 */
export const alt = 'Cairn — agent-first task tracker whose tasks double as shared memory'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

const GROUND = '#08090a'
const STONE = '#7b86e8'
const FG = '#f7f8f8'
const FG_MUTED = '#9aa0a9'
const BORDER = '#1f2023'

// The 32-unit mark at 132px: scale 4.125, same stack, middle widest.
const Stone = ({ width, bottom }: { width: number; bottom: number }) => (
  <div
    style={{
      position: 'absolute',
      bottom,
      width,
      height: 23,
      borderRadius: 12,
      background: STONE,
    }}
  />
)

const Mark = () => (
  <div
    style={{
      display: 'flex',
      position: 'relative',
      width: 132,
      height: 132,
      borderRadius: 29,
      background: GROUND,
      border: `1px solid ${BORDER}`,
      alignItems: 'center',
      justifyContent: 'center',
    }}
  >
    <Stone width={58} bottom={24} />
    <Stone width={83} bottom={55} />
    <Stone width={50} bottom={86} />
  </div>
)

const OpengraphImage = () =>
  new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          background: GROUND,
          padding: '0 96px',
          position: 'relative',
        }}
      >
        <Mark />
        <div
          style={{
            display: 'flex',
            marginTop: 48,
            fontSize: 104,
            lineHeight: 1,
            letterSpacing: -3.6,
            color: FG,
          }}
        >
          Cairn
        </div>
        <div
          style={{
            display: 'flex',
            marginTop: 28,
            width: 840,
            fontSize: 36,
            lineHeight: 1.35,
            letterSpacing: -0.4,
            color: FG_MUTED,
          }}
        >
          Agent-first task tracker whose tasks double as shared memory.
        </div>
        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            width: '100%',
            height: 6,
            background: STONE,
          }}
        />
      </div>
    ),
    size,
  )

export default OpengraphImage
