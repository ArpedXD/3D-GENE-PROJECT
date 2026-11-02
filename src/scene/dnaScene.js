import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { createWorld } from '../explorer/structures.js'
import { CAMERA_KEYS, ANT_ORIGIN, EARTH_ORIGIN, EARTH_RADIUS } from './cameraKeys.js'

const BG_DNA = new THREE.Color(0x040716)
const BG_ANT = new THREE.Color(0x070504)
const HELIX_LENGTH = 12 // the helix is scaled so its long axis spans this many world units
const HELIX_NM_DIAMETER = 2 // real DNA is ~2 nm wide; the scale bar is calibrated to this
const ANT_LENGTH = 5.2 // world units, head to antenna tip
const ANT_SOURCE = { length: 1835, centre: [-33, 0, 277] } // measured from ant.glb, in its own units
const LEAF_SCALE = 25 // the leaves file is ~0.4 units across; scaled up to ant-sized drama

// Forest (forest.glb, "a forest with a road at night"): the source is a ~10 x 10 unit woodland block with a road down the
// middle, trees 1-2.5 units tall. At scale 30 the block is ~290 units wide and the trees 40-75 units tall, against a 5-unit ant.
const FOREST_SCALE = 30
const FOREST_SOURCE = {
  centre: [-0.04, 0.1, 0.45], // middle of the road, in the file's own units: this point is stood on the ant's origin
  minX: -5.4, // a few stray props sit in a line far off the left edge of the terrain; anything left of this is dropped
}
const FOREST_SINK = 1.5 // world units the road sits below the ant's soil, so the soil disc never z-fights with it
const FOREST_GLOW = 0.28 // emissive share of the texture, so the night foliage never goes pure black
const FOREST_MOON_INTENSITY = 2.4
const FOREST_HEMI_INTENSITY = 0.9

// Forest edge clouds: the wood is a hard-edged block, so a ring of soft cloud banks and a low mist is wrapped around its
// perimeter. They hide the cut-off from every camera angle and fade in and out with the forest.
const CLOUD_COUNT = 64 // cloud puffs around the perimeter. Each is a screen-sized see-through quad, so every extra puff is a whole layer of overdraw: fewer, still overlapping, is the biggest frame-rate win
const MIST_COUNT = 44 // low mist puffs, same reasoning. The perimeter is ~1,160 units, so 44 puffs 110+ wide still overlap 4x or more and leave no gap
const CLOUD_SIZE = 110 // world units: average puff width
const CLOUD_DEPTH = 60 // world units: how far the bank is spread across the edge (some inside, most outside)
const CLOUD_OPACITY = 0.55
const MIST_OPACITY = 0.5
const CLOUD_COLOR = 0x7388ad // cool moonlit grey-blue, to match the night wood
const MIST_COLOR = 0x5a6c8f

// DNA-world lighting: the same warm-key / cool-rim contrast that makes the ant scene read well.
const DNA_KEY_INTENSITY = 2.2
const DNA_RIM_INTENSITY = 3.0
const DNA_DUST_OPACITY = 0.15
const BLOOM_THRESHOLD_DNA = 0.42 // was 0.2: at 0.2 nearly everything glowed and the helix went soft

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v))
const lerp = (a, b, t) => a + (b - a) * t
const smoother = (t) => t * t * t * (t * (t * 6 - 15) + 10)
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3)

/** Stars on a unit sphere. The frame loop centres them on the camera and scales them to just inside the far plane, so they never parallax. */
function buildStars(count = 2600) {
  const pos = new Float32Array(count * 3)
  const col = new Float32Array(count * 3)
  let s = 20261022
  const rand = () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  for (let i = 0; i < count; i++) {
    const u = rand() * 2 - 1
    const a = rand() * Math.PI * 2
    const r = Math.sqrt(1 - u * u)
    pos.set([r * Math.cos(a), u, r * Math.sin(a)], i * 3)
    const b = 0.3 + 0.7 * Math.pow(rand(), 3) // mostly dim, a few bright
    const warm = rand()
    col.set([b * (0.82 + 0.18 * warm), b * 0.92, b * (1 - 0.2 * warm)], i * 3)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
  const mat = new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, fog: false })
  const points = new THREE.Points(geo, mat)
  points.frustumCulled = false
  points.renderOrder = -1
  points.visible = false
  return points
}

/**
 * A thin blue rim of air around the planet: a slightly larger back-faced sphere, additive, brightest at the limb and on the sunlit side.
 * Seen from outside, only the ring between the planet's edge and the shell's edge is visible (the planet hides the rest), and in that ring
 * the view angle never exceeds about 0.22 whatever the distance, which is what the 0.22 below is tuned to.
 */
