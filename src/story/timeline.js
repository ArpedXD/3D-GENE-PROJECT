/**
 * THE TIMELINE: one ordered list of "beats". Each beat is one scroll stop on the page,
 * and it ties together three things that used to live in three files:
 *
 *   1. a camera pose        (cam)     where the 3D camera stands when this beat is centred
 *   2. a block of copy      (entry)   looked up by id in genomeStudyData
 *   3. an inspectable thing (inspect) the INSPECT key opened by the secondary button
 *
 * dnaScene.js interpolates between CAMERA_KEYS[i] and CAMERA_KEYS[i+1] using the on-screen
 * positions of the stop elements, so the ORDER OF THIS ARRAY IS THE ORDER OF THE FLIGHT.
 * Reorder a beat and its camera, text and button all move together.
 *
 * kind: 'text'   -> floating panel shows the entry's copy
 *       'dark'   -> the pinned DarkSequence (typographic blackout); panel hides
 *       'visual' -> a camera-only beat with no copy; panel hides
 *
 * Pose fields (unchanged from the previous cameraKeys.js):
 *   pos / look     camera position and aim point, world units
 *   roll           tilts the picture
 *   shift          slides the image by a fraction of the viewport (x > 0 pushes the subject RIGHT,
 *                  which is how the panel knows to sit on the LEFT; see panelSide below)
 *   shiftPortrait  same, for phones, where the panel sits below
 *   world          0 = blue DNA world, 1 = warm ant world
 *   dna / ant      how visible each model is
 *   earth          visibility of the planet
 *   forest         visibility of the forest (forest.glb), which sits between the ant and the planet
 *   curve          remaps a parameter's progress inside the segment, so lights go out early and return late
 *   cut            skip the flight: jump to this pose halfway, while the screen is black
 *   zoom           the flight INTO this pose is a straight pull-away from the same look point: height is interpolated by RATIO
 *                  (a steady zoom rate) instead of by distance, so 130 -> 6000 doesn't rush away in the first few percent of
 *                  scroll and then crawl
 *   ease           0..1, how much of the smoother-step ease the flight INTO this pose gets (default 1 = full ease in and out,
 *                  0 = linear). Pass-through beats use less so the camera doesn't come to a dead stop at every one of them
 *   morph          the flight INTO this pose is a transformation, not a cut: the planet is born at the ant's
 *                  head (ANT_HEAD) at head size (HEAD_RADIUS), then swells to EARTH_RADIUS while its centre
 *                  sinks to EARTH_ORIGIN. Think of a balloon inflating from a pinpoint: it starts as big as
 *                  the head, grows, and the camera rides the same curve so it hovers just above the skin the
 *                  whole way down. dnaScene.js reads this flag.
 */
import { genomeStudyData } from './genomeStudyData.js'

export const ANT_ORIGIN = [0, -60, 0]
/** The planet's centre. Radius is EARTH_RADIUS (6371, the real radius in km, so 1 world unit ~ 1 km of planet), so a centre at y = -6431 puts the north pole at y = -60,
 *  exactly where the ant stands (ANT_ORIGIN y = -60). If you change EARTH_RADIUS, set this to -60 - EARTH_RADIUS. */
export const EARTH_ORIGIN = [0, -60 - 6371, 0]
/** Where the ant's head is, in the ant group's own space (the point the antHead pose looks at).
 *  The planet is born here. dnaScene.js reads it through cameraKeys.js. */
export const ANT_HEAD = [0, 0.5, -2.5]
/** Planet radius at the instant of birth: just big enough to swallow the ant's head,
 *  so the head reads as turning into the planet rather than a second model appearing. */
export const HEAD_RADIUS = 0.55
/** Planet radius once fully grown. earthLand, earthLand2 and earthOrbit are all framed for this size. */
export const EARTH_RADIUS = 6371
const A = ANT_ORIGIN[1]
const E = EARTH_ORIGIN[1]

