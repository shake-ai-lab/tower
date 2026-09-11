# Aquarium assets

Generated for Tower with the built-in image generation tool (2026-09-12).

- aquascape.png: fish-free photorealistic planted freshwater environment.
- fish-atlas.png: alpha-preserving sprite atlas; neon tetra, rasbora, pearl gourami.

Aquarium.tsx samples three vertical atlas regions and tints each into the colour/body variants listed in `LOOKS` (aquarium-simulation.ts), once at load. The renderer bends narrow strips near the tail and uses independent simulation for movement. Original generated files remain in the Codex generated_images directory; the runtime assets are bundled here.
