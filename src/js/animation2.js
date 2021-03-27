import mouse from "js/mouse";
import { mapclamp } from "js/lib";
import Shader from "js/shader";
import Texture from "js/texture";

import vertexShaderSource1 from "shaders/rain.vert";
import fragmentShaderSource1 from "shaders/heatmap.frag";

import vertexShaderSource2 from "shaders/rain.vert";
import fragmentShaderSource2 from "shaders/rain.frag";

const config = {
  shut: true,
};

function distance(d1, d2 = { x: 0, y: 0 }) {
  return Math.sqrt((d2.x - d1.x) ** 2 + (d2.y - d1.y) ** 2);
}

function getVectorTo(origin, target) {
  const dist = distance(origin, target);
  if (dist === 0) {
    return { x: 0, y: 0 };
  }
  return {
    x: (target.x - origin.x) / dist,
    y: (target.y - origin.y) / dist,
  };
}

function mapArrValue(arr, val, max) {
  let interval = max / (arr.length - 1);
  let i = Math.floor(val / interval);
  let w = (val % interval) / interval;
  let smoothstep = 3 * w ** 2 - 2 * w ** 3;
  let ret = arr[i] * (1 - smoothstep) + arr[i + 1] * smoothstep;
  if (ret === NaN) {
    debugger;
  }
  return ret;
}

function isPowerOf2(value) {
  return (value & (value - 1)) == 0;
}

class Animation {
  cnv = null;
  gl = null;
  size = { w: 0, h: 0, cx: 0, cy: 0 };

  lastFrameTime = 0;
  currentFrameTime = 0;
  fps = 60;
  fpsHistory = [];

  proj = [];

  interval = 50;
  psize = 5.0;
  startTime = 0.0;
  time = 0.0;
  texture = null;
  texture2 = null;

  uvmouse = {
    x: 0.0,
    y: 0.0,
  };
  lastmousepos = {
    x: 0.0,
    y: 0.0,
  };
  mouseintensity = 0.0;

  // gl stuff

  program1 = null;
  program2 = null;

  // Uniforms

  a_positionLocation = null;
  u_MVP = null;
  u_lBounds = null;
  u_time = null;
  u_Size = null;
  u_Sampler = null;
  u_Mouse = null;
  u_MouseInt = null;
  u_asp = null;
  u_SamplerH = null;

  // shader2
  a_positionLocation2 = null;
  u_Sampler2 = null;
  u_Mouse2 = null;
  frameBuffer = null;

  init() {
    this.createCanvas();
    this.updateAnimation();
  }

  calculateMVP() {
    let left, right, top, bottom, far, near;
    const ratio = this.size.w / this.size.h;

    left = 0;
    right = 1;

    bottom = 1;
    top = 0;

    near = 0.0;
    far = 1.0;

    // prettier-ignore
    this.proj = [ 
      2 / (right - left),                   0,                 0,  -(right + left) / (right - left),
                       0,  2 / (top - bottom),                 0,  -(top + bottom) / (top - bottom),
                       0,                   0,  2 / (far - near),      -(far + near) / (far - near),
                       0,                   0,                 0,                                 1,
    ];
  }

  createCanvas() {
    this.cnv = document.createElement(`canvas`);
    document.body.appendChild(this.cnv);
    this.cnv.id = "canvas";

    const gl = (this.gl = this.cnv.getContext("webgl2"));

    this.rainShader = new Shader(gl);
    this.rainShader.createProgram(vertexShaderSource1, fragmentShaderSource1);

    this.heatmapShader = new Shader(gl);
    this.heatmapShader.createProgram(
      vertexShaderSource2,
      fragmentShaderSource2
    );

    const vertexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);

