// Water layer of the aquarium: the photographed scene, warped live on the GPU.
// - Plants (a green mask computed from the photo) sway in slow, clumped waves.
// - The surface near the top ripples and glitters.
// - Sun rays from the upper left drift across the tank.
// Returns null when WebGL is unavailable; the caller then paints a still photo instead.
export type WaterRenderer = {
  resize(width: number, height: number, dpr: number): void;
  setPhoto(image: HTMLImageElement): void;
  draw(time: number): void;
  dispose(): void;
};

// The vertex stage shares no uniforms with the fragment stage, so their precisions can never disagree.
export const VERTEX = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0., 1.); }`;

export const FRAGMENT = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D u_photo;
uniform sampler2D u_mask;
uniform vec2 u_size;
uniform vec2 u_pixels;
uniform vec4 u_cover;
uniform float u_time;
uniform float u_ready;

void main() {
  // Position in CSS pixels, y down.
  vec2 p = vec2(gl_FragCoord.x, u_pixels.y - gl_FragCoord.y) * u_size / u_pixels;
  vec2 uv = (p - u_cover.xy) / u_cover.zw;
  // Gentle refraction of the whole scene.
  uv.x += (sin(uv.y * 9. + u_time * .28) * 1.7 + sin(uv.y * 21. - u_time * .18) * .7) / u_cover.z;
  // Plants sway where the photo is green; clumps move at their own pace.
  // Amplitude in photo pixels; clumps drift at their own pace and tips move more than bases.
  float m = texture2D(u_mask, uv).r;
  float clump = .6 + .4 * sin(uv.x * 6.3 + uv.y * 4.1 + u_time * .21);
  float sway = m * (6. + 10. * m) * clump * u_cover.z / 1600.;
  vec2 d = vec2(sin(uv.x * 14. + uv.y * 6. + u_time * .9) * .7 + sin(uv.x * 37. - uv.y * 19. - u_time * .62) * .3,
                sin(uv.x * 23. + u_time * .75 + uv.y * 11.) * .4);
  uv += d * sway / u_cover.zw;
  // The surface band heaves and ripples, and catches light.
  float surf = smoothstep(.26, 0., uv.y);
  vec2 wave = vec2(sin(uv.x * 30. + u_time * 1.3 + uv.y * 18.) * 6. + sin(uv.x * 11. - u_time * .5) * 5.,
                   sin(uv.x * 19. - u_time * .9 + uv.y * 35.) * 8. + sin(uv.x * 7. + u_time * .35) * 6.);
  uv += wave * surf * u_cover.z / 1600. / u_cover.zw;
  vec2 cuv = clamp(uv, 0., 1.);
  vec3 photo = texture2D(u_photo, cuv).rgb;
  vec3 deep = mix(vec3(.082, .349, .384), vec3(.027, .118, .145), p.y / u_size.y);
  vec3 c = mix(deep, photo, u_ready);
  c = mix(c, vec3(.012, .149, .192), .21);
  float glint = sin(uv.x * 26. + u_time * 1.7 + uv.y * 30.) * sin(uv.x * 15.3 - u_time * 1.1 + uv.y * 22.);
  float shimmer = surf * (.35 + .65 * pow(max(0., glint), 2.));
  c += vec3(.8, .97, .92) * shimmer * .28;
  // Sun rays.
  vec2 rp = p / u_size;
  float s = rp.x * .9 - rp.y * .35;
  float rays = pow(max(0., sin(s * 14. + u_time * .11) * .5 + .5), 6.) * .55 + pow(max(0., sin(s * 31. - u_time * .07 + 1.3) * .5 + .5), 9.) * .45;
  rays *= pow(1. - rp.y, 1.6) * (.6 + .4 * sin(u_time * .3 + s * 5.));
  c += vec3(.62, .9, .82) * rays * .12;
  gl_FragColor = vec4(c, 1.);
}`;

// Greenness of the photo, blurred, so stems and leaves move while rocks, wood and sand stay put.
export function plantMask(pixels: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const raw = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const rows = Math.min(1, Math.max(0, (y / height - .2) / .12));
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4, r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
      raw[y * width + x] = Math.min(1, Math.max(0, (g - Math.max(r, b) - 6) / 42)) * rows;
    }
  }
  let src = raw, dst = new Float32Array(width * height);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let sum = 0, n = 0;
      for (let k = -2; k <= 2; k++) { const xx = x + k; if (xx >= 0 && xx < width) { sum += src[y * width + xx]; n++; } }
      dst[y * width + x] = sum / n;
    }
    [src, dst] = [dst, src];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let sum = 0, n = 0;
      for (let k = -2; k <= 2; k++) { const yy = y + k; if (yy >= 0 && yy < height) { sum += src[yy * width + x]; n++; } }
      dst[y * width + x] = sum / n;
    }
    [src, dst] = [dst, src];
  }
  return Uint8Array.from(src, (v) => Math.round(v * 255));
}

