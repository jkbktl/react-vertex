import { useEffect } from 'react'
import { timer } from 'd3-timer'
import { useWebGLContext, useCanvasSize } from '@react-vertex/core'
import { SIM_RESOLUTION, DYE_RESOLUTION, SPLAT_RADIUS, CURL, PRESSURE_DISSIPATION, PRESSURE_ITERATIONS, VELOCITY_DISSIPATION, DENSITY_DISSIPATION } from './config'
import usePointers from './usePointers'
import useSplatProgram from './useSplatProgram'
import useColorProgram from './useColorProgram'
import useBackgroundProgram from './useBackgroundProgram'
import useDisplayShadingProgram from './useDisplayShadingProgram'
import useCurlProgram from './useCurlProgram'
import useVorticityProgram from './useVorticityProgram'
import useDivergenceProgram from './useDivergenceProgram'
import useClearProgram from './useClearProgram'
import usePressureProgram from './usePressureProgram'
import useGradientProgram from './useGradientProgram'
import useAdvectionProgram from './useAdvectionProgram'
import useResolution from './useResolution'
import { useFBO, useDoubleFBO } from './useDoubleFBO'
import useFormats from './useFormats'

export default function useSimulation() {
  const { width, height } = useCanvasSize()

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
  const pressure = usePressureProgram()
  const gradient = useGradientProgram()
  const advection = useAdvectionProgram()

  const simSize = useResolution(SIM_RESOLUTION, width, height)
  const dyeSize = useResolution(DYE_RESOLUTION, width, height)

  const { rgb, halfFloat, hasLinear } = useFormats(gl)
  const filtering = hasLinear ? gl.LINEAR : gl.NEAREST

  const velocityDFBO = useDoubleFBO(gl, simSize, rgb, halfFloat, filtering)
  const densityDFBO = useDoubleFBO(gl, dyeSize, rgb, halfFloat, filtering)

  const curlFBO = useFBO(gl, simSize, rgb, halfFloat, gl.NEAREST)
  const divergenceFBO = useFBO(gl, simSize, rgb, halfFloat, gl.NEAREST)
  const pressureDFBO = useDoubleFBO(gl, simSize, rgb, halfFloat, gl.NEAREST)

  useEffect(() => {
    console.log('Canvas Size: ', [width, height])
    console.log('Sim Size: ', simSize)
    console.log('Dye Size: ', dyeSize)

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

    function step (dt) {
      gl.disable(gl.BLEND)
      gl.viewport(0, 0, ...simSize)
  
      gl.useProgram(curl.program)
      gl.uniform2f(curl.uniforms.texelSize, 1.0 / simSize[0], 1.0 / simSize[1])
      gl.uniform1i(curl.uniforms.uVelocity, velocityDFBO.read.attach(0))
      blit(curlFBO.fbo)
  
      gl.useProgram(vorticity.program)
      gl.uniform2f(vorticity.uniforms.texelSize, 1.0 / simSize[0], 1.0 / simSize[1])
      gl.uniform1i(vorticity.uniforms.uVelocity, velocityDFBO.read.attach(0))
      gl.uniform1i(vorticity.uniforms.uCurl, curlFBO.attach(1))
      gl.uniform1f(vorticity.uniforms.curl, CURL)
      gl.uniform1f(vorticity.uniforms.dt, dt)
      blit(velocityDFBO.write.fbo)
      velocityDFBO.swap()
  
      gl.useProgram(divergence.program)
      gl.uniform2f(divergence.uniforms.texelSize, 1.0 / simSize[0], 1.0 / simSize[1])
      gl.uniform1i(divergence.uniforms.uVelocity, velocityDFBO.read.attach(0))
      blit(divergenceFBO.fbo)
  
      gl.useProgram(clear.program)
      gl.uniform1i(clear.uniforms.uTexture, pressureDFBO.read.attach(0))
      gl.uniform1f(clear.uniforms.value, PRESSURE_DISSIPATION)
      blit(pressureDFBO.write.fbo)
      pressureDFBO.swap()
  
      gl.useProgram(pressure.program)
      gl.uniform2f(pressure.uniforms.texelSize, 1.0 / simSize[0], 1.0 / simSize[1])
      gl.uniform1i(pressure.uniforms.uDivergence, divergenceFBO.attach(0))
      
      for (let i = 0; i < PRESSURE_ITERATIONS; i++) {
        gl.uniform1i(pressure.uniforms.uPressure, pressureDFBO.read.attach(1))
        blit(pressureDFBO.write.fbo)
        pressureDFBO.swap()
      }
  
      gl.useProgram(gradient.program)
      gl.uniform2f(gradient.uniforms.texelSize, 1.0 / simSize[0], 1.0 / simSize[1])
      gl.uniform1i(gradient.uniforms.uPressure, pressureDFBO.read.attach(0))
      gl.uniform1i(gradient.uniforms.uVelocity, velocityDFBO.read.attach(1))
      blit(velocityDFBO.write.fbo)
      velocityDFBO.swap()
  
      gl.useProgram(advection.program)
      gl.uniform2f(advection.uniforms.texelSize, 1.0 / simSize[0], 1.0 / simSize[1])
      
      if (!hasLinear) {
        gl.uniform2f(advection.uniforms.dyeTexelSize, 1.0 / simSize[0], 1.0 / simSize[1])
      }
      
      const velocityId = velocityDFBO.read.attach(0)
      gl.uniform1i(advection.uniforms.uVelocity, velocityId)
      gl.uniform1i(advection.uniforms.uSource, velocityId)
      gl.uniform1f(advection.uniforms.dt, dt)
      gl.uniform1f(advection.uniforms.dissipation, VELOCITY_DISSIPATION)
      blit(velocityDFBO.write.fbo)
      velocityDFBO.swap()
  
      gl.viewport(0, 0, ...dyeSize)
  
      if (!hasLinear) {
        gl.uniform2f(advection.uniforms.dyeTexelSize, 1.0 / dyeSize[0], 1.0 / dyeSize[1])
      }

      gl.uniform1i(advection.uniforms.uVelocity, velocityDFBO.read.attach(0))
      gl.uniform1i(advection.uniforms.uSource, densityDFBO.read.attach(1))
      gl.uniform1f(advection.uniforms.dissipation, DENSITY_DISSIPATION)
      blit(densityDFBO.write.fbo)
      densityDFBO.swap()
    }

    function render (target) {
      if (target == null) {
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
        gl.enable(gl.BLEND)
      } else {
        gl.disable(gl.BLEND)
      }
  
      const w = target == null ? width : dyeSize[0]
      const h = target == null ? height : dyeSize[1]
  
      gl.viewport(0, 0, w, h)
  
      gl.useProgram(color.program)
      gl.uniform4f(color.uniforms.color, 0, 0, 0, 1)
      blit(target)
  
      if (target == null) {
        gl.useProgram(background.program)
        blit(null)
      }
  
      gl.useProgram(displayShading.program)
      gl.uniform2f(displayShading.uniforms.texelSize, 1.0 / w, 1.0 / h)
      gl.uniform1i(displayShading.uniforms.uTexture, densityDFBO.read.attach(0))

      blit(target)
    }

    function updateSplat(x, y, dx, dy, splatRGB) {
      gl.viewport(0, 0, ...simSize)

      gl.useProgram(splat.program)
      gl.uniform1i(splat.uniforms.uTarget, velocityDFBO.read.attach(0))
      gl.uniform1f(splat.uniforms.aspectRatio, width / height)
      gl.uniform2f(splat.uniforms.point, x / width, 1.0 - y / height)
      gl.uniform3f(splat.uniforms.color, dx, -dy, 1.0)
      gl.uniform1f(splat.uniforms.radius, SPLAT_RADIUS / 100.0)
      blit(velocityDFBO.write.fbo)
      velocityDFBO.swap()

      gl.viewport(0, 0, ...dyeSize)
      gl.uniform1i(splat.uniforms.uTarget, densityDFBO.read.attach(0))
      gl.uniform3f(splat.uniforms.color, splatRGB.r, splatRGB.g, splatRGB.b)
      blit(densityDFBO.write.fbo)
      densityDFBO.swap()

      console.log(dx, dy) // eslint-disable-line
    }

    function input() {
      for (let i = 0; i < pointers.length; i++) {
        const p = pointers[i]

        if (p.moved) {
          updateSplat(p.x, p.y, p.dx, p.dy, p.color)
          p.moved = false
        }
      }
    }

    const timerLoop = timer(() => {
      input()
      step(0.016)
      render(null)
    })

    return () => timerLoop.stop()
  }, [gl, hasLinear, simSize, dyeSize, pointers, width, height, splat, color, curl, clear, pressure, vorticity, divergence, background, displayShading, gradient, advection, divergenceFBO, curlFBO, pressureDFBO, velocityDFBO, densityDFBO])
}