function buildAtmosphere(sunDir) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uAmount: { value: 0 }, uSun: { value: sunDir.clone().normalize() }, uColor: { value: new THREE.Color(0.3, 0.58, 1.0) } },
    vertexShader: `
      varying vec3 vN;
      varying vec3 vW;
      void main() {
        vN = normalize(mat3(modelMatrix) * normal);
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: `
      uniform float uAmount;
      uniform vec3 uSun;
      uniform vec3 uColor;
      varying vec3 vN;
      varying vec3 vW;
      void main() {
        vec3 n = normalize(vN);
        vec3 v = normalize(cameraPosition - vW);
        float rim = pow(clamp(1.0 - abs(dot(n, v)) / 0.22, 0.0, 1.0), 1.6);
        float lit = 0.3 + 0.7 * smoothstep(-0.3, 0.6, dot(n, uSun));
        gl_FragColor = vec4(uColor * rim * lit * 0.85 * uAmount, 1.0);
      }`,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    fog: false,
  })
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(EARTH_RADIUS * 1.025, 96, 64), mat)
  mesh.position.set(...EARTH_ORIGIN)
  mesh.frustumCulled = false
  mesh.visible = false
  return mesh
}

/** The explorer's procedural helix plus its clickable structures, standing in for the old dna.glb. */
function buildExplorerRig(world) {
  const rig = new THREE.Group()
  const holder = new THREE.Group()
  holder.rotation.z = -Math.PI / 2 // explorer helix is vertical; this one lies along X
  holder.scale.setScalar(HELIX_LENGTH / 8)
  rig.add(holder)
  holder.add(world.helix.group)
  world.items.forEach((it) => {
    it.group.scale.setScalar(1.7) // bigger targets, easier to click from the wide hero shot
    holder.add(it.group)
  })
  const mats = new Set()
  rig.traverse((o) => {
    if (!o.material) return
    ;[].concat(o.material).forEach((m) => {
      if (m.visible === false) return
      m._o = m.opacity
      m._t = m.transparent
      mats.add(m)
    })
  })
  let last = -1
  return {
    rig,
    radius: 1.2 * (HELIX_LENGTH / 8),
    helixMaterial: { dispose() {} },
    items: world.items,
    setFade(d) {
      rig.visible = d > 0.003
      if (d === last) return
      last = d
      mats.forEach((m) => {
        m.transparent = m._t || d < 0.999
        m.opacity = m._o * d
      })
    },
    tick(t) {
      world.items.forEach((it) => {
        const a = it.a + t * it.orbit
        it.group.position.set(Math.cos(a) * it.radius, it.height + Math.sin(t * 0.5 + it.sway) * 0.25, Math.sin(a) * it.radius)
        it.group.rotation.y += 0.004 * it.spin
      })
    },
  }
}

/** A speckled, dark soil texture made on the fly, so the ant has a floor without another download. */
function makeSoilTexture() {
  const size = 512
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')
  g.fillStyle = '#1b1510'
  g.fillRect(0, 0, size, size)
  for (let i = 0; i < 9000; i++) {
    const v = 20 + Math.random() * 48
    g.fillStyle = `rgba(${v + 18},${v + 8},${v - 4},${0.15 + Math.random() * 0.4})`
    const r = Math.random() * 2.2 + 0.4
    g.beginPath()
    g.arc(Math.random() * size, Math.random() * size, r, 0, Math.PI * 2)
    g.fill()
  }
  const tex = new THREE.CanvasTexture(c)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(14, 14)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  return tex
}

/** 1-2-5 series, so the scale bar always lands on a number a person would write. */
function niceValue(target) {
  const exp = Math.floor(Math.log10(target))
  const base = Math.pow(10, exp)
  const f = target / base
  const m = f >= 5 ? 5 : f >= 2 ? 2 : 1
  return m * base
}

function formatLength(nm) {
  if (nm >= 1) return `${+nm.toPrecision(2)} nm`
  return `${+(nm * 10).toPrecision(2)} Å`
}

export function createDnaScene({ canvas, modelUrls, getStops, onLoadProgress, onReady, onError, onScale, onInspect }) {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  let disposed = false

  // ───────────────────────────── renderer, scene, post
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75))
  renderer.toneMapping = THREE.NoToneMapping
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap

  const scene = new THREE.Scene()
  scene.background = BG_DNA.clone()
  scene.fog = new THREE.FogExp2(BG_DNA.clone(), 0.034)

  const pmrem = new THREE.PMREMGenerator(renderer)
  const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  scene.environment = envTexture
  scene.environmentIntensity = 0.35

  const camera = new THREE.PerspectiveCamera(38, 1, 0.03, 700)
  // MSAA on the post-processing target, otherwise thin ant legs and leaf edges shimmer.
  const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 })
  const composer = new EffectComposer(renderer, target)
  composer.addPass(new RenderPass(scene, camera))
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.6, 0.5, BLOOM_THRESHOLD_DNA)
  composer.addPass(bloom)
  composer.addPass(new OutputPass())

  // The night sky: fades in with the planet, once the camera has climbed out of the ant's world.
  const stars = buildStars()
  scene.add(stars)

  // ───────────────────────────── state
  let dnaInfo = null
  let dnaLights = [] // [warm key, cool rim]: fade out with the helix
  let dust = null // drifting motes around the helix
  let earthInfo = null // { sun }
  let earth = null // the earth.glb planet: { group, update(dt, amount) }
  let forest = null // the forest.glb wood: { group, mats, update(amount) }
  let forestLights = [] // [moon, hemisphere]: fade in and out with the forest
  let forestClouds = null // the cloud bank around the forest edge: { update(amount, time), dispose() }
  let ant = null // { group, rig, antMixer, leafMixers, materials, spot, hemi, ground, leafGroups, soilMats }
  let aspect = 1
  let width = 1
  let height = 1
  let stops = []
  let scrollTarget = 0
  let scrollP = 0
  let introT = reduceMotion ? 1 : 0
  let started = false

  const spinBase = { angle: 0 }
  const dragQuat = new THREE.Quaternion()
  const spinQuat = new THREE.Quaternion()
  const tmpQuat = new THREE.Quaternion()
  const AXIS_X = new THREE.Vector3(1, 0, 0)
  const AXIS_Y = new THREE.Vector3(0, 1, 0)
  const pointer = { x: 0, y: 0, sx: 0, sy: 0 }
  const drag = { active: false, id: null, lastX: 0, lastY: 0, vx: 0, vy: 0, idle: 0 }

  // ───────────────────────────── sizing + scroll
  function measureStops() {
    const total = Math.max(1, document.documentElement.scrollHeight - window.innerHeight)
    stops = getStops().map((el) => {
      const r = el.getBoundingClientRect()
      const centre = r.top + window.scrollY + r.height / 2
      return clamp((centre - window.innerHeight / 2) / total)
    })
  }

  function resize() {
    width = window.innerWidth
    height = window.innerHeight
    aspect = width / height
    renderer.setSize(width, height, false)
    composer.setSize(width, height)
    camera.aspect = aspect
    camera.updateProjectionMatrix()
    measureStops()
    onScroll()
  }

  function onScroll() {
    const total = Math.max(1, document.documentElement.scrollHeight - window.innerHeight)
    scrollTarget = clamp(window.scrollY / total)
  }

  // ───────────────────────────── drag to turn the helix (and the ant)
  function onPointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return
    drag.active = true
    drag.id = e.pointerId
    drag.lastX = e.clientX
    drag.lastY = e.clientY
    drag.vx = drag.vy = 0
    drag.idle = 0
    canvas.setPointerCapture?.(e.pointerId)
    canvas.classList.add('is-dragging')
  }

  function onPointerMove(e) {
    pointer.x = (e.clientX / width) * 2 - 1
    pointer.y = (e.clientY / height) * 2 - 1
    if (!drag.active || e.pointerId !== drag.id) return
    const dx = e.clientX - drag.lastX
    // Touch scrolls the page vertically, so only mouse and pen get the second axis.
    const dy = e.pointerType === 'touch' ? 0 : e.clientY - drag.lastY
    drag.lastX = e.clientX
    drag.lastY = e.clientY
    drag.vx = dx * 0.006
    drag.vy = dy * 0.006
    applyDrag(drag.vx, drag.vy)
    drag.idle = 0
  }

  function onPointerUp(e) {
    if (e.pointerId !== drag.id) return
    drag.active = false
    canvas.releasePointerCapture?.(e.pointerId)
    canvas.classList.remove('is-dragging')
  }

  function applyDrag(yaw, pitch) {
    tmpQuat.setFromAxisAngle(AXIS_Y, yaw)
    dragQuat.premultiply(tmpQuat)
    spinBase.angle += pitch // vertical drag spins the helix about its own axis
  }

  function onKeyDown(e) {
    const step = 0.12
    if (e.key === 'ArrowLeft') drag.vx -= step
    else if (e.key === 'ArrowRight') drag.vx += step
    else if (e.key === 'ArrowUp') spinBase.angle -= step
    else if (e.key === 'ArrowDown') spinBase.angle += step
    else return
    drag.idle = 0
    e.preventDefault()
  }

  // ───────────────────────────── camera + scene phases
  const keyPos = new THREE.Vector3()
  const keyLook = new THREE.Vector3()
  const forward = new THREE.Vector3()
  const right = new THREE.Vector3()
  const up = new THREE.Vector3()
  const pullBack = new THREE.Vector3()
  const closest = new THREE.Vector3()
  const dnaCentre = new THREE.Vector3()
  // soil: 1 = the lamp-lit ground disc and the falling leaves are there, 0 = gone. The last zoom-out fades them
  // so the ant is left standing on the planet's north pole instead of on a flat plate.
  const phase = { dna: 1, ant: 0, world: 0, earth: 0, forest: 0, soil: 1 }
  let lastSoil = -1

  function curved(B, name, t) {
    const c = B.curve?.[name]
    if (!c) return smoother(t)
    return smoother(clamp((t - c[0]) / (c[1] - c[0])))
  }

  function sampleKeys(p) {
    const n = Math.min(stops.length, CAMERA_KEYS.length)
    if (n === 0 || p <= stops[0]) return { A: CAMERA_KEYS[0], B: CAMERA_KEYS[0], t: 0 }
    if (p >= stops[n - 1]) return { A: CAMERA_KEYS[n - 1], B: CAMERA_KEYS[n - 1], t: 0 }
    let i = 0
    while (i < n - 2 && p > stops[i + 1]) i++
    const span = Math.max(1e-5, stops[i + 1] - stops[i])
    return { A: CAMERA_KEYS[i], B: CAMERA_KEYS[i + 1], t: clamp((p - stops[i]) / span) }
  }

  function updateCamera(dt) {
    const portrait = aspect < 1
    const fit = aspect < 1.25 ? lerp(1, 2.1, clamp((1.25 - aspect) / 0.8)) : 1
    const { A, B, t } = sampleKeys(scrollP)

    phase.dna = lerp(A.dna, B.dna, curved(B, 'dna', t))
    phase.ant = lerp(A.ant, B.ant, curved(B, 'ant', t))
    phase.earth = lerp(A.earth ?? 0, B.earth ?? 0, curved(B, 'earth', t))
    phase.forest = lerp(A.forest ?? 0, B.forest ?? 0, curved(B, 'forest', t))
    phase.world = lerp(A.world, B.world, curved(B, 'world', t))
    phase.soil = lerp(A.soil ?? 1, B.soil ?? 1, curved(B, 'soil', t))

    // A "cut" hides the long flight between the two worlds: the screen is black, so jump.
    const pose = B.cut ? (t < 0.5 ? A : B) : null
    const tp = pose ? 0 : lerp(t, smoother(t), B.ease ?? 1) // ease < 1 lets pass-through beats keep some speed instead of stopping dead

    const P = pose ?? A
    const Q = pose ?? B
    keyPos.set(lerp(P.pos[0], Q.pos[0], tp), lerp(P.pos[1], Q.pos[1], tp), lerp(P.pos[2], Q.pos[2], tp))
    keyLook.set(lerp(P.look[0], Q.look[0], tp), lerp(P.look[1], Q.look[1], tp), lerp(P.look[2], Q.look[2], tp))
    // A straight pull-away (both poses stacked over the same look point) rises by a constant RATIO per scroll step instead of a
    // constant distance, so the world shrinks at a steady rate all the way from the forest to the planet.
    if (B.zoom && !pose) {
      const hA = A.pos[1] - A.look[1]
      const hB = B.pos[1] - B.look[1]
      keyPos.y = keyLook.y + hA * Math.pow(hB / hA, tp)
    }
    const roll = lerp(P.roll, Q.roll, tp)
    const sa = portrait ? P.shiftPortrait : P.shift
    const sb = portrait ? Q.shiftPortrait : Q.shift
    const sx = lerp(sa[0], sb[0], tp)
    const sy = lerp(sa[1], sb[1], tp)

    // Portrait screens need to sit further back to fit the same subject.
    pullBack.copy(keyPos).sub(keyLook)
    keyPos.copy(keyLook).addScaledVector(pullBack, fit)

    // One-time arrival: start far back and settle onto the first view.
    const intro = 1 - easeOutCubic(clamp(introT))
    if (intro > 0) keyPos.addScaledVector(pullBack.normalize(), intro * 9)

    // Pointer parallax: a little sway sells the depth between the foreground and the subject.
    pointer.sx = lerp(pointer.sx, pointer.x, 1 - Math.exp(-dt * 2.5))
    pointer.sy = lerp(pointer.sy, pointer.y, 1 - Math.exp(-dt * 2.5))
    forward.copy(keyLook).sub(keyPos).normalize()
    right.crossVectors(forward, AXIS_Y).normalize()
    up.crossVectors(right, forward).normalize()
    const sway = 0.16 * Math.min(1, pullBack.length() * 0.2 + 0.35)
    keyPos.addScaledVector(right, pointer.sx * sway).addScaledVector(up, -pointer.sy * sway * 0.7)

    // The zoom-out leaves the ant thousands of units behind. Past 100 units from the ant, push the near plane out
    // (and the far plane past the planet's far side) so depth precision survives. Closer in, nothing changes.
    const dAnt = Math.hypot(keyPos.x - ANT_ORIGIN[0], keyPos.y - ANT_ORIGIN[1], keyPos.z - ANT_ORIGIN[2])
    camera.near = Math.max(0.03, (dAnt - 100) * 0.004)
    // The forest is ~290 units across; once the camera is far above it, extend the far plane like the planet does.
    const needFar = phase.earth > 0.003 || (phase.forest > 0.003 && dAnt > 350)
    camera.far = needFar ? (dAnt + 2 * EARTH_RADIUS) * 1.2 + 700 : 700

    camera.position.copy(keyPos)
    camera.up.set(0, 1, 0)
    camera.lookAt(keyLook)
    camera.rotateZ(roll)
    camera.setViewOffset(width, height, -sx * width, sy * height, width, height)
  }

  /** Dims the helix, lights the ant, and recolours the room to match. */
  function applyPhase(time) {
    const w = phase.world
    scene.background.copy(BG_DNA).lerp(BG_ANT, w)
    scene.fog.color.copy(scene.background)
    // Thinner fog over the forest, otherwise the far trees vanish into the dark before the camera can see the wood.
    scene.fog.density = lerp(0.034, 0.016, w) * (1 - phase.earth) * (1 - 0.92 * phase.forest)
    bloom.strength = lerp(0.6, 0.32, w)
    bloom.threshold = lerp(BLOOM_THRESHOLD_DNA, 0.62, w)

    if (dnaInfo) {
      const d = phase.dna
      dnaInfo.setFade(d)
      if (dnaLights.length) {
        dnaLights[0].intensity = DNA_KEY_INTENSITY * d
        dnaLights[1].intensity = DNA_RIM_INTENSITY * d
      }
      if (dust) {
        dust.visible = d > 0.003
        dust.material.opacity = DNA_DUST_OPACITY * d
      }
    }

    if (ant) {
      const k = phase.ant
      // A lamp warming up: a few uneven flickers on the way up, then steady.
      const flicker = k < 0.98 ? 1 - 0.4 * Math.max(0, Math.sin(k * 61) * Math.sin(k * 29)) * (1 - k) : 1
      const L = k * flicker
      ant.group.visible = k > 0.002
      ant.spot.intensity = L * 7.5
      ant.hemi.intensity = L * 0.35
      ant.materials.forEach((m) => {
        m.envMapIntensity = L * m.userData.envBase
        if (m.userData.emissiveBase !== undefined) m.emissiveIntensity = L * m.userData.emissiveBase
      })

      // The ground disc and the leaves dissolve during the final zoom-out, uncovering the planet beneath the ant.
      const s = phase.soil
      const soilOn = s > 0.003
      ant.ground.visible = soilOn
      ant.leafGroups.forEach((g) => (g.visible = soilOn))
      if (soilOn && s !== lastSoil) {
        ant.soilMats.forEach((m) => {
          m.transparent = s < 0.999
          m.opacity = s
        })
      }
      lastSoil = s
    }
  }

  // ───────────────────────────── scale bar
  let lastBarPx = -1
  let lastLabel = ''
  let lastOpacity = -1
  function updateScale() {
    if (!dnaInfo) return
    dnaCentre.set(0, 0, 0)
    const cx = clamp(camera.position.x, -HELIX_LENGTH / 2, HELIX_LENGTH / 2)
    closest.set(cx, 0, 0)
    const depth = Math.max(dnaInfo.radius, camera.position.distanceTo(closest))
    const worldPerPx = (2 * depth * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / height
    const nmPerWorld = HELIX_NM_DIAMETER / (dnaInfo.radius * 2)
    const nmPerPx = worldPerPx * nmPerWorld
    const targetNm = nmPerPx * Math.min(150, Math.max(90, width * 0.14))
    const nice = niceValue(targetNm)
    const px = Math.round(nice / nmPerPx)
    const label = formatLength(nice)
    const opacity = +(phase.dna * clamp(introT * 2)).toFixed(2)
    if (px !== lastBarPx || label !== lastLabel || opacity !== lastOpacity) {
      lastBarPx = px
      lastLabel = label
      lastOpacity = opacity
      onScale?.({ px, label, opacity })
    }
  }

  // ───────────────────────────── frame loop
  const clock = new THREE.Clock()
  let raf = 0
  let lastP = 0

  function frame() {
    raf = requestAnimationFrame(frame)
    const dt = Math.min(clock.getDelta(), 0.05)
    const time = clock.elapsedTime
    if (!dnaInfo) return

    if (started && introT < 1) introT = Math.min(1, introT + dt / 2.8)

    scrollP += (scrollTarget - scrollP) * (1 - Math.exp(-dt * (reduceMotion ? 12 : 4.5)))
    const dp = scrollP - lastP
    lastP = scrollP

    if (!drag.active) {
      applyDrag(drag.vx, 0)
      drag.vx *= Math.exp(-dt * 3.2)
      drag.idle += dt
      if (drag.idle > 2.2) dragQuat.slerp(tmpQuat.identity(), 1 - Math.exp(-dt * 0.9))
    }

    const idleSpin = reduceMotion ? 0.02 : 0.16 + (1 - easeOutCubic(clamp(introT))) * 1.4
    spinBase.angle += idleSpin * dt + dp * 9
    spinQuat.setFromAxisAngle(AXIS_X, spinBase.angle)
    dnaInfo.rig.quaternion.copy(dragQuat).multiply(spinQuat)
    dnaInfo.tick(performance.now() / 1000)
    if (dust && !reduceMotion) dust.rotation.y += dt * 0.02
    if (earthInfo) {
      earthInfo.sun.intensity = 1.5 * phase.earth
      earth?.update(dt, phase.earth)
    }
    if (forestLights.length) {
      forestLights[0].intensity = FOREST_MOON_INTENSITY * phase.forest
      forestLights[1].intensity = FOREST_HEMI_INTENSITY * phase.forest
    }
    forest?.update(phase.forest)
    forestClouds?.update(phase.forest, time)
    if (ant) ant.group.visible = phase.ant > 0.003

    updateCamera(dt)
    applyPhase(time)

    // Stars ride with the camera (centred on it, just inside the far plane) and fade in with the planet.
    stars.visible = phase.earth > 0.003
    if (stars.visible) {
      stars.position.copy(camera.position)
      stars.scale.setScalar(camera.far * 0.85)
      stars.material.opacity = 0.9 * smoother(phase.earth)
    }

    if (ant && ant.group.visible) {
      ant.rig.quaternion.copy(dragQuat) // dragging turns the ant too
      const step = reduceMotion ? 0 : dt
      ant.antMixer.update(step)
      ant.leafMixers.forEach((m) => m.update(step))
    }

    updateScale()
    composer.render()
  }

  // ───────────────────────────── ant, ground, leaves (loaded after the helix is on screen)
  const loader = new GLTFLoader()
  const load = (url) => new Promise((res, rej) => loader.load(url, res, undefined, rej))


  /** The Sketchfab planet (earth.glb): sized to EARTH_RADIUS, sitting at EARTH_ORIGIN, faded in and out by `amount`. */
  function buildEarth(gltf) {
    const model = gltf.scene
    const box = new THREE.Box3().setFromObject(model)
    const size = box.getSize(new THREE.Vector3())
    model.position.sub(box.getCenter(new THREE.Vector3()))
    const group = new THREE.Group()
    group.add(model)
    // The scale that makes the model exactly EARTH_RADIUS in radius.
    const fit = (EARTH_RADIUS * 2) / Math.max(size.x, size.y, size.z)
    group.scale.setScalar(fit)
    group.position.set(...EARTH_ORIGIN)
    group.rotation.set(0.35, 0, -0.2) // axial tilt; tweak if the poles face the camera
    group.visible = false
    const mats = new Set()
    model.traverse((o) => {
      if (!o.material) return
      ;[].concat(o.material).forEach((m) => {
        m._o = m.opacity
        m._t = m.transparent
        m._e = m.emissiveIntensity ?? 1
        mats.add(m)
      })
    })
    const mixer = gltf.animations.length ? new THREE.AnimationMixer(model) : null
    gltf.animations.forEach((c) => mixer.clipAction(c).play())
    scene.add(group)
    const atmosphere = buildAtmosphere(new THREE.Vector3(90, 110, 130)) // same direction as the sun light set up in boot
    scene.add(atmosphere)

    // Warm the planet up while it is hidden (the forest already does this): upload its textures and compile its shaders now,
    // so the frame where it first fades in under the forest is not a hitch.
    model.traverse((o) => {
      if (!o.material) return
      ;[].concat(o.material).forEach((m) => Object.values(m).forEach((v) => v && v.isTexture && renderer.initTexture(v)))
    })
    group.visible = true
    atmosphere.visible = true
    renderer.compile(scene, camera)
    group.visible = false
    atmosphere.visible = false

    let lastD = -1
    earth = {
      group,
      update(dt, d) {
        group.visible = d > 0.003
        atmosphere.visible = group.visible
        atmosphere.material.uniforms.uAmount.value = d
        if (!group.visible) return
        if (mixer) mixer.update(reduceMotion ? 0 : dt)
        else model.rotation.y += reduceMotion ? 0 : dt * 0.03
        if (d === lastD) return // the fade has settled: no need to rewrite every material every frame
        lastD = d
        mats.forEach((m) => {
          m.transparent = m._t || d < 0.999
          m.opacity = m._o * d
          if ('emissiveIntensity' in m) m.emissiveIntensity = m._e * d
        })
      },
    }
  }

  /**
   * forest.glb: about 1,480 separate meshes sharing three materials. They are baked into ONE mesh per material (three
   * draw calls instead of 1,480), scaled by FOREST_SCALE and stood on the ant's origin so the ant is on the forest's road.
   * It is faded in and out by `amount`, like the planet. Not drawn at all while amount is 0.
   */
  function buildForest(gltf) {
    const model = gltf.scene
    model.updateMatrixWorld(true)
    const buckets = new Map() // material -> geometries, already in the file's world space
    const centre = new THREE.Vector3()
    model.traverse((o) => {
      if (!o.isMesh) return
      const g = o.geometry.clone()
      g.applyMatrix4(o.matrixWorld)
      g.computeBoundingBox()
      g.boundingBox.getCenter(centre)
      if (centre.x < FOREST_SOURCE.minX) {
        g.dispose()
        return
      }
      // Only position / normal / uv survive, so every geometry in a bucket has identical attributes and can merge.
      Object.keys(g.attributes).forEach((n) => {
        if (n !== 'position' && n !== 'normal' && n !== 'uv') g.deleteAttribute(n)
      })
      if (!g.attributes.normal) g.computeVertexNormals()
      if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2))
      const list = buckets.get(o.material) ?? []
      list.push(g)
      buckets.set(o.material, list)
    })

    const group = new THREE.Group()
    const mats = new Set()
    buckets.forEach((geoms, m) => {
      const allIndexed = geoms.every((g) => g.index)
      const parts = allIndexed ? geoms : geoms.map((g) => (g.index ? g.toNonIndexed() : g))
      const merged = mergeGeometries(parts, false)
      if (!merged) {
        console.error('forest: could not merge a material bucket')
        return
      }
      m.side = THREE.DoubleSide
      m.metalness = 0
      if (m.transparent) {
        // The leaf cards use alpha blending in the file. Cut-outs sort and fade far better with 1,400 overlapping cards.
        m.transparent = false
        m.alphaTest = 0.4
        m.depthWrite = true
      }
      if (m.map) {
        m.map.anisotropy = 4
        m.emissive = new THREE.Color(0xffffff)
        m.emissiveMap = m.map
        m.emissiveIntensity = FOREST_GLOW
      }
      m.needsUpdate = true
      m._o = m.opacity
      m._t = m.transparent
      mats.add(m)
      const mesh = new THREE.Mesh(merged, m)
      mesh.frustumCulled = false // one mesh spans the whole wood
      group.add(mesh)
      ;[m.map, m.normalMap].forEach((tex) => tex && renderer.initTexture(tex)) // upload now, not on the first frame it is seen
    })

    group.scale.setScalar(FOREST_SCALE)
    group.position.set(
      ANT_ORIGIN[0] - FOREST_SOURCE.centre[0] * FOREST_SCALE,
      ANT_ORIGIN[1] - FOREST_SOURCE.centre[1] * FOREST_SCALE - FOREST_SINK,
      ANT_ORIGIN[2] - FOREST_SOURCE.centre[2] * FOREST_SCALE,
    )
    scene.add(group)
    buildForestClouds(group)
    // Compile its shaders while it is hidden from the story, so it does not hitch the first time it fades in.
    group.visible = true
    renderer.compile(scene, camera)
    group.visible = false

    let last = -1
    forest = {
      group,
      mats,
      update(d) {
        group.visible = d > 0.003
        if (!group.visible || d === last) return
        last = d
        mats.forEach((m) => {
          m.transparent = m._t || d < 0.999
          m.opacity = m._o * d
        })
      },
    }
  }

  /**
   * Soft cloud banks and a low mist around the edge of the wood, so the block never ends in a visible cut.
   * Sprites with canvas-drawn puffs (no extra download), unlit and fogless so they stay a cool moonlit grey.
   * Placed from the forest's real bounding box, so they follow the block however the file is scaled.
   */
  function buildForestClouds(forestGroup) {
    forestGroup.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(forestGroup)
    const size = box.getSize(new THREE.Vector3())
    const groundY = box.min.y
    const treeH = Math.max(20, size.y)

    // Seeded, so the clouds sit in the same places on every load.
    let seed = 1337
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }

    // A cluster of overlapping radial gradients. spread + radius stay inside the canvas so no puff has a clipped edge.
    const makePuff = (blobs, spreadX, spreadY, rMin, rMax) => {
      const s = 256
      const c = document.createElement('canvas')
      c.width = c.height = s
      const g = c.getContext('2d')
      for (let i = 0; i < blobs; i++) {
        const x = s / 2 + (rand() - 0.5) * s * spreadX
        const y = s / 2 + (rand() - 0.5) * s * spreadY
        const r = s * (rMin + rand() * (rMax - rMin))
        const grad = g.createRadialGradient(x, y, 0, x, y, r)
        grad.addColorStop(0, 'rgba(255,255,255,0.5)')
        grad.addColorStop(0.55, 'rgba(255,255,255,0.2)')
        grad.addColorStop(1, 'rgba(255,255,255,0)')
        g.fillStyle = grad
        g.fillRect(0, 0, s, s)
      }
      const tex = new THREE.CanvasTexture(c)
      tex.colorSpace = THREE.SRGBColorSpace
      return tex
    }
    const makeMat = (tex, color, base) => {
      const m = new THREE.SpriteMaterial({ map: tex, color, transparent: true, opacity: 0, depthWrite: false, fog: false })
      m._base = base
      return m
    }
    const cloudMats = [0, 1, 2].map(() => makeMat(makePuff(14, 0.44, 0.36, 0.14, 0.26), CLOUD_COLOR, CLOUD_OPACITY))
    const mistMat = makeMat(makePuff(10, 0.6, 0.2, 0.1, 0.2), MIST_COLOR, MIST_OPACITY)
    const mats = [...cloudMats, mistMat]

    const root = new THREE.Group()
    root.visible = false
    const sprites = []
    const perim = 2 * (size.x + size.z)

    // Walks the rectangle's outline: a point on the edge, the outward normal, and the direction along the edge.
    const onEdge = (s) => {
      if (s < size.x) return { x: box.min.x + s, z: box.min.z, nx: 0, nz: -1, tx: 1, tz: 0 }
      s -= size.x
      if (s < size.z) return { x: box.max.x, z: box.min.z + s, nx: 1, nz: 0, tx: 0, tz: 1 }
      s -= size.z
      if (s < size.x) return { x: box.max.x - s, z: box.max.z, nx: 0, nz: 1, tx: -1, tz: 0 }
      s -= size.x
      return { x: box.min.x, z: box.max.z - s, nx: -1, nz: 0, tx: 0, tz: -1 }
    }

    const place = (mat, i, count, lift, w, h) => {
      const e = onEdge(((i + rand() * 0.8) / count) * perim)
      const out = -CLOUD_DEPTH * 0.3 + rand() * CLOUD_DEPTH // mostly outside the wood, some tucked inside it
      const sp = new THREE.Sprite(mat)
      sp.scale.set(w, h, 1)
      sp.renderOrder = 10 // always after the trees, even while the forest itself is fading
      sp.userData = {
        x: e.x + e.nx * out,
        y: groundY + lift,
        z: e.z + e.nz * out,
        tx: e.tx,
        tz: e.tz,
        amp: 3 + rand() * 5, // gentler drift: smaller sweep, slower pace (was 6-16 and 0.03-0.08)
        bob: 0.6 + rand() * 1.4,
        speed: 0.02 + rand() * 0.03,
        phase: rand() * Math.PI * 2,
      }
      sp.position.set(sp.userData.x, sp.userData.y, sp.userData.z)
      root.add(sp)
      sprites.push(sp)
    }

    for (let i = 0; i < CLOUD_COUNT; i++) {
      // cloud banks reach from mid-trunk to just above the crowns
      const w = CLOUD_SIZE * (0.8 + rand() * 0.7)
      place(cloudMats[i % cloudMats.length], i, CLOUD_COUNT, treeH * (0.35 + rand() * 0.7), w, w * (0.55 + rand() * 0.2))
    }
    for (let i = 0; i < MIST_COUNT; i++) {
      // low mist hugging the ground, wide and flat
      const w = CLOUD_SIZE * (1 + rand() * 0.6)
      place(mistMat, i, MIST_COUNT, w * 0.12 + rand() * 10, w, w * 0.28)
    }
    scene.add(root)

    let lastD = -1
    forestClouds = {
      update(d, t) {
        root.visible = d > 0.003
        if (!root.visible) return
        if (d !== lastD) {
          lastD = d
          mats.forEach((m) => (m.opacity = m._base * d))
        }
        if (reduceMotion) return
        for (const sp of sprites) {
          const u = sp.userData
          const o = Math.sin(t * u.speed + u.phase) * u.amp // slow drift along the edge
          sp.position.set(u.x + u.tx * o, u.y + Math.sin(t * u.speed * 0.7 + u.phase) * u.bob, u.z + u.tz * o)
        }
      },
      dispose() {
        mats.forEach((m) => {
          m.map?.dispose()
          m.dispose()
        })
      },
    }
  }

  async function buildAnt(antGltf, leafGltf) {
    const group = new THREE.Group()
    group.position.set(...ANT_ORIGIN)
    group.visible = false
    scene.add(group)

    const materials = []
    const track = (m, envBase, emissiveBase) => {
      m.envMap = envTexture
      m.userData.envBase = envBase
      if (emissiveBase !== undefined) m.userData.emissiveBase = emissiveBase
      materials.push(m)
    }

    // the ant: normalised so its length is ANT_LENGTH, centred on the group origin
    const s = ANT_LENGTH / ANT_SOURCE.length
    const rig = new THREE.Group()
    rig.scale.setScalar(s)
    const inner = new THREE.Group()
    inner.position.set(-ANT_SOURCE.centre[0], 0, -ANT_SOURCE.centre[2])
    inner.add(antGltf.scene)
    rig.add(inner)
    group.add(rig)
    antGltf.scene.traverse((o) => {
      if (!o.isMesh) return
      o.frustumCulled = false
      o.castShadow = true
      o.receiveShadow = true
      track(o.material, 0.9, o.material.emissiveIntensity * 0.55)
    })
    const antMixer = new THREE.AnimationMixer(antGltf.scene)
    const action = antMixer.clipAction(antGltf.animations[0])
    action.time = 4 // start inside the walking section of the clip
    action.play()

    // soil under the lamp
    const soil = makeSoilTexture()
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(70, 64),
      new THREE.MeshStandardMaterial({ map: soil, bumpMap: soil, bumpScale: 2.2, roughness: 0.95, metalness: 0, color: 0xffffff }),
    )
    ground.rotation.x = -Math.PI / 2
    ground.position.y = -0.02
    ground.receiveShadow = true
    track(ground.material, 0.2)
    group.add(ground)

    // the lamp
    const spot = new THREE.SpotLight(0xffe2b8, 0, 0, 0.5, 1, 0)
    spot.position.set(0.8, 13, 1.2)
    spot.target.position.set(0, 0, 0)
    spot.castShadow = true
    spot.shadow.mapSize.set(2048, 2048)
    spot.shadow.bias = -0.0004
    spot.shadow.normalBias = 0.02
    spot.shadow.camera.near = 4
    spot.shadow.camera.far = 30
    const hemi = new THREE.HemisphereLight(0xffcf9a, 0x120c08, 0)
    group.add(spot, spot.target, hemi)

    // falling leaves: the user's animated file, cloned so the fall covers the whole frame
    const diffuse = await leafGltf.parser.getDependency('texture', 0)
    diffuse.colorSpace = THREE.SRGBColorSpace
    diffuse.flipY = false
    diffuse.anisotropy = 4
    const leafMixers = []
    const leafGroups = [] // hidden together with the ground when the last zoom-out uncovers the planet
    const leafMats = []
    const placements = [
      { x: 0, z: 0, ry: 0, t: 0 },
      { x: 2.4, z: -2.6, ry: 1.9, t: 3.3 },
      { x: -2.6, z: 2.2, ry: 4.1, t: 6.7 },
    ]
    placements.forEach((p) => {
      const leaves = cloneSkinned(leafGltf.scene)
      leaves.scale.setScalar(LEAF_SCALE)
      leaves.position.set(p.x - 0.1 * LEAF_SCALE, 0, p.z)
      leaves.rotation.y = p.ry
      leaves.traverse((o) => {
        if (!o.isMesh) return
        o.frustumCulled = false
        o.castShadow = true
        const m = o.material.clone() // the file uses spec-gloss, which three.js no longer reads
        m.map = diffuse
        m.alphaTest = 0.5
        m.side = THREE.DoubleSide
        m.roughness = 0.65
        m.metalness = 0
        m.emissive = new THREE.Color(0xff7a2a)
        m.emissiveMap = diffuse
        m.needsUpdate = true
        o.material = m
        track(m, 0.7, 0.18)
        leafMats.push(m)
      })
      group.add(leaves)
      leafGroups.push(leaves)
      const mixer = new THREE.AnimationMixer(leaves)
      const a = mixer.clipAction(leafGltf.animations[0])
      a.time = p.t
      a.play()
      leafMixers.push(mixer)
    })

    ant = { group, rig, antMixer, leafMixers, materials, spot, hemi, ground, leafGroups, soilMats: [ground.material, ...leafMats] }
    renderer.compile(scene, camera)
  }

  // ───────────────────────────── boot
  Promise.resolve().then(() => {
      if (disposed) return
      try {
        const world = createWorld()
        dnaInfo = buildExplorerRig(world)
        const sun = new THREE.DirectionalLight(0xfff1dd, 0)
        sun.position.set(90, EARTH_ORIGIN[1] + 110, 130)
        sun.target.position.set(...EARTH_ORIGIN)
        scene.add(sun, sun.target)
        earthInfo = { sun }
        scene.add(dnaInfo.rig)

        // Warm key from the front, cool rim from behind: contrast is what gives the helix depth.
        // Both start at 0 and are driven by phase.dna in applyPhase, so they are off in the ant world.
        const dnaKey = new THREE.DirectionalLight(0xffd2a8, 0)
        dnaKey.position.set(8, 10, 12)
        const dnaRim = new THREE.DirectionalLight(0x5fb8ff, 0)
        dnaRim.position.set(-10, 4, -12)
        scene.add(dnaKey, dnaRim)
        dnaLights = [dnaKey, dnaRim]

        // Forest lighting: a cool moon raking across the road plus a dim sky/ground fill. Both start at 0 and are
        // driven by phase.forest, so the forest is the only thing they ever light up noticeably.
        const moon = new THREE.DirectionalLight(0x9db8ff, 0)
        moon.position.set(-90, ANT_ORIGIN[1] + 160, 110)
        moon.target.position.set(...ANT_ORIGIN)
        const forestHemi = new THREE.HemisphereLight(0x8fb0e0, 0x1a2a1c, 0)
        scene.add(moon, moon.target, forestHemi)
        forestLights = [moon, forestHemi]

        // Drifting motes around the helix (built in structures.js, not previously added to the scene).
        dust = world.dust
        dust.material.opacity = DNA_DUST_OPACITY
        scene.add(dust)

        measureStops()
        onScroll()
        scrollP = scrollTarget
        lastP = scrollP
        renderer.compile(scene, camera)
        composer.render()
        started = true
        onReady?.()
        // The ant and leaves arrive in the background; the story is long enough that they are
        // ready well before anyone scrolls to the blackout.
        load(modelUrls.earth).then((g) => !disposed && buildEarth(g)).catch((err) => console.error('earth failed to load', err))
        Promise.all([load(modelUrls.ant), load(modelUrls.leaves)])
          .then(([a, l]) => !disposed && buildAnt(a, l))
          .catch((err) => console.error('ant / leaves failed to load', err))
          // The 28 MB forest waits until the ant and leaves are in, so it never competes with them for bandwidth.
          .then(() => (disposed ? null : load(modelUrls.forest)))
          .then((g) => g && !disposed && buildForest(g))
          .catch((err) => console.error('forest failed to load', err))
      } catch (err) {
        console.error(err)
        onError?.(err)
      }
  })


  // click a glowing structure to open its record (ignored if the pointer was dragged)
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2()
  let down = null
  const onDown = (e) => (down = [e.clientX, e.clientY])
  const onClick = (e) => {
    if (!dnaInfo || phase.dna < 0.5 || !down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6) return
    const r = canvas.getBoundingClientRect()
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
    ray.setFromCamera(ndc, camera)
    const hit = ray.intersectObjects(dnaInfo.items.map((i) => i.group), true)[0]
    let o = hit?.object
    while (o && !o.userData.kind) o = o.parent
    if (o) onInspect?.(o.userData.kind)
  }
  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('click', onClick)
  window.addEventListener('resize', resize)
  window.addEventListener('scroll', onScroll, { passive: true })
  canvas.addEventListener('pointerdown', onPointerDown)
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointercancel', onPointerUp)
  canvas.addEventListener('keydown', onKeyDown)
  resize()
  frame()

  return {
    dispose() {
      disposed = true
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      window.removeEventListener('scroll', onScroll)
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('click', onClick)
      canvas.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
      canvas.removeEventListener('keydown', onKeyDown)
      scene.traverse((o) => {
        if (o.isMesh) o.geometry?.dispose()
      })
      dust?.geometry.dispose()
      dust?.material.dispose()
      stars.geometry.dispose()
      stars.material.dispose()
      dnaInfo?.helixMaterial.dispose()
      ant?.materials.forEach((m) => m.dispose())
      forest?.mats.forEach((m) => m.dispose())
      forestClouds?.dispose()
      envTexture.dispose()
      pmrem.dispose()
      composer.dispose()
      renderer.dispose()
    },
  }
}