/* ───────────── camera poses, grouped by the 3D scene they live in ───────────── */
const POSE = {
  // DNA world: the helix lies along X, 12 units long, centred on the origin
  hero:       { pos: [1.5, 1.8, 27], look: [0, 0, 0], roll: 0.3, shift: [0.16, 0], shiftPortrait: [0, 0.2], world: 0, dna: 1, ant: 0 },
  basePairs:  { pos: [-1.2, 0.6, 8.6], look: [-0.4, 0, 0], roll: -0.2, shift: [-0.37, 0], shiftPortrait: [0, 0.2], world: 0, dna: 1, ant: 0 },
  length:     { pos: [-9.2, 2.0, 5.2], look: [-1.5, 0, 0], roll: 0.08, shift: [0.32, 0], shiftPortrait: [0, 0.2], world: 0, dna: 1, ant: 0 },
  coil:       { pos: [-9, 0.3, 0.5], look: [0, 0, 0], roll: 0, shift: [-0.3, 0], shiftPortrait: [0, 0.2], world: 0, dna: 1, ant: 0 },
  inside:     { pos: [-3.4, 0.05, 0.1], look: [4, 0, 0], roll: 0.15, shift: [0, 0], shiftPortrait: [0, 0.15], world: 0, dna: 1, ant: 0 },
  // Blackout: drift down the tunnel while the glow dies and the words light up
  blackout:   { pos: [2.2, 0.05, 0.1], look: [9, 0, 0], roll: 0.15, shift: [0, 0], shiftPortrait: [0, 0], world: 1, dna: 0, ant: 0, curve: { dna: [0, 0.42], world: [0, 0.42] } },
  // Ant world, lit by one lamp
  antTop:     { pos: [0, A + 10.4, -0.02], look: [0, A, 0], roll: 0, shift: [0.22, 0], shiftPortrait: [0, 0.2], world: 1, dna: 0, ant: 1, cut: true, curve: { ant: [0.62, 0.95] } },
  antThree:   { pos: [5.4, A + 5.0, -4.4], look: [0, A + 0.5, 0.2], roll: 0, shift: [0.22, 0], shiftPortrait: [0, 0.2], world: 1, dna: 0, ant: 1 },
  // Straight-on profile, ant parked on the LEFT of the screen (shift.x < 0), panel on the right.
  antSide:    { pos: [8.4, A + 1.1, 0.3], look: [0, A + 0.9, 0], roll: 0, shift: [-0.3, 0], shiftPortrait: [0, 0.2], world: 1, dna: 0, ant: 1 },
  // Ground level, beneath the belly, looking up and forward along the body toward the head.
  antUnder:   { pos: [2.4, A + 0.16, 3.4], look: [0, A + 0.75, -0.8], roll: -0.1, shift: [-0.3, 0], shiftPortrait: [0, 0.2], world: 1, dna: 0, ant: 1 },
  // Last ant frame: face to face with the head. The next flight is the morph.
  antHead:    { pos: [1.5, A + 1.3, -3.6], look: [0, A + 0.5, -2.5], roll: 0, shift: [0.22, 0], shiftPortrait: [0, 0.2], world: 1, dna: 0, ant: 1 },
  // PHASE 1 · the ant's finale. Camera sits directly on top of the ant, looking straight down at its back...
  antOverhead: { pos: [0, A + 3.4, 0.02], look: [0, A, 0], roll: 0, shift: [0, 0], shiftPortrait: [0, 0], world: 1, dna: 0, ant: 1, soil: 1 },
  // ...pulls up in stages, each roughly 3-4x higher than the last, so the climb feels steady instead of speeding up.
  // By the last stage the camera is 3000 units up and the 5-unit ant is about a pixel on the planet's north pole.
  antZoomMid:  { pos: [0, A + 20, 0.02], look: [0, A, 0], roll: 0, shift: [0, 0], shiftPortrait: [0, 0], world: 1, dna: 0, ant: 1, earth: 0, forest: 0.3, soil: 0.45, curve: { forest: [0, 0.8], soil: [0, 0.8] } },
  // ...the lamp-lit soil dissolves and the FOREST grows up around the clearing the ant was standing in
  // (the ant is on the forest's road). forest.glb is scaled by FOREST_SCALE in dnaScene.js: trees about 40-75 units tall.
  // forestCanopy is a low, oblique shot from the south end of the road, looking up it between the tree walls.
  forestCanopy: { pos: [0, A + 34, 215], look: [0, A + 22, -60], roll: 0, shift: [0.22, 0], shiftPortrait: [0, 0.2], world: 1, dna: 0, ant: 1, earth: 0, forest: 1, soil: 0, curve: { forest: [0.1, 0.7], soil: [0, 0.5] } },
  // Straight down over the clearing, still INSIDE the wood's footprint (about 130 up, so the walls of the forest stay out of frame).
  // The camera never rises high enough to see the block's edges: the wood dissolves into the planet during the next flight.
  forestAerial: { pos: [0, A + 130, 0.02], look: [0, A, 0], roll: 0, shift: [0, 0], shiftPortrait: [0, 0], world: 1, dna: 0, ant: 1, earth: 0, forest: 1, soil: 0 },
  // ...as the camera climbs, the forest fades out and the planet fades in underneath, so the ant
  // is left standing on the north pole of a world that keeps shrinking beneath the camera.
  // Forest fade-out and planet fade-in are stretched (0.1 -> 0.2, 0.14 -> 0.26) and the climb is a ratio zoom, so at the end of the forest fade
  // the camera is only ~180 up. The block's edge only comes into view from about 240 up, so it is still never seen.
  antZoom4:    { pos: [0, A + 6000, 0.02], look: [0, A, 0], roll: 0, shift: [0, 0], shiftPortrait: [0, 0], world: 1, dna: 0, ant: 1, earth: 1, forest: 0, soil: 0, zoom: true, ease: 0.8, curve: { forest: [0, 0.2], earth: [0.04, 0.26] } },
  antZoomFar:  { pos: [0, A + 19000, 0.02], look: [0, A, 0], roll: 0, shift: [0, 0], shiftPortrait: [0, 0], world: 1, dna: 0, ant: 1, earth: 1, forest: 0, soil: 0, zoom: true, ease: 0.55 },
  // Planet: the ant's head becomes the Earth, then surface -> continent -> orbit.
  // The planet is born at the head and swells (see `morph`). It is opaque almost at once, and the ant's body
  // fades out underneath it while the camera pulls away, so it reads as the head transforming, not a cross-fade.
  // PHASE 3: every pose from here on is farther from the planet's centre than the one before (about 25,400 -> 28,900 -> 32,800 -> 36,800),
  // so the camera only ever moves away. The ant stays on the north pole at the look point until it fades.
  earthLand:  { pos: [8920, A + 20400, 6370], look: [0, A, 0], roll: 0.1, shift: [0.25, 0], shiftPortrait: [0, 0.2], world: 1, dna: 0, ant: 0, earth: 1, soil: 0, morph: true, curve: { ant: [0.2, 0.6], earth: [0, 0.05] } },
  // The continent beat: halfway between earthLand and earthOrbit, on the same arc (about 32,800 from the planet's centre),
  // aimed between the north pole and the planet's centre so the globe slides into frame while the camera keeps backing away.
  earthLand2: { pos: [5180, 23190, 13050], look: [0, -3200, 0], roll: 0.05, shift: [0.27, 0], shiftPortrait: [0, 0.21], world: 1, dna: 0, ant: 0, earth: 1, ease: 0.55 },
  earthOrbit: { pos: [0, A + 24200, 20400], look: [0, E, 0], roll: 0, shift: [0.28, 0], shiftPortrait: [0, 0.22], world: 1, dna: 0, ant: 0, earth: 1 },
}

