import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'
import './story/story.css'

import DnaScene from './components/DnaScene.jsx'
import DarkSequence from './components/DarkSequence.jsx'
import Nav from './components/Nav.jsx'
import Reader from './components/Reader.jsx'
import Quiz from './components/Quiz.jsx'

import { STOPS } from './content.js'
import { BEATS } from './story/timeline.js'
import { useScrollTimeline } from './story/useScrollTimeline.js'
import StoryPanel from './story/StoryPanel.jsx'

// The blackout lines still come from your old STOPS array.
const DARK_BEATS = STOPS.find((s) => s.kind === 'dark')?.beats ?? []

// The quiz is not a camera beat: the scene holds the last pose while it scrolls past. It only gets a nav entry.
const NAV_STOPS = [...BEATS, { id: 'quiz', kind: 'quiz', nav: 'Quiz' }]

function App() {
  // refs: one stop element per beat, in timeline order. active: the beat the viewer is on.
  const { active, refs, getEls, goTo } = useScrollTimeline(BEATS.length)
  const [open, setOpen] = useState(null) // INSPECT key shown in the Reader
  const quizRef = useRef(null)
  const [inQuiz, setInQuiz] = useState(false)

  // Primary button: home moves on; other chapters move on until you add a chapter reader.
  const handlePrimary = useCallback((beat, index) => goTo(index + 1), [goTo])

  // The quiz's "Revisit" buttons: jump back to a chapter by its beat id.
  const jumpToChapter = useCallback(
    (id) => {
      const i = BEATS.findIndex((b) => b.id === id)
      if (i >= 0) goTo(i)
    },
    [goTo],
  )

  // Nav sees the beats plus the quiz element at the end.
  const getNavEls = useCallback(() => [...getEls(), quizRef.current], [getEls])

  // Once the quiz is well into view, the story panel (still on the last beat) fades out of its way.
  useEffect(() => {
    let raf = 0
    const read = () => {
      raf = 0
      const el = quizRef.current
      if (el) setInQuiz(el.getBoundingClientRect().top < window.innerHeight * 0.7)
    }
    const schedule = () => { if (!raf) raf = requestAnimationFrame(read) }
    read()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  return (
    <>
      <DnaScene getStops={() => getEls().filter(Boolean)} onInspect={setOpen} />
      <Nav stops={NAV_STOPS} getEls={getNavEls} />

      <div className="story-fade" data-hidden={inQuiz}>
        <StoryPanel beats={BEATS} activeIndex={active} onPrimary={handlePrimary} onSecondary={setOpen} />
      </div>

      <main className="stages">
        {BEATS.map((beat, i) =>
          beat.kind === 'dark' ? (
            <DarkSequence key={beat.id} id={beat.id} ref={refs[i]} beats={DARK_BEATS} />
          ) : (
            <section key={beat.id} id={beat.id} ref={refs[i]} className="stage" aria-label={beat.entry?.title ?? beat.id} />
          ),
        )}
      </main>

      <Quiz ref={quizRef} onJump={jumpToChapter} />

      <Reader id={open} onClose={() => setOpen(null)} />
    </>
  )
}

export default App
