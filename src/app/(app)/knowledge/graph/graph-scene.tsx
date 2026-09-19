'use client'

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useRouter } from 'next/navigation'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { projectColor } from '@/components/icons'
import { layout3D } from '@/lib/graph-3d'
import type { KnowledgeGraph } from '@/lib/api/knowledge-graph'

/**
 * The map as a place you can move through.
 *
 * The flat version of this page opens with an argument against exactly this,
 * and the argument has not stopped being true: depth puts things behind other
 * things, and the one finding the page exists to deliver is how much of the
 * corpus is joined to nothing. Three things answer it, and all three are load
 * bearing rather than decoration.
 *
 * The entries joined to nothing are not in the cloud. They sit on a lit disc
 * underneath it, in a sunflower spiral, and nothing is drawn between the
 * camera and that disc — see `layout3D`. You can orbit to any angle the
 * controls allow and still count them.
 *
 * The camera is clamped off both poles, so there is no angle from which the
 * cloud collapses to the edge-on line a free camera finds immediately.
 *
 * And the flat map is still here: still the fallback where WebGL is missing,
 * one click away on a toggle. Nothing was removed to add this.
 *
 * Geometry is instanced — one draw call for every sphere, one for every link,
 * one for the glow. Positions come from `layout3D`, which is deterministic, so
 * this scene is as stable between renders as the flat one: a `router.refresh()`
 * landing mid-orbit changes nothing about where anything is.
 */

type Props = {
  graph: KnowledgeGraph
  /** Lifted, so the shell can draw one title bar over either renderer. */
  onHover: (slug: string | null) => void
  focused: string | null
}

/** A radius that makes a hub look like one, in world units. */
const radiusOf = (degree: number): number =>
  degree === 0 ? 0.62 : 0.85 + Math.min(2.4, Math.sqrt(degree) * 0.66)

/** Enough links to be worth naming without being asked. */
const LABEL_AT = 6

/** How many titles can be on screen before it is a wall of text. */
const LABEL_CAP = 34

type Palette = {
  bg: THREE.Color
  muted: THREE.Color
  accent: THREE.Color
  danger: THREE.Color
  /** Whether we are on the dark ground, which changes how light is mixed. */
  dark: boolean
}

const readPalette = (): Palette => {
  const style = getComputedStyle(document.documentElement)
  const of = (name: string, fallback: string) => {
    const raw = style.getPropertyValue(name).trim()
    try {
      return new THREE.Color(raw || fallback)
    } catch {
      return new THREE.Color(fallback)
    }
  }
  const bg = of('--bg', '#08090a')
  // Luminance rather than a theme class, so this stays right even if the
  // ground is changed to something between the two.
  const dark = bg.r * 0.2126 + bg.g * 0.7152 + bg.b * 0.0722 < 0.5
  return {
    bg,
    muted: of('--fg-muted', dark ? '#9aa0a9' : '#61656c'),
    accent: of('--accent', dark ? '#7b86e8' : '#5e6ad2'),
    danger: of('--danger', '#c52828'),
    dark,
  }
}

/**
 * A soft dot and a dashed ring, drawn once each into a canvas.
 *
 * The glow is a sprite rather than a bloom pass. A post-processing chain for
 * one effect costs a second render target and two more full-screen passes, and
 * at this node count it is indistinguishable — the light here comes from
 * hundreds of small sources, not the few blown-out ones bloom is for.
 */
const softDot = (): THREE.Texture => {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
    g.addColorStop(0, 'rgba(255,255,255,1)')
    g.addColorStop(0.22, 'rgba(255,255,255,0.32)')
    g.addColorStop(0.55, 'rgba(255,255,255,0.07)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, size, size)
  }
  return new THREE.CanvasTexture(canvas)
}

const dashedRing = (): THREE.Texture => {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 10
    ctx.setLineDash([14, 12])
    ctx.beginPath()
    ctx.arc(size / 2, size / 2, size / 2 - 11, 0, Math.PI * 2)
    ctx.stroke()
  }
  return new THREE.CanvasTexture(canvas)
}

