# Aquarium generated assets

Mode: built-in image_gen tool (not CLI).

Workspace assets:
- [aquascape.png](../apps/web/public/aquarium/aquascape.png)
- [fish-atlas.png](../apps/web/public/aquarium/fish-atlas.png)

## Final background prompt

Use case: photorealistic natural aquascape background for a realtime aquarium application. Generate one premium highly photorealistic underwater freshwater planted aquarium environment, wide landscape 16:9, at least 2048px. Camera submerged eye-level looking through crystal-clear teal freshwater, no aquarium frame, no exterior room. Nature-aquarium competition quality: layered weathered gray seiryu rocks with detailed erosion and moss, richly textured branching dark driftwood arranged asymmetrically on left and right lower thirds, delicate lush small-leaved green aquatic plants of several species, foreground sandy winding path and fine gravel, immense sense of depth with hazy distant stems. Upper half and middle have open blue-green water space for animated fish and translucent floating file windows that will be composited later. Soft physically believable sunlight rays from upper left, subtle caustic highlights on stone and sand, cinematic natural photography, realistic restrained colors, high material detail. NO fish, NO animals, NO bubbles, NO text, NO frames, NO UI, NO watermarks. Water plants clustered naturally not repeating evenly. Real photograph aesthetic, not cartoon, not vector, not painting. The scene fills the entire image edge to edge. Save the generated asset for use in the local software project.

## Final fish atlas prompt

Asset type: photorealistic fish sprite atlas for a realtime aquarium. Output one square PNG with genuinely transparent background and alpha, no white matte, no shadows outside the animals. Three separate horizontal equal-height rows, a single realistic freshwater fish in each row, all facing RIGHT, perfectly side-on at camera level, each centered in its own row, whole tail and fins visible, generous transparent gap between rows. Top third: neon tetra with iridescent cyan lateral stripe and red lower rear body, translucent delicate fins, anatomically natural very small eye. Middle third: a silver-green harlequin rasbora with copper highlights and black triangular patch in rear half, translucent fins. Bottom third: a pearl gourami with pearly iridescent spotted scales, softly elongated oval body, long thin pelvic feelers, natural transparent fins. Each fish spans approximately 80% of total image width. The full animal including fins must stay strictly within its own third of the image. Premium underwater macro wildlife photography realism, detailed scales, realistic wet specular highlights, no illustration, no cartoon, no outlines, no text, no labels, no scenery. Lighting softly from upper left, subtle cool freshwater tint. Keep fish separate and do not overlap.

The actual atlas uses normalized row crop regions [0.005, 0.282], [0.289, 0.283], [0.575, 0.397] (top, height) to match the generated composition. Assets are copied unchanged and alpha is preserved.
