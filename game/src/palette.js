// The look plan, in one place. The yard is dusk concrete and rust: cold greys for the
// ground and walls, rust orange for the freight containers, amber for Vanguard, ember red
// for the Cinder crew. The same names are the CSS custom properties in index.html.
export const PALETTE = {
  canvas: '#191a1e',
  surface: '#23262c',
  hairline: '#33373f',
  ink: '#e9e6df',
  muted: '#98a0a8',
  accent: '#f0a830',
  rust: '#a85a2e',
  rustDark: '#7c3f20',
  concrete: '#565b62',
  concreteDark: '#484d55',
  hazard: '#e8c832',
  vanguard: '#f0a830',
  cinder: '#d05a3c',
  teal: '#4fae8d',
  sky: '#39404d',
};

export function shade(name) {
  return PALETTE[name];
}
