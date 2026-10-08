import { defineFilm, svg } from "@breadway/lucent";

// An SVG document as a scene leaf: gradient fill, a clip, a filter, text and an arrow marker.
const markup = (t: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
<defs>
<linearGradient id="g" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient>
<filter id="blur" filterUnits="userSpaceOnUse" x="0" y="0" width="640" height="360"><feGaussianBlur stdDeviation="3"/></filter>
</defs>
<rect width="640" height="360" fill="#102030"/>
<rect x="40" y="40" width="200" height="100" fill="url(#g)"/>
<circle cx="${100 + t * 40}" cy="250" r="30" fill="#00ff00" filter="url(#blur)"/>
<text x="320" y="60" font-family="DejaVu Sans" font-size="40" fill="#ffffff">Ag</text>
</svg>`;

export default defineFilm({
  seed: 1,
  background: "#000000",
  scenes: [
    {
      id: "svg",
      duration: 4,
      renderer: "portable",
      requires: ["svg"],
      dependencies: ["DejaVuSans.ttf"],
      frame: (t) => svg(markup(t), { grain: { seed: Math.round(t * 30) } }),
    },
  ],
});