/* ───────────── the beats ───────────── */
const byId = Object.fromEntries(genomeStudyData.map((e) => [e.id, e]))

/** A beat that shows copy. `nav` is the short label for the top bar and the dot rail. */
const text = (id, nav, cam, inspect) => {
  if (!byId[id]) throw new Error(`timeline: no entry "${id}" in genomeStudyData`)
  return { id, kind: 'text', nav, cam, inspect, entry: byId[id] }
}

export const BEATS = [
  // DNA world ─ space, one body, the genome
  text('home',            'Home',              POSE.hero),                    // whole molecule on a diagonal
  text('the-person',      'The Person',        POSE.basePairs),               // close and level
  text('inside-the-body', 'Inside the Body',   POSE.length),                  // look along the molecule
  text('the-genome',      'The Genome',        POSE.coil, 'dna'),             // end-on, down the axis
  text('about-the-study', 'About the Study',   POSE.inside, 'cell0'),         // inside the helix
  { id: 'blackout', kind: 'dark', cam: POSE.blackout },                      // pinned typographic sequence

  // Ant world ─ lamp comes on, camera orbits the ant
  text('gene-therapy',        'Gene Therapy',        POSE.antTop, 'mol0'),
  text('stem-cell-research',  'Stem Cell Research',  POSE.antThree, 'cell1'),
  text('clinical-milestones', 'Clinical Milestones', POSE.antSide, 'mol5'),   // profile, ant on the left
  text('ethical-issues',      'Ethical Issues',      POSE.antUnder, 'mol4'),  // under the belly
  text('benefits-and-risks',  'Benefits & Risks',    POSE.antHead, 'mol1'),   // the head
  { id: 'ant-overhead', kind: 'visual', cam: POSE.antOverhead },              // camera on top of the ant
  { id: 'ant-zoom-mid', kind: 'visual', cam: POSE.antZoomMid },                // PHASE 3: first pull up, soil thinning, forest rising

  // Forest ─ between the ant and the planet: the ant's clearing turns out to be a road through a wood
  text('the-forest',    'The Forest',    POSE.forestCanopy),                      // low, up the road between the trees
  { id: 'forest-aerial', kind: 'visual', cam: POSE.forestAerial },              // camera-only: the whole wood from above

  // Back to the ant's pull-away: the forest fades, the Earth appears below
  { id: 'ant-zoom-4',   kind: 'visual', cam: POSE.antZoom4 },                 // 1000 up
  { id: 'ant-zoom-far', kind: 'visual', cam: POSE.antZoomFar },               // 3000 up: the ant is a single pixel

  // Planet ─ born from the ant's head, land on the surface, pull out to orbit
  text('access-and-governance', 'Access & Governance', POSE.earthLand, 'cell4'),
  { id: 'earth-zoom', kind: 'visual', cam: POSE.earthLand2 },                // camera-only: the continent
  text('references',            'References',          POSE.earthOrbit, 'nucleosome'),
]

// Fail loudly in dev if a data entry never made it onto the timeline.
if (import.meta.env?.DEV) {
  genomeStudyData.forEach((e) => {
    if (!BEATS.some((b) => b.id === e.id)) console.warn(`timeline: "${e.id}" has no beat and will never show`)
  })
}

/** Which side the panel docks on: opposite the subject. shift.x > 0 means the subject is pushed right. */
export const panelSide = (beat) => {
  const x = beat?.cam?.shift?.[0] ?? 0
  return x < -0.05 ? 'R' : 'L'
}