import path from 'node:path';
import { createLocalManifest, writeManifest } from './manifest.js';
import { LOCAL_MANIFEST_PATH } from './paths.js';

export default function eleventyBunnyManifest(eleventyConfig, options = {}) {
  const projectDirectory = path.resolve(options.projectDirectory ?? process.cwd());
  const manifestPath = path.resolve(projectDirectory, LOCAL_MANIFEST_PATH);
  const runModes = new Set(options.runModes ?? ['build']);
  let passthroughMap;

  eleventyConfig.on('eleventy.before', () => {
    passthroughMap = undefined;
  });

  // Eleventy 3 emits this destination-to-source map after all passthrough copies finish.
  eleventyConfig.on('eleventy.passthrough', ({ map }) => {
    passthroughMap = map;
  });

  eleventyConfig.on('eleventy.after', async ({ directories, results, runMode, outputMode }) => {
    if (!runModes.has(runMode) || outputMode !== 'fs') return;
    const outputDirectory = path.resolve(projectDirectory, directories.output);
    const manifest = await createLocalManifest({
      results,
      passthroughMap,
      outputDirectory,
      projectDirectory,
      hashConcurrency: options.hashConcurrency ?? 8,
      preserve: options.preserve ?? [],
    });
    await writeManifest(manifestPath, manifest);
    console.log(`[Bunny manifest] Wrote ${manifest.files.length} files to ${path.relative(projectDirectory, manifestPath)}`);
  });
}

export { eleventyBunnyManifest };
