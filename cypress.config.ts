import { defineConfig } from 'cypress';
import { join } from 'node:path';
import { registerAnnotateTasks } from './src/cypress/task.js';
import { startStaticServer } from './scripts/lib/static-server.js';
import {
  clampToImage,
  colorDistance,
  edgeDeltas,
  hexToRgb,
  rgbToHex,
  sampleColor,
  scanForColor,
} from './scripts/lib/pixels.js';
import type { PixelRect } from './src/types.js';

export default defineConfig({
  projectId: 'qeshtt',
  viewportWidth: 1280,
  // Matches the headless Electron window, so the capture is not clipped.
  viewportHeight: 720,
  video: false,
  screenshotsFolder: 'out/cypress/screenshots',
  // The failure-capture hook takes its own screenshot immediately after
  // measuring the DOM, guaranteeing nothing changes between the two. Leaving
  // Cypress's automatic one on would race it and make it ambiguous which
  // screenshot the measurement actually corresponds to.
  screenshotOnRunFailure: false,
  fixturesFolder: false,
  e2e: {
    supportFile: 'cypress/support/e2e.ts',
    specPattern: 'cypress/e2e/**/*.cy.ts',

    async setupNodeEvents(on, config) {
      // The plugin itself: one call is the whole Node-side setup.
      registerAnnotateTasks(on);

      // Everything below is this repo's own test rig, not part of the plugin.
      const { url } = await startStaticServer(join(config.projectRoot, 'fixtures'));
      config.baseUrl = url;

      on('task', {
        /**
         * Ground truth for the alignment assertions.
         *
         * Fixture targets are painted a flat unique colour, so the pixels they
         * paint are exactly their border box. The colour is sampled from the
         * image rather than taken from the stylesheet, because Electron's macOS
         * capture shifts colours; `nearest` then reports which fixture colour
         * the sample actually is, so a box sitting on the wrong element - or on
         * the page background - is still caught.
         */
        async probeAndScan({
          path,
          probe,
          background,
        }: {
          path: string;
          probe: { x: number; y: number };
          background: string;
        }) {
          const { readFile } = await import('node:fs/promises');
          const image = await readFile(path);

          const sampled = await sampleColor(image, probe.x, probe.y);
          const painted = await scanForColor(image, rgbToHex(sampled), 24);

          return {
            sampled: rgbToHex(sampled),
            // Distance from the page background, so a box drawn over empty page
            // is caught. Classifying against the full palette is not reliable
            // here: the capture shifts colours, and two shifted fixture greens
            // land closer to each other than to their own CSS values.
            backgroundDistance: Math.round(colorDistance(sampled, hexToRgb(background))),
            painted: painted ?? null,
          };
        },
        driftAgainst({
          computed,
          painted,
          width,
          height,
        }: {
          computed: PixelRect;
          painted: PixelRect;
          width: number;
          height: number;
        }) {
          const deltas = edgeDeltas(clampToImage(computed, width, height), painted);
          return Math.max(...Object.values(deltas).map(Math.abs));
        },
      });

      return config;
    },
  },
});
