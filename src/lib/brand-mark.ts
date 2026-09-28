/**
 * The mark as an SVG document, for the favicon route: three solid stones on
 * the dark tile, in whatever colour the instance's accent gives them.
 *
 * Solid stones rather than outlines: a 2.4/32 stroke is under half a pixel in
 * a 16px tab and collapses into a smudge. Same silhouette as the cloud's,
 * filled, so one mark survives both a favicon and a 180px tile.
 */
export const stonesSvg = (stone: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
  `<rect width="32" height="32" rx="7" fill="#08090a"/>` +
  `<g fill="${stone}">` +
  `<rect x="10" y="5.75" width="12" height="5.5" rx="2.75"/>` +
  `<rect x="6" y="13.25" width="20" height="5.5" rx="2.75"/>` +
  `<rect x="9" y="20.75" width="14" height="5.5" rx="2.75"/>` +
  `</g></svg>`