export function createWaterRenderer(canvas: HTMLCanvasElement): WaterRenderer | null {
  let gl: WebGLRenderingContext | null = null;
  try { gl = canvas.getContext('webgl', { alpha: false, antialias: false, preserveDrawingBuffer: true }); } catch { gl = null; }
  if (!gl) { console.warn('WebGL が使えないため水槽は静止写真で表示します'); return null; }
  const compile = (type: number, source: string) => {
    const shader = gl!.createShader(type)!;
    gl!.shaderSource(shader, source); gl!.compileShader(shader);
    if (!gl!.getShaderParameter(shader, gl!.COMPILE_STATUS)) throw new Error(gl!.getShaderInfoLog(shader) || (gl!.isContextLost() ? 'context lost' : 'compile failed'));
    return shader;
  };
  let program: WebGLProgram;
  try {
    program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'link');
  } catch (error) { console.warn('水の描画（WebGL）を準備できないため静止写真で表示します', error); return null; }
  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, 'a_pos');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const uniform = (name: string) => gl!.getUniformLocation(program, name);
  const u = { size: uniform('u_size'), pixels: uniform('u_pixels'), cover: uniform('u_cover'), time: uniform('u_time'), ready: uniform('u_ready'), photo: uniform('u_photo'), mask: uniform('u_mask') };
  const texture = (unit: number) => {
    const t = gl!.createTexture()!;
    gl!.activeTexture(gl!.TEXTURE0 + unit); gl!.bindTexture(gl!.TEXTURE_2D, t);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE); gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.LINEAR); gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.LINEAR);
    gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, 1, 1, 0, gl!.RGBA, gl!.UNSIGNED_BYTE, new Uint8Array([8, 41, 50, 255]));
    return t;
  };
  const textures = [texture(0), texture(1)];
  gl.uniform1i(u.photo, 0); gl.uniform1i(u.mask, 1);
  let width = 1, height = 1, photo: HTMLImageElement | null = null, ready = 0;
  const cover = () => {
    if (!photo) { gl!.uniform4f(u.cover, 0, 0, Math.max(1, width), Math.max(1, height)); return; }
    const scale = Math.max(width / photo.naturalWidth, height / photo.naturalHeight);
    const w = photo.naturalWidth * scale, h = photo.naturalHeight * scale;
    gl!.uniform4f(u.cover, (width - w) / 2, (height - h) / 2, w, h);
  };
  return {
    resize(w, h, dpr) {
      width = w; height = h;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      gl!.viewport(0, 0, canvas.width, canvas.height);
      gl!.uniform2f(u.size, w, h); gl!.uniform2f(u.pixels, canvas.width, canvas.height); cover();
    },
    setPhoto(image) {
      if (!image.complete || !image.naturalWidth) return;
      photo = image;
      const mw = 256, mh = Math.max(1, Math.round(256 * image.naturalHeight / image.naturalWidth));
      const scratch = document.createElement('canvas'); scratch.width = mw; scratch.height = mh;
      const c2d = scratch.getContext('2d', { willReadFrequently: true });
      gl!.activeTexture(gl!.TEXTURE0); gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, gl!.RGBA, gl!.UNSIGNED_BYTE, image);
      if (c2d) {
        c2d.drawImage(image, 0, 0, mw, mh);
        const mask = plantMask(c2d.getImageData(0, 0, mw, mh).data, mw, mh);
        gl!.activeTexture(gl!.TEXTURE1); gl!.pixelStorei(gl!.UNPACK_ALIGNMENT, 1);
        gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.LUMINANCE, mw, mh, 0, gl!.LUMINANCE, gl!.UNSIGNED_BYTE, mask);
      }
      ready = 1; cover();
    },
    draw(time) {
      gl!.uniform1f(u.time, time % 3600); gl!.uniform1f(u.ready, ready);
      gl!.drawArrays(gl!.TRIANGLE_STRIP, 0, 4);
    },
    // Free GPU objects but keep the context: a lost context stays lost on the same canvas,
    // and React can re-run this effect on the same element.
    dispose() { for (const t of textures) gl!.deleteTexture(t); gl!.deleteBuffer(buffer); gl!.deleteProgram(program); },
  };
}