/**
 * Points sized per point, in world units, which `PointsMaterial` cannot do.
 *
 * `PointsMaterial` takes one size for the whole cloud. A hub's glow has to be
 * bigger than a leaf's or the light says nothing about the shape, so this is
 * the smallest shader that carries a size and a colour per vertex and still
 * attenuates with distance the way the built-in one does.
 */
const glowMaterial = (map: THREE.Texture, additive: boolean, opacity: number) =>
  new THREE.ShaderMaterial({
    uniforms: {
      map: { value: map },
      opacity: { value: opacity },
      /**
       * Half the canvas height, which is what the renderer feeds its own
       * `PointsMaterial`. Kept in step with the element on every resize, or
       * the glow is sized for one window and drawn in another.
       */
      scale: { value: 300 },
    },
    // Every attribute and uniform is declared. A raw ShaderMaterial is given
    // the standard matrices and `position` by three.js and nothing else — not
    // `color`, which `vertexColors` only wires up for the built-in materials,
    // and not anything named in `uniforms`. Leaving either implicit is a
    // shader that fails to compile, which takes the whole scene with it.
    vertexShader: `
      uniform float scale;
      attribute float size;
      attribute vec3 color;
      varying vec3 vColour;
      void main() {
        vColour = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * (scale / -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      uniform sampler2D map;
      uniform float opacity;
      varying vec3 vColour;
      void main() {
        vec4 t = texture2D(map, gl_PointCoord);
        gl_FragColor = vec4(vColour, t.a * opacity);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  })

export const GraphScene = ({ graph, onHover, focused }: Props) => {
  const host = useRef<HTMLDivElement>(null)
  const layer = useRef<HTMLDivElement>(null)
  const router = useRouter()

  /** Read by the loop, which must not be rebuilt when the focus changes. */
  const focusedRef = useRef<string | null>(null)
  useEffect(() => {
    focusedRef.current = focused
  }, [focused])

  const onHoverRef = useRef(onHover)
  useEffect(() => {
    onHoverRef.current = onHover
  }, [onHover])

  const place = useMemo(() => layout3D(graph), [graph])

  /** Who each entry touches, so looking at one can dim everything it does not. */
  const neighbours = useMemo(() => {
    const map = new Map<string, Set<string>>()
    const join = (a: string, b: string) => {
      if (!map.has(a)) map.set(a, new Set())
      map.get(a)?.add(b)
    }
    for (const { source, target } of graph.edges) {
      join(source, target)
      join(target, source)
    }
    for (const gap of graph.missing) {
      for (const from of gap.from) {
        join(from, gap.slug)
        join(gap.slug, from)
      }
    }
    return map
  }, [graph.edges, graph.missing])

  const open = useCallback((slug: string) => router.push(`/knowledge/${slug}`), [router])

  useEffect(() => {
    const element = host.current
    const overlay = layer.current
    if (!element || !overlay) return

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: false,
        powerPreference: 'high-performance',
      })
    } catch {
      // No WebGL. The shell has already decided whether to mount this at all;
      // getting here means the check passed and creation still failed, so the
      // honest thing is to draw nothing rather than a broken scene.
      return
    }

    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
    const canvas = renderer.domElement
    canvas.style.display = 'block'
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    canvas.style.touchAction = 'none'
    canvas.style.outline = 'none'
    element.appendChild(canvas)

    let palette = readPalette()
    const scene = new THREE.Scene()
    scene.background = palette.bg.clone()
    // Haze, so distance reads as distance rather than as "smaller". It is the
    // cheapest depth cue there is, and it stops the far side of the cloud
    // competing with the near side for attention.
    scene.fog = new THREE.Fog(palette.bg.getHex(), place.radius * 1.7, place.radius * 5.4)

    const camera = new THREE.PerspectiveCamera(46, 1, 0.1, place.radius * 24)
    camera.position.set(place.radius * 1.1, place.radius * 0.85, place.radius * 2.2)

    const controls = new OrbitControls(camera, canvas)
    controls.enableDamping = true
    controls.dampingFactor = 0.075
    // Rotate and dolly only. Panning as well is three gestures competing for
    // two buttons, and a camera that can be walked far enough from the cloud
    // that there is no way back but the reset.
    controls.enablePan = false
    controls.minDistance = place.radius * 0.5
    controls.maxDistance = place.radius * 5
    // Clamped off both poles: straight down the Y axis the cloud collapses to
    // a disc and the floor of orphans disappears edge-on, which are the two
    // things this view must never do.
    controls.minPolarAngle = 0.2
    controls.maxPolarAngle = Math.PI * 0.84
    controls.rotateSpeed = 0.6
    controls.zoomSpeed = 0.85

    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    controls.autoRotate = !motion.matches
    controls.autoRotateSpeed = 0.3
    const onMotionChange = () => {
      controls.autoRotate = !motion.matches
    }
    motion.addEventListener('change', onMotionChange)

    const key = new THREE.DirectionalLight(0xffffff, palette.dark ? 1.35 : 1.9)
    key.position.set(1, 1.4, 0.8)
    scene.add(key)
    const rim = new THREE.DirectionalLight(palette.accent.getHex(), palette.dark ? 0.85 : 0.45)
    rim.position.set(-1, -0.4, -0.9)
    scene.add(rim)
    const ambient = new THREE.AmbientLight(0xffffff, palette.dark ? 0.6 : 1)
    scene.add(ambient)

    // ---- what is drawn -------------------------------------------------

    const drawn = graph.nodes.filter((n) => place.at.has(n.slug))
    const slugAt = drawn.map((n) => n.slug)
    const rowOf = new Map(slugAt.map((s, i) => [s, i]))
    const colourOf = (project: string | null) =>
      project ? new THREE.Color(projectColor(project)) : palette.muted.clone()
    let base = drawn.map((n) => colourOf(n.project))

    const sphere = new THREE.SphereGeometry(1, 18, 14)
    const material = new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.05 })
    const nodes = new THREE.InstancedMesh(sphere, material, drawn.length)
    scene.add(nodes)

    const dummy = new THREE.Object3D()
    drawn.forEach((n, i) => {
      const p = place.at.get(n.slug)
      if (!p) return
      dummy.position.set(p.x, p.y, p.z)
      dummy.scale.setScalar(radiusOf(n.degree))
      dummy.updateMatrix()
      nodes.setMatrixAt(i, dummy.matrix)
      nodes.setColorAt(i, base[i] as THREE.Color)
    })
    nodes.instanceMatrix.needsUpdate = true
    if (nodes.instanceColor) nodes.instanceColor.needsUpdate = true

    // The glow, one additive sprite per node.
    const dot = softDot()
    const glowGeometry = new THREE.BufferGeometry()
    const glowPos = new Float32Array(drawn.length * 3)
    const glowCol = new Float32Array(drawn.length * 3)
    const glowSize = new Float32Array(drawn.length)
    drawn.forEach((n, i) => {
      const p = place.at.get(n.slug)
      if (!p) return
      glowPos.set([p.x, p.y, p.z], i * 3)
      glowSize[i] = radiusOf(n.degree) * 7.5
    })
    glowGeometry.setAttribute('position', new THREE.BufferAttribute(glowPos, 3))
    glowGeometry.setAttribute('color', new THREE.BufferAttribute(glowCol, 3))
    glowGeometry.setAttribute('size', new THREE.BufferAttribute(glowSize, 1))
    // Additive on the dark ground is light. On white it would only wash the
    // picture out, so there it blends normally and reads as a soft shadow —
    // which is also what stops the grey, unprojected entries smudging, the way
    // their halo did on the flat map in light mode.
    const glowMat = glowMaterial(dot, palette.dark, palette.dark ? 0.5 : 0.16)
    const glow = new THREE.Points(glowGeometry, glowMat)
    glow.frustumCulled = false
    scene.add(glow)

    // Links.
    const edges = graph.edges.filter((e) => place.at.has(e.source) && place.at.has(e.target))
    const linkPos = new Float32Array(edges.length * 6)
    const linkCol = new Float32Array(edges.length * 6)
    edges.forEach((e, i) => {
      const a = place.at.get(e.source)
      const b = place.at.get(e.target)
      if (!a || !b) return
      linkPos.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6)
    })
    const linkGeometry = new THREE.BufferGeometry()
    linkGeometry.setAttribute('position', new THREE.BufferAttribute(linkPos, 3))
    linkGeometry.setAttribute('color', new THREE.BufferAttribute(linkCol, 3))
    const linkMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: palette.dark ? 0.55 : 0.5,
      depthWrite: false,
    })
    scene.add(new THREE.LineSegments(linkGeometry, linkMat))

    // References to entries nobody wrote: a dashed tether and a hollow ring.
    const gaps = graph.missing.filter((m) => place.at.has(m.slug))
    const gapPos = new Float32Array(gaps.length * 6)
    const ringPos = new Float32Array(gaps.length * 3)
    gaps.forEach((m, i) => {
      const a = m.from[0] ? place.at.get(m.from[0]) : undefined
      const b = place.at.get(m.slug)
      if (!b) return
      ringPos.set([b.x, b.y, b.z], i * 3)
      if (a) gapPos.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6)
    })
    const gapGeometry = new THREE.BufferGeometry()
    gapGeometry.setAttribute('position', new THREE.BufferAttribute(gapPos, 3))
    const gapMat = new THREE.LineDashedMaterial({
      color: palette.danger.getHex(),
      dashSize: place.radius * 0.022,
      gapSize: place.radius * 0.022,
      transparent: true,
      opacity: 0.75,
    })
    const gapLines = new THREE.LineSegments(gapGeometry, gapMat)
    gapLines.computeLineDistances()
    scene.add(gapLines)

    const ringTex = dashedRing()
    const ringGeometry = new THREE.BufferGeometry()
    ringGeometry.setAttribute('position', new THREE.BufferAttribute(ringPos, 3))
    const ringMat = new THREE.PointsMaterial({
      map: ringTex,
      color: palette.danger.getHex(),
      size: place.radius * 0.05,
      transparent: true,
      depthWrite: false,
      sizeAttenuation: true,
    })
    const rings = new THREE.Points(ringGeometry, ringMat)
    rings.frustumCulled = false
    scene.add(rings)

    /**
     * The edge of the disc the joined-to-nothing sit on.
     *
     * Without it they are dots hanging below the cloud and the eye files them
     * as part of it. With it they are a region with a boundary, which is what
     * the band along the foot of the flat map was doing.
     */
    const floorMat = new THREE.MeshBasicMaterial({
      color: palette.muted.getHex(),
      transparent: true,
      opacity: 0.25,
      side: THREE.DoubleSide,
    })
    const floor = new THREE.Mesh(
      new THREE.RingGeometry(place.radius * 1.2, place.radius * 1.225, 96),
      floorMat,
    )
    floor.rotation.x = Math.PI / 2
    floor.position.y = place.floor - place.radius * 0.12
    scene.add(floor)

    // ---- focus ---------------------------------------------------------

    const lit = new THREE.Color()
    const white = new THREE.Color(0xffffff)

    const paintFocus = (slug: string | null) => {
      const near = slug ? neighbours.get(slug) : null
      const inSet = (s: string) => slug === null || slug === s || (near?.has(s) ?? false)

      for (let i = 0; i < drawn.length; i += 1) {
        const n = drawn[i]
        if (!n) continue
        const c = base[i] as THREE.Color
        if (inSet(n.slug)) {
          lit.copy(c)
          // The one being looked at, and what it touches, brighten rather than
          // merely staying put — otherwise "lit" is only the absence of
          // dimming and the focus has no centre.
          if (slug) lit.lerp(white, slug === n.slug ? 0.45 : 0.16)
        } else {
          // Mixed toward the ground rather than made transparent: transparency
          // on an instanced mesh means sorting every instance every frame, and
          // this reads the same for one buffer upload.
          lit.copy(c).lerp(palette.bg, 0.8)
        }
        nodes.setColorAt(i, lit)
        glowCol.set([lit.r, lit.g, lit.b], i * 3)
      }
      if (nodes.instanceColor) nodes.instanceColor.needsUpdate = true
      glowGeometry.getAttribute('color').needsUpdate = true

      edges.forEach((e, i) => {
        const on = inSet(e.source) && inSet(e.target)
        const a = rowOf.get(e.source)
        const b = rowOf.get(e.target)
        const ca = a === undefined ? palette.muted : (base[a] as THREE.Color)
        const cb = b === undefined ? palette.muted : (base[b] as THREE.Color)
        const k = on ? (slug ? 1.4 : 0.8) : 0.09
        linkCol.set([ca.r * k, ca.g * k, ca.b * k, cb.r * k, cb.g * k, cb.b * k], i * 6)
      })
      linkGeometry.getAttribute('color').needsUpdate = true
    }
    paintFocus(null)

    // ---- interaction ---------------------------------------------------

    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()
    let hovering: string | null = null
    let inside = false
    /** How far the pointer travelled while held, so a drag is not a click. */
    let travelled = 0
    let last: { x: number; y: number } | null = null
    /** Touch has to behave differently, and a click event does not carry it. */
    let touch = false

    const onPointerMove = (event: PointerEvent) => {
      aim(event)
      inside = true
      if (last) {
        travelled += Math.hypot(event.clientX - last.x, event.clientY - last.y)
        last = { x: event.clientX, y: event.clientY }
      }
    }
    const onPointerLeave = () => {
      inside = false
      if (hovering) {
        hovering = null
        onHoverRef.current(null)
      }
    }
    /** Where the pointer is, in the -1..1 space the raycaster wants. */
    const aim = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect()
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
      // Read from whatever is actually being used right now, not from whatever
      // was used first: a tablet with a trackpad gets both, and a stale flag
      // means either the two-tap rule or the hover stops working.
      touch = event.pointerType === 'touch'
    }
    const under = (): string | null => {
      raycaster.setFromCamera(pointer, camera)
      const hit = raycaster.intersectObject(nodes, false)[0]
      return hit && hit.instanceId !== undefined ? (slugAt[hit.instanceId] ?? null) : null
    }

    const onPointerDown = (event: PointerEvent) => {
      last = { x: event.clientX, y: event.clientY }
      travelled = 0
      // A finger produces no pointermove before it lands, so without this the
      // hover state a tap reads is whatever the last mouse left behind —
      // which on a phone is nothing at all, and the tap did nothing.
      aim(event)
    }
    const onPointerUp = (event: PointerEvent) => {
      const dragged = travelled > 5
      last = null
      if (dragged) return
      aim(event)
      const slug = under()
      if (!slug) return
      // A drag that happens to end over a node is a drag — the flat map has
      // the same rule, and here it matters more because orbiting sweeps the
      // pointer across dozens of nodes on the way.
      //
      // And on a touch screen the gesture that reveals a node IS the gesture
      // that opens it, so the first tap reads it into the bar at the top and
      // only a second one follows the link. Same rule as the flat map, for
      // the same reason: there is no hover to separate the two.
      if (touch && focusedRef.current !== slug) {
        hovering = slug
        onHoverRef.current(slug)
        return
      }
      open(slug)
    }
    const noMenu = (event: Event) => event.preventDefault()

    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerleave', onPointerLeave)
    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('contextmenu', noMenu)

    // ---- theme ---------------------------------------------------------

    /**
     * The flat map gets the light/dark swap for nothing, because its colours
     * ARE the custom properties. A canvas has to be told, and the only signal
     * next-themes gives is the class it writes on <html>.
     */
    const repaint = () => {
      palette = readPalette()
      scene.background = palette.bg.clone()
      if (scene.fog) (scene.fog as THREE.Fog).color = palette.bg.clone()
      base = drawn.map((n) => colourOf(n.project))
      glowMat.blending = palette.dark ? THREE.AdditiveBlending : THREE.NormalBlending
      glowMat.uniforms.opacity!.value = palette.dark ? 0.5 : 0.16
      glowMat.needsUpdate = true
      linkMat.opacity = palette.dark ? 0.55 : 0.5
      key.intensity = palette.dark ? 1.35 : 1.9
      rim.intensity = palette.dark ? 0.85 : 0.45
      rim.color.set(palette.accent.getHex())
      ambient.intensity = palette.dark ? 0.6 : 1
      gapMat.color.set(palette.danger.getHex())
      ringMat.color.set(palette.danger.getHex())
      floorMat.color.set(palette.muted.getHex())
      paintFocus(focusedRef.current)
    }
    const themeWatch = new MutationObserver(repaint)
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })

    // ---- titles --------------------------------------------------------

    /**
     * Which titles to draw, chosen so that none lands on another.
     *
     * Same rule as the flat map — by importance, skipped on collision — with
     * depth folded into the ordering, because in three dimensions the nearest
     * label is the one that should win the space.
     *
     * They are HTML, and they are written straight to the DOM rather than
     * through React. Both of those are deliberate. HTML is what makes them a
     * constant size on screen at any camera distance and legible at a contrast
     * the stylesheet already measured — drawing them into the scene would
     * reintroduce the two bugs the flat map had, 3px text on a phone and
     * grey-on-white at 3.76:1. And writing them directly is what stops a
     * slowly rotating camera committing a React render fifteen times a second
     * for as long as the tab is open.
     */
    const pool: HTMLSpanElement[] = []
    const projected = new THREE.Vector3()

    const drawLabels = () => {
      const slug = focusedRef.current
      const near = slug ? neighbours.get(slug) : null
      const w = canvas.clientWidth
      const h = canvas.clientHeight

      const candidates: { node: (typeof drawn)[number]; x: number; y: number; z: number }[] = []
      for (const n of drawn) {
        if (slug ? !(n.slug === slug || (near?.has(n.slug) ?? false)) : n.degree < LABEL_AT) continue
        const p = place.at.get(n.slug)
        if (!p) continue
        projected.set(p.x, p.y, p.z).project(camera)
        if (projected.z <= -1 || projected.z >= 1) continue
        candidates.push({
          node: n,
          x: (projected.x * 0.5 + 0.5) * w,
          y: (-projected.y * 0.5 + 0.5) * h - 24,
          z: projected.z,
        })
      }
      candidates.sort((a, b) =>
        a.node.slug === slug
          ? -1
          : b.node.slug === slug
            ? 1
            : a.z - b.z || b.node.degree - a.node.degree,
      )

      const placed: { x: number; y: number; w: number; h: number }[] = []
      let used = 0
      for (const c of candidates) {
        if (used >= LABEL_CAP) break
        const text = c.node.title.length > 38 ? `${c.node.title.slice(0, 37)}…` : c.node.title
        const bw = text.length * 5.7 + 10
        const bh = 15
        const bx = c.x - bw / 2
        if (bx + bw < 0 || bx > w || c.y + bh < 0 || c.y > h) continue
        if (placed.some((b) => bx < b.x + b.w && bx + bw > b.x && c.y < b.y + b.h && c.y + bh > b.y))
          continue
        placed.push({ x: bx, y: c.y, w: bw, h: bh })

        let span = pool[used]
        if (!span) {
          span = document.createElement('span')
          span.className =
            'text-fg-muted absolute top-0 left-0 whitespace-nowrap text-[0.6875rem] leading-none'
          // Three stacked shadows in the ground colour, which is how a knockout
          // is done without a second element behind every title.
          span.style.textShadow = '0 0 3px var(--bg), 0 0 3px var(--bg), 0 0 7px var(--bg)'
          overlay.appendChild(span)
          pool[used] = span
        }
        if (span.textContent !== text) span.textContent = text
        span.style.transform = `translate3d(${Math.round(c.x)}px, ${Math.round(c.y)}px, 0) translateX(-50%)`
        span.style.opacity = slug && c.node.slug !== slug ? '0.75' : '1'
        span.style.display = ''
        used += 1
      }
      for (let i = used; i < pool.length; i += 1) {
        const span = pool[i]
        if (span) span.style.display = 'none'
      }
    }

    // ---- the loop ------------------------------------------------------

    const resize = () => {
      const w = element.clientWidth || 1
      const h = element.clientHeight || 1
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      // What the renderer passes its own PointsMaterial. Left at a constant
      // the glow is sized for one window height and wrong in every other.
      glowMat.uniforms.scale!.value = h * 0.5
    }
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    resize()

    let raf = 0
    let frame = 0
    let alive = true
    let lastFocus: string | null = null

    const tick = () => {
      if (!alive) return
      raf = requestAnimationFrame(tick)
      controls.update()
      /**
       * Because `controls.update()` does not do it.
       *
       * It moves `camera.position` and calls `lookAt`, both of which touch
       * only the local transform — the `updateMatrixWorld()` calls in
       * OrbitControls live in the `zoomToCursor` branch, which this scene does
       * not use. `camera.matrixWorld` is otherwise refreshed by the renderer,
       * and that happens at the BOTTOM of this function.
       *
       * So everything below that reads the camera — the raycast for the hover
       * pick, and `project()` for every title — would be working from where
       * the camera was on the previous frame, one frame behind what is then
       * drawn. With `autoRotate` on, the camera is never still, so that is not
       * an edge case during a drag: it is every frame the tab is open, and it
       * shows up as titles that float slightly off their nodes and a hover
       * target that does not quite match what is under the cursor.
       *
       * The renderer sees the matrix is already current and skips its own.
       */
      camera.updateMatrixWorld()

      // Not while a finger is on the glass. Picking on touch-move would light
      // every node an orbit gesture passed over, and by the time the finger
      // lifted the node under it would already be the focused one — which is
      // exactly the state the two-tap rule reads as "you have seen this, now
      // open it". The first tap would open.
      if (inside && !touch) {
        const slug = under()
        if (slug !== hovering) {
          hovering = slug
          onHoverRef.current(slug)
          canvas.style.cursor = slug ? 'pointer' : ''
        }
      }

      if (focusedRef.current !== lastFocus) {
        lastFocus = focusedRef.current
        paintFocus(lastFocus)
      }

      // The titles are the expensive part of a frame, not the scene. Re-placed
      // every third frame: the camera moves slowly enough that nobody can see
      // the difference, and it takes the projection and the collision pass off
      // two frames in three.
      frame += 1
      if (frame % 3 === 0) drawLabels()

      renderer.render(scene, camera)
    }
    tick()

    return () => {
      alive = false
      cancelAnimationFrame(raf)
      observer.disconnect()
      themeWatch.disconnect()
      motion.removeEventListener('change', onMotionChange)
      controls.dispose()
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerleave', onPointerLeave)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('contextmenu', noMenu)
      for (const span of pool) span.remove()
      // A WebGL context is not collected on unmount and the browser keeps only
      // a handful, so walking between the map and an entry a dozen times would
      // otherwise silently lose the oldest.
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh
        mesh.geometry?.dispose()
        const m = mesh.material
        if (Array.isArray(m)) m.forEach((x) => x.dispose())
        else if (m) (m as THREE.Material).dispose()
      })
      dot.dispose()
      ringTex.dispose()
      renderer.dispose()
      canvas.remove()
    }
  }, [graph, place, neighbours, open])

  return (
    <div className="absolute inset-0">
      <div ref={host} className="h-full w-full cursor-grab active:cursor-grabbing" />
      <div ref={layer} className="pointer-events-none absolute inset-0 overflow-hidden" />
    </div>
  )
}

export default GraphScene
