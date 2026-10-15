const linear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const encoded = (v) =>
  v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
const vertex = `#version 300 es
out vec2 uv;void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));uv=p;gl_Position=vec4(p*2.0-1.0,0,1);}`;
export class LinearCompositor {
  constructor(width, height) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = width;
    this.canvas.height = height;
    this.width = width;
    this.height = height;
    const gl = this.canvas.getContext("webgl2", {
      alpha: false,
      preserveDrawingBuffer: true,
      antialias: false,
    });
    if (!gl || !gl.getExtension("EXT_color_buffer_float")) {
      this.cpu = true;
      this.values = new Float32Array(width * height * 3);
      return;
    }
    this.gl = gl;
    const program = (body) => {
      const p = gl.createProgram();
      for (const [type, source] of [
        [gl.VERTEX_SHADER, vertex],
        [
          gl.FRAGMENT_SHADER,
          `#version 300 es\nprecision highp float;in vec2 uv;uniform sampler2D pixels;out vec4 color;${body}`,
        ],
      ]) {
        const s = gl.createShader(type);
        gl.shaderSource(s, source);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
          throw Error(gl.getShaderInfoLog(s));
        gl.attachShader(p, s);
        gl.deleteShader(s);
      }
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS))
        throw Error(gl.getProgramInfoLog(p));
      return p;
    };
    this.upload = program(
      `void main(){vec4 s=texture(pixels,uv);vec3 l=mix(s.rgb/12.92,pow((s.rgb+.055)/1.055,vec3(2.4)),step(vec3(.04045),s.rgb));color=vec4(l*s.a,s.a);}`,
    );
    this.present = program(
      `void main(){vec3 l=texture(pixels,uv).rgb;vec3 s=mix(l*12.92,1.055*pow(max(l,vec3(0)),vec3(1.0/2.4))-.055,step(vec3(.0031308),l));color=vec4(s,1);}`,
    );
    this.grainProgram = program(`uniform sampler2D noiseTex;uniform float amount;uniform vec2 noiseSize;void main(){vec2 uvp=gl_FragCoord.xy/vec2(${width}.0,${height}.0);vec4 d=texture(pixels,uvp);float n=texture(noiseTex,(floor(vec2(uvp.x,1.0-uvp.y)*noiseSize)+.5)/noiseSize).r;vec3 o=mix(2.0*d.rgb*n,1.0-2.0*(1.0-d.rgb)*(1.0-n),step(vec3(.5),d.rgb));color=vec4(mix(d.rgb,o,amount),d.a);}`);
    function texture() {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }
    this.source = texture();
    this.target = texture();
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA16F,
      width,
      height,
      0,
      gl.RGBA,
      gl.HALF_FLOAT,
      null,
    );
    this.framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.target,
      0,
    );
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
      throw Error("Linear working framebuffer unavailable");
    gl.viewport(0, 0, width, height);
  }
  begin(rgb) {
    if (this.cpu) {
      for (let i = 0; i < this.values.length; i++)
        this.values[i] = linear(rgb[i % 3] / 255);
      return;
    }
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.disable(gl.BLEND);
    gl.clearColor(...rgb.map((v) => linear(v / 255)), 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
  add(canvas) {
    if (this.cpu) {
      const bytes = canvas
        .getContext("2d")
        .getImageData(0, 0, this.width, this.height).data;
      for (let p = 0; p < this.width * this.height; p++) {
        const a = bytes[p * 4 + 3] / 255;
        if (!a) continue;
        for (let c = 0; c < 3; c++) {
          const i = p * 3 + c;
          this.values[i] =
            linear(bytes[p * 4 + c] / 255) * a + this.values[i] * (1 - a);
        }
      }
      return;
    }
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.bindTexture(gl.TEXTURE_2D, this.source);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.useProgram(this.upload);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  grain({ seed = 0, frame = 0, opacity = 0.055, width = 320, height = 180 } = {}) {
    if (opacity === 0) return;
    if (!Number.isFinite(opacity) || opacity <= 0 || opacity > 1 ||
        !Number.isInteger(width) || !Number.isInteger(height) ||
        width < 1 || height < 1 || width > 4096 || height > 4096 ||
        width * height > 1_048_576 || !Number.isSafeInteger(seed) || seed < -2147483648 || seed > 2147483647 ||
        !Number.isSafeInteger(frame) || frame < 0 || frame > 2147483647) throw Error("Invalid frame grain parameters");
    const noise = new Uint8Array(width * height);
    for (let i = 0; i < noise.length; i++) noise[i] = (Math.imul((i + seed + frame) | 0, 0x9e3779b1) >>> 24);
    if (this.cpu) {
      for (let p = 0; p < this.width * this.height; p++) {
        const s = noise[Math.floor(p % this.width * width / this.width) + Math.floor(p / this.width * height / this.height) * width] / 255;
        for (let c = 0; c < 3; c++) { const i = p * 3 + c, d = this.values[i]; const o = d <= .5 ? 2*d*s : 1-2*(1-d)*(1-s); this.values[i] += (o-d)*opacity; }
      }
      return;
    }
    const gl = this.gl, noiseTexture = gl.createTexture();
    // add() leaves UNPACK_FLIP_Y enabled for canvas uploads; the noise tile is
    // addressed bottom-up in the shader, so upload it unflipped.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    // Copy the working frame first: the grain pass reads the copy and writes
    // back into the working framebuffer.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    const copy = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, copy);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 0, 0, this.width, this.height, 0);
    gl.bindTexture(gl.TEXTURE_2D, noiseTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, noise);
    gl.useProgram(this.grainProgram);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, copy);
    gl.uniform1i(gl.getUniformLocation(this.grainProgram, "pixels"), 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, noiseTexture);
    gl.uniform1i(gl.getUniformLocation(this.grainProgram, "noiseTex"), 1);
    gl.uniform2f(gl.getUniformLocation(this.grainProgram, "noiseSize"), width, height);
    gl.uniform1f(gl.getUniformLocation(this.grainProgram, "amount"), opacity);
    gl.disable(gl.BLEND); gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.deleteTexture(noiseTexture); gl.deleteTexture(copy);
    // add()/finish() bind with the default unit; leave it selected.
    gl.activeTexture(gl.TEXTURE0);
  }
  finish(context) {
    if (this.cpu) {
      const pixels = new Uint8ClampedArray(this.width * this.height * 4);
      for (let p = 0; p < this.width * this.height; p++) {
        for (let c = 0; c < 3; c++)
          pixels[p * 4 + c] = encoded(this.values[p * 3 + c]) * 255;
        pixels[p * 4 + 3] = 255;
      }
      context.putImageData(
        new ImageData(pixels, this.width, this.height),
        0,
        0,
      );
      return;
    }
    const gl = this.gl;
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, this.target);
    gl.useProgram(this.present);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    context.drawImage(this.canvas, 0, 0);
  }
}
