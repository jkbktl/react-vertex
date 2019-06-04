import { useEffect } from 'react'
// import { timer } from 'd3-timer'
import { useWebGLContext, useCanvas, useCanvasSize } from '@react-vertex/core'
import { TRANSPARENT, BACK_COLOR, SIM_RESOLUTION, DYE_RESOLUTION, SPLAT_RADIUS, CURL, PRESSURE_DISSIPATION, PRESSURE_ITERATIONS, VELOCITY_DISSIPATION, DENSITY_DISSIPATION } from './config'
import usePointers from './usePointers'
import { generateColor } from './utils'
import useSplatProgram from './useSplatProgram'
import useColorProgram from './useColorProgram'
import useBackgroundProgram from './useBackgroundProgram'
import useDisplayShadingProgram from './useDisplayShadingProgram'
import useCurlProgram from './useCurlProgram'
import useVorticityProgram from './useVorticityProgram'
import useDivergenceProgram from './useDivergenceProgram'
import useClearProgram from './useClearProgram'
// import usePressureProgram from './usePressureProgram'
// import useGradientProgram from './useGradientProgram'
// import useAdvectionProgram from './useAdvectionProgram'
import useResolution from './useResolution'
import { useFBO, useDoubleFBO } from './useDoubleFBO'
import useFormats from './useFormats'

