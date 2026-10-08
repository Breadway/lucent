import {
  defineFilm,
  group,
  rect,
  circle,
  text,
  path,
  camera,
  image,
  video,
} from "@breadway/lucent";
export default defineFilm({
  seed: 12,
  background: "#0c1120",
  scenes: [
    {
      id: "operations",
      duration: 4,
      renderer: "portable",
      requires: [
        "groups",
        "transforms",
        "clipping",
        "paths",
        "text",
        "cameras",
      ],
      dependencies: ["DejaVuSans.ttf", "image.png", "clip.mp4"],
      frame(t) {
        return [
          rect(0, 0, 640, 360, "#0c1120"),
          image("image.png", 530, 40, 80, 80),
          video("clip.mp4", 540, 110, 64, 64, {
            loop: true,
            duration: 2,
          }),
          camera([
            group(
              [rect(0, 0, 130, 80, "#ff0000"), circle(95, 70, 35, "#00ff00")],
              {
                translate: [30 + t * 25, 40],
                rotate: t * 0.1,
                clip: [0, 0, 160, 100],
              },
            ),
            path(
              [
                ["M", 230, 40],
                ["L", 360, 40],
                ["Q", 390, 100, 300, 130],
                ["Z"],
              ],
              { color: "#3b7fff" },
            ),
            text("Lucent · café", 30, 205, {
              font: "DejaVu Sans",
              size: 28,
            }),
            text(
              "Seeking uses timestamps.\nEvery frame is reproducible.",
              30,
              260,
              { font: "DejaVu Sans", size: 22, lineHeight: 30 },
            ),
            ...Array.from({ length: 8 }, (_, i) =>
              rect(
                450 + i * 20,
                180,
                20,
                140,
                `#${[0, 32, 64, 96, 128, 160, 224, 255][i].toString(16).padStart(2, "0").repeat(3)}`,
              ),
            ),
          ]),
        ];
      },
    },
    {
      id: "overlap-transition",
      start: 3,
      duration: 2,
      renderer: "portable",
      requires: ["groups", "transforms", "text"],
      dependencies: ["DejaVuSans.ttf"],
      frame(t) {
        const progress = Math.min(1, t / 0.5);
        return [
          rect(390, 40, 190, 100, "#502090", { opacity: progress }),
          text("Scene overlap", 405, 90, {
            font: "DejaVu Sans",
            size: 20,
            opacity: progress,
          }),
        ];
      },
    },
  ],
});