    // prettier-ignore
    const positions = [
      -1.0, -1.0, 
       1.0, -1.0, 
       1.0,  1.0, 
      -1.0,  1.0
    ];
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);

    const indexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);

    // prettier-ignore
    const indices = [
      0, 1, 2, 
      2, 3, 0
    ];

    gl.bufferData(
      gl.ELEMENT_ARRAY_BUFFER,
      new Uint16Array(indices),
      gl.STATIC_DRAW
    );

    this.heatmapShader.useProgram();
    this.heatmapShader.setPositions("aPos");
    this.heatmapShader.addUniform("u_Sampler", "1i");
    this.heatmapShader.addUniform("u_Mouse", "2f");

    this.rainShader.useProgram();
    this.rainShader.setPositions("aPos");
    this.rainShader.addUniform("u_MVP", "4fv");
    this.rainShader.addUniform("u_time", "1f");
    this.rainShader.addUniform("u_Size", "1f");
    this.rainShader.addUniform("u_Sampler", "1i");
    this.rainShader.addUniform("u_SamplerH", "1i");
    this.rainShader.addUniform("u_Mouse", "2f");
    this.rainShader.addUniform("u_MouseInt", "1f");
    this.rainShader.addUniform("u_asp", "1f");

    this.setCanvasSize();
    window.addEventListener(`resize`, () => {
      this.setCanvasSize();
    });

    this.startTime = Date.now();

    this.texture = new Texture(gl).fromUrl("img/bg1.jpg");

    this.targetTextureWidth = 256;
    this.targetTextureHeight = 256;
    this.texture2 = new Texture(gl).empty(
      this.targetTextureWidth,
      this.targetTextureHeight
    );

    // Create and bind the framebuffer
    this.frameBuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.frameBuffer);

    // attach the texture as the first color attachment
    const attachmentPoint = gl.COLOR_ATTACHMENT0;
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      attachmentPoint,
      gl.TEXTURE_2D,
      this.texture2,
      0
    );
  }

  updateCanvas() {
    this.time = (Date.now() - this.startTime) / 1000.0;

    this.calculateMVP();
    this.getMouse();

    this.drawHeatMap();
    this.drawImage();
  }

  drawImage() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.rainShader.useProgram();
    this.rainShader.setUniform("u_MVP", this.proj);
    this.rainShader.setUniform("u_time", this.time);
    this.rainShader.setUniform("u_Size", this.psize);
    this.rainShader.setUniform("u_Mouse", this.uvmouse.x, this.uvmouse.y);
    this.rainShader.setUniform("u_MouseInt", this.mouseintensity);
    this.rainShader.setUniform("u_asp", this.size.w / this.size.h);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    this.rainShader.setUniform("u_Sampler", 0);

    gl.clearColor(0.0, 0.0, 0.0, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  }

  drawHeatMap() {
    const gl = this.gl;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.frameBuffer);

    this.heatmapShader.useProgram();
    this.heatmapShader.setUniform("u_Mouse2", this.uvmouse.x, this.uvmouse.y);

    gl.bindTexture(gl.TEXTURE_2D, null);
    // this.heatmapShader.setUniform("u_Sampler2", 0);

    gl.viewport(0, 0, this.targetTextureWidth, this.targetTextureHeight);

    gl.clearColor(0.0, 0.0, 0.0, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  setCanvasSize() {
    this.size.w = this.cnv.width = window.innerWidth;
    this.size.h = this.cnv.height = window.innerHeight;
    this.size.cx = this.size.w / 2;
    this.size.cy = this.size.h / 2;
    this.gl.viewport(0, 0, this.size.w, this.size.h);
  }

  getMouse() {
    let x = mouse.x;
    let y = mouse.y;
    if (isFinite(x) && isFinite(y)) {
      this.uvmouse = {
        x: mapclamp(x, 0, this.size.w, 0, 1),
        y: mapclamp(y, 0, this.size.h, 0, 1),
      };

      const dx = x - this.lastmousepos.x;
      const dy = y - this.lastmousepos.y;
      const d = dx * dx + dy * dy;

      this.lastmousepos = {
        ...{ x, y },
      };

      if (d > 0) {
        this.mouseintensity -= mapclamp(d, 0, 2000, 0.0, 0.1);
        this.mouseintensity = this.mouseintensity < 0 ? 0 : this.mouseintensity;
        return;
      }
    }
    this.mouseintensity += 0.01;
    this.mouseintensity = this.mouseintensity > 1 ? 1 : this.mouseintensity;
  }

  calculateFps() {
    if (this.lastFrameTime == 0) {
      this.lastFrameTime = this.time;
    } else {
      this.currentFrameTime = this.time - this.lastFrameTime;
      this.fpsHistory.push(1 / this.currentFrameTime);
      this.lastFrameTime = this.time;
      if (this.fpsHistory.length > 20) {
        const sum = this.fpsHistory.reduce((a, b) => a + b, 0);
        const avg = sum / this.fpsHistory.length || 0;
        this.fps = avg;
        this.fpsHistory = [];
        if (config.shut !== true) {
          console.log("Animation fps ", Math.round(this.fps, 0));
        }
      }
    }
  }

  // animation loop
  updateAnimation() {
    this.updateCanvas();
    this.calculateFps();
    window.requestAnimationFrame(() => {
      this.updateAnimation();
    });
  }
}

window.onload = () => {
  new Animation().init();
};