export default function useSimulation() {
  const { width, height } = useCanvasSize()
  const canvas = useCanvas()

  console.log('useCanvasSize', width, height) // eslint-disable-line

  const gl = useWebGLContext()
  const pointers = usePointers()

  const splat = useSplatProgram()
  const color = useColorProgram()
  const background = useBackgroundProgram()
  const displayShading = useDisplayShadingProgram()

  const curl = useCurlProgram()
  const vorticity = useVorticityProgram()
  const divergence = useDivergenceProgram()
  const clear = useClearProgram()
  // const pressure = usePressureProgram()
  // const gradient = useGradientProgram()
  // const advection = useAdvectionProgram()

  const simSize = useResolution(SIM_RESOLUTION, width, height)
  const dyeSize = useResolution(DYE_RESOLUTION, width, height)

  const { rgb, halfFloat, hasLinear } = useFormats(gl)
  const filtering = hasLinear ? gl.LINEAR : gl.NEAREST

  const densityDFBO = useDoubleFBO(gl, dyeSize, rgb, halfFloat, filtering)
  const velocityDFBO = useDoubleFBO(gl, simSize, rgb, halfFloat, filtering)

  const curlFBO = useFBO(gl, simSize, rgb, halfFloat, gl.NEAREST)
  const pressureDFBO = useDoubleFBO(gl, simSize, rgb, halfFloat, gl.NEAREST)
  const divergenceFBO = useFBO(gl, simSize, rgb, halfFloat, gl.NEAREST)

  useEffect(() => { 
    if (!width || !height) {
      return
    }
    
    gl.clearColor(0.0, 0.0, 0.0, 1.0)
        
    class GLProgram {
      constructor (vertexShader, fragmentShader) {
        this.uniforms = {}
        this.program = gl.createProgram()

        gl.attachShader(this.program, vertexShader)
        gl.attachShader(this.program, fragmentShader)
        gl.linkProgram(this.program)

        if (!gl.getProgramParameter(this.program, gl.LINK_STATUS))
          throw gl.getProgramInfoLog(this.program)

        const uniformCount = gl.getProgramParameter(this.program, gl.ACTIVE_UNIFORMS)
        for (let i = 0; i < uniformCount; i++) {
          const uniformName = gl.getActiveUniform(this.program, i).name
          this.uniforms[uniformName] = gl.getUniformLocation(this.program, uniformName)
        }
      }
    
      bind () {
        gl.useProgram(this.program)
      }
    }
    
    function compileShader (type, source) {
      const shader = gl.createShader(type)
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
  
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        console.log(gl.getShaderInfoLog(shader)) //eslint-disable-line
  
      return shader
    }
    
    const baseVertexShader = compileShader(gl.VERTEX_SHADER, `
        precision highp float;

        attribute vec2 aPosition;
        varying vec2 vUv;
        varying vec2 vL;
        varying vec2 vR;
        varying vec2 vT;
        varying vec2 vB;
        uniform vec2 texelSize;

        void main () {
            vUv = aPosition * 0.5 + 0.5;
            vL = vUv - vec2(texelSize.x, 0.0);
            vR = vUv + vec2(texelSize.x, 0.0);
            vT = vUv + vec2(0.0, texelSize.y);
            vB = vUv - vec2(0.0, texelSize.y);
            gl_Position = vec4(aPosition, 0.0, 1.0);
        }
    `)

    const advectionManualFilteringShader = compileShader(gl.FRAGMENT_SHADER, `
        precision highp float;
        precision highp sampler2D;

        varying vec2 vUv;
        uniform sampler2D uVelocity;
        uniform sampler2D uSource;
        uniform vec2 texelSize;
        uniform vec2 dyeTexelSize;
        uniform float dt;
        uniform float dissipation;

        vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {
            vec2 st = uv / tsize - 0.5;

            vec2 iuv = floor(st);
            vec2 fuv = fract(st);

            vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);
            vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);
            vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);
            vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);

            return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
        }

        void main () {
            vec2 coord = vUv - dt * bilerp(uVelocity, vUv, texelSize).xy * texelSize;
            gl_FragColor = dissipation * bilerp(uSource, coord, dyeTexelSize);
            gl_FragColor.a = 1.0;
        }
    `)

    const advectionShader = compileShader(gl.FRAGMENT_SHADER, `
        precision highp float;
        precision highp sampler2D;

        varying vec2 vUv;
        uniform sampler2D uVelocity;
        uniform sampler2D uSource;
        uniform vec2 texelSize;
        uniform float dt;
        uniform float dissipation;

        void main () {
            vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
            gl_FragColor = dissipation * texture2D(uSource, coord);
            gl_FragColor.a = 1.0;
        }
    `)

    const pressureShader = compileShader(gl.FRAGMENT_SHADER, `
        precision mediump float;
        precision mediump sampler2D;

        varying highp vec2 vUv;
        varying highp vec2 vL;
        varying highp vec2 vR;
        varying highp vec2 vT;
        varying highp vec2 vB;
        uniform sampler2D uPressure;
        uniform sampler2D uDivergence;

        vec2 boundary (vec2 uv) {
            return uv;
            // uncomment if you use wrap or repeat texture mode
            // uv = min(max(uv, 0.0), 1.0);
            // return uv;
        }

        void main () {
            float L = texture2D(uPressure, boundary(vL)).x;
            float R = texture2D(uPressure, boundary(vR)).x;
            float T = texture2D(uPressure, boundary(vT)).x;
            float B = texture2D(uPressure, boundary(vB)).x;
            float C = texture2D(uPressure, vUv).x;
            float divergence = texture2D(uDivergence, vUv).x;
            float pressure = (L + R + B + T - divergence) * 0.25;
            gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
        }
    `)

    const gradientSubtractShader = compileShader(gl.FRAGMENT_SHADER, `
        precision mediump float;
        precision mediump sampler2D;

        varying highp vec2 vUv;
        varying highp vec2 vL;
        varying highp vec2 vR;
        varying highp vec2 vT;
        varying highp vec2 vB;
        uniform sampler2D uPressure;
        uniform sampler2D uVelocity;

        vec2 boundary (vec2 uv) {
            return uv;
            // uv = min(max(uv, 0.0), 1.0);
            // return uv;
        }

        void main () {
            float L = texture2D(uPressure, boundary(vL)).x;
            float R = texture2D(uPressure, boundary(vR)).x;
            float T = texture2D(uPressure, boundary(vT)).x;
            float B = texture2D(uPressure, boundary(vB)).x;
            vec2 velocity = texture2D(uVelocity, vUv).xy;
            velocity.xy -= vec2(R - L, T - B);
            gl_FragColor = vec4(velocity, 0.0, 1.0);
        }
    `)

    
    const blit = (() => {
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW)
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer())
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW)
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
      gl.enableVertexAttribArray(0)
  
      return (destination) => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, destination)
        gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0)
      }
    })()
    
    let simWidth
    let simHeight
    let dyeWidth
    let dyeHeight
    
    const advectionProgram           = new GLProgram(baseVertexShader, hasLinear ? advectionShader : advectionManualFilteringShader)
    const pressureProgram            = new GLProgram(baseVertexShader, pressureShader)
    const gradienSubtractProgram     = new GLProgram(baseVertexShader, gradientSubtractShader)
    
    function initFramebuffers () {  
      simWidth  = simSize[0]
      simHeight = simSize[1]
      dyeWidth  = dyeSize[0]
      dyeHeight = dyeSize[1]
    }
  
    initFramebuffers()

    const splatStack = []
    
    update()
    
    function update () {
      resizeCanvas()
      input()
      step(0.016)
      render(null)
      requestAnimationFrame(update)
    }

    function input () {
      if (splatStack.length > 0) {
        multipleSplats(splatStack.pop())
      }
  
      for (let i = 0; i < pointers.length; i++) {
        const p = pointers[i]
        if (p.moved) {
          updateSplat(p.x, p.y, p.dx, p.dy, p.color)
          console.log(p.x, p.y, p.dx, p.dy, p.color) // eslint-disable-line
          p.moved = false
        }
      }
    }
    
    function step (dt) {
      gl.disable(gl.BLEND)
      gl.viewport(0, 0, simWidth, simHeight)
  
      gl.useProgram(curl.program)
      gl.uniform2f(curl.uniforms.texelSize, 1.0 / simWidth, 1.0 / simHeight)
      gl.uniform1i(curl.uniforms.uVelocity, velocityDFBO.read.attach(0))
      blit(curlFBO.fbo)
  
      gl.useProgram(vorticity.program)
      gl.uniform2f(vorticity.uniforms.texelSize, 1.0 / simWidth, 1.0 / simHeight)
      gl.uniform1i(vorticity.uniforms.uVelocity, velocityDFBO.read.attach(0))
      gl.uniform1i(vorticity.uniforms.uCurl, curlFBO.attach(1))
      gl.uniform1f(vorticity.uniforms.curl, CURL)
      gl.uniform1f(vorticity.uniforms.dt, dt)
      blit(velocityDFBO.write.fbo)
      velocityDFBO.swap()
    
      gl.useProgram(divergence.program)
      gl.uniform2f(divergence.uniforms.texelSize, 1.0 / simWidth, 1.0 / simHeight)
      gl.uniform1i(divergence.uniforms.uVelocity, velocityDFBO.read.attach(0))
      blit(divergenceFBO.fbo)
  
      gl.useProgram(clear.program)
      gl.uniform1i(clear.uniforms.uTexture, pressureDFBO.read.attach(0))
      gl.uniform1f(clear.uniforms.value, PRESSURE_DISSIPATION)
      blit(pressureDFBO.write.fbo)
      pressureDFBO.swap()
  
      pressureProgram.bind()
      gl.uniform2f(pressureProgram.uniforms.texelSize, 1.0 / simWidth, 1.0 / simHeight)
      gl.uniform1i(pressureProgram.uniforms.uDivergence, divergenceFBO.attach(0))
      for (let i = 0; i < PRESSURE_ITERATIONS; i++) {
        gl.uniform1i(pressureProgram.uniforms.uPressure, pressureDFBO.read.attach(1))
        blit(pressureDFBO.write.fbo)
        pressureDFBO.swap()
      }
    
      gradienSubtractProgram.bind()
      gl.uniform2f(gradienSubtractProgram.uniforms.texelSize, 1.0 / simWidth, 1.0 / simHeight)
      gl.uniform1i(gradienSubtractProgram.uniforms.uPressure, pressureDFBO.read.attach(0))
      gl.uniform1i(gradienSubtractProgram.uniforms.uVelocity, velocityDFBO.read.attach(1))
      blit(velocityDFBO.write.fbo)
      velocityDFBO.swap()
  
      advectionProgram.bind()
      gl.uniform2f(advectionProgram.uniforms.texelSize, 1.0 / simWidth, 1.0 / simHeight)
      
      if (!hasLinear) {
        gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, 1.0 / simWidth, 1.0 / simHeight)
      }
      
      let velocityId = velocityDFBO.read.attach(0)
      gl.uniform1i(advectionProgram.uniforms.uVelocity, velocityId)
      gl.uniform1i(advectionProgram.uniforms.uSource, velocityId)
      gl.uniform1f(advectionProgram.uniforms.dt, dt)
      gl.uniform1f(advectionProgram.uniforms.dissipation, VELOCITY_DISSIPATION)
      blit(velocityDFBO.write.fbo)
      velocityDFBO.swap()
    
      gl.viewport(0, 0, dyeWidth, dyeHeight)
  
      if (!hasLinear) {
        gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, 1.0 / dyeWidth, 1.0 / dyeHeight)
      }

      gl.uniform1i(advectionProgram.uniforms.uVelocity, velocityDFBO.read.attach(0))
      gl.uniform1i(advectionProgram.uniforms.uSource, densityDFBO.read.attach(1))
      gl.uniform1f(advectionProgram.uniforms.dissipation, DENSITY_DISSIPATION)
      blit(densityDFBO.write.fbo)
      densityDFBO.swap()
    }
    
    function render (target) {
      if (target == null || !TRANSPARENT) {
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
        gl.enable(gl.BLEND)
      }
      else {
        gl.disable(gl.BLEND)
      }
    
      let width  = target == null ? gl.drawingBufferWidth : dyeWidth
      let height = target == null ? gl.drawingBufferHeight : dyeHeight
    
      gl.viewport(0, 0, width, height)
  
      if (!TRANSPARENT) {
        gl.useProgram(color.program)
        let bc = BACK_COLOR
        gl.uniform4f(color.uniforms.color, bc.r / 255, bc.g / 255, bc.b / 255, 1)
        blit(target)
      }
    
      if (target == null && TRANSPARENT) {
        gl.useProgram(background.program)
        gl.uniform1f(background.uniforms.aspectRatio, width / height)
        blit(null)
      }
    
      gl.useProgram(displayShading.program)
      gl.uniform2f(displayShading.uniforms.texelSize, 1.0 / width, 1.0 / height)
      gl.uniform1i(displayShading.uniforms.uTexture, densityDFBO.read.attach(0))

      blit(target)
    }
    
    function updateSplat (x, y, dx, dy, splatRGB) {
      // console.log('point: ',  x / width, 1.0 - y / height)

      gl.viewport(0, 0, simWidth, simHeight)

      gl.useProgram(splat.program)
      gl.uniform1i(splat.uniforms.uTarget, velocityDFBO.read.attach(0))
      gl.uniform1f(splat.uniforms.aspectRatio, width / height)
      gl.uniform2f(splat.uniforms.point, x / width, 1.0 - y / height)
      gl.uniform3f(splat.uniforms.color, dx, -dy, 1.0)
      gl.uniform1f(splat.uniforms.radius, SPLAT_RADIUS / 100.0)
      blit(velocityDFBO.write.fbo)
      velocityDFBO.swap()
    
      gl.viewport(0, 0, dyeWidth, dyeHeight)
      gl.uniform1i(splat.uniforms.uTarget, densityDFBO.read.attach(0))
      gl.uniform3f(splat.uniforms.color, splatRGB.r, splatRGB.g, splatRGB.b)
      blit(densityDFBO.write.fbo)
      densityDFBO.swap()
    }
    
    function multipleSplats (amount) {
      for (let i = 0; i < amount; i++) {
        const color = generateColor()
        color.r *= 10.0
        color.g *= 10.0
        color.b *= 10.0
        const x = width * Math.random()
        const y = height * Math.random()
        const dx = 1000 * (Math.random() - 0.5)
        const dy = 1000 * (Math.random() - 0.5)
        updateSplat(x, y, dx, dy, color)
      }
    }

    multipleSplats(parseInt(Math.random() * 20) + 5)
    
    function resizeCanvas () {
      // if (width != canvas.clientWidth || height != canvas.clientHeight) {
      //   width = canvas.clientWidth
      //   height = canvas.clientHeight
      //   initFramebuffers()
      // }
    }
    
  }, [gl, pointers, width, height, canvas])

  return 1
}