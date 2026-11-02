import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import quiz from '../quiz/quiz.json'
import '../quiz/Quiz.css'

/**
 * The quiz at the end of the story. All copy, questions, answers and score bands live in src/quiz/quiz.json.
 *
 * Design: the progress meter is a DNA helix that lies along X, like the one in the scene. Each question is one rung.
 * A correct answer completes the pair (complementary bases joined by a bar); a wrong one leaves a mismatch.
 *
 * Layout: every view (intro, 12 questions, results) is stacked in ONE grid cell and only the active one is visible,
 * so the section is always as tall as its tallest view. The page never changes height while you play, which keeps the
 * 3D camera's scroll mapping (measured from element positions) exact.
 */

const BASES = ['A', 'T', 'G', 'C']
// Same four colours as the helix in the scene (structures.js BASE_COLOURS), paired the way the bases pair.
const BASE_COLOUR = { A: '#7dd3fc', T: '#fcd34d', G: '#a78bfa', C: '#5eead4' }
const PAIRS = [['A', 'T'], ['G', 'C'], ['T', 'A'], ['C', 'G']]

const shuffle = (list) => {
  const a = [...list]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}
const makeDeck = () => quiz.questions.map((q) => ({ ...q, options: shuffle(q.options) }))
const ratingFor = (score) => [...quiz.ratings].sort((a, b) => b.min - a.min).find((r) => score >= r.min) ?? quiz.ratings[0]

/* ───────── the helix ───────── */

const W = 720
const H = 124
const PAD = 44
const AMP = 42
const CY = H / 2

function Helix({ states, current }) {
  const n = states.length
  const step = (W - PAD * 2) / n
  const theta = (x) => ((x - PAD) / step) * ((Math.PI * 2) / 5) + 0.9
  const xAt = (i) => PAD + (i + 0.5) * step

  // Each strand is cut into segments at the points where it swaps from front to back, so the front one reads as nearer.
  const strands = useMemo(() => {
    const out = []
    ;[1, -1].forEach((s) => {
      let seg = []
      let front = null
      for (let x = PAD * 0.4; x <= W - PAD * 0.4; x += 4) {
        const t = theta(x)
        const f = Math.cos(t) * s > 0
        const pt = `${x.toFixed(1)} ${(CY + s * AMP * Math.sin(t)).toFixed(1)}`
        if (front !== null && f !== front) {
          seg.push(pt)
          out.push({ s, front, d: `M${seg.join('L')}` })
          seg = []
        }
        front = f
        seg.push(pt)
      }
      if (seg.length > 1) out.push({ s, front, d: `M${seg.join('L')}` })
    })
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n])

  const matched = states.filter((s) => s === 'match').length
  const answered = states.filter((s) => s !== 'pending').length

  return (
    <svg className="helix" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${answered} of ${n} questions answered, ${matched} base pairs matched`}>
      {strands.map((p, i) => (
        <path key={i} d={p.d} className={`helix__strand${p.front ? ' is-front' : ''}`} />
      ))}
      {states.map((st, i) => {
        const x = xAt(i)
        const t = theta(x)
        const y1 = CY + AMP * Math.sin(t)
        const y2 = CY - AMP * Math.sin(t)
        const [b1, b2] = PAIRS[i % PAIRS.length]
        const isNow = i === current && st === 'pending'
        return (
          <g key={i} className={`rung rung--${st}${isNow ? ' is-now' : ''}`} style={{ '--c1': BASE_COLOUR[b1], '--c2': BASE_COLOUR[b2] }}>
            <line className="rung__bar" x1={x} y1={y1} x2={x} y2={y2} pathLength="1" />
            <circle className="rung__dot rung__dot--1" cx={x} cy={y1} r="7.5" />
            <circle className="rung__dot rung__dot--2" cx={x} cy={y2} r="7.5" />
          </g>
        )
      })}
    </svg>
  )
}

/* ───────── the quiz ───────── */

const Quiz = React.forwardRef(function Quiz({ onJump }, ref) {
  const [deck, setDeck] = useState(makeDeck)
  const [phase, setPhase] = useState('intro') // intro | play | done
  const [index, setIndex] = useState(0)
  const [answers, setAnswers] = useState([]) // chosen option id per answered question

  const n = deck.length
  const picked = answers[index] ?? null
  const answered = picked !== null

  const states = deck.map((q, i) => (answers[i] == null ? 'pending' : answers[i] === q.answer ? 'match' : 'mismatch'))
  const score = states.filter((s) => s === 'match').length

  // Focus follows the view, so keyboard and screen-reader users land on the new content (without scrolling the page).
  const headRefs = useRef({})
  const nextRef = useRef(null)
  const first = useRef(true)
  const viewKey = phase === 'intro' ? 'intro' : phase === 'done' ? 'done' : `q${index}`
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    headRefs.current[viewKey]?.focus({ preventScroll: true })
  }, [viewKey])
  useEffect(() => {
    if (answered) nextRef.current?.focus({ preventScroll: true })
  }, [answered, index])

  const pick = useCallback(
    (id) => {
      if (phase !== 'play' || answers[index] != null) return
      setAnswers((a) => {
        const next = [...a]
        next[index] = id
        return next
      })
    },
    [phase, answers, index],
  )

  const next = () => {
    if (index + 1 < n) setIndex(index + 1)
    else setPhase('done')
  }

  const start = () => {
    setPhase('play')
    setIndex(0)
  }

  const retry = () => {
    setDeck(makeDeck())
    setAnswers([])
    setIndex(0)
    setPhase('play')
  }

  const onKeyDown = (e) => {
    if (phase !== 'play' || answered || e.metaKey || e.ctrlKey || e.altKey) return
    const i = Number(e.key) - 1
    const opt = deck[index].options[i]
    if (opt) {
      e.preventDefault()
      pick(opt.id)
    }
  }

  const missed = useMemo(() => {
    const seen = new Map()
    deck.forEach((q, i) => {
      if (states[i] === 'mismatch' && !seen.has(q.chapter)) seen.set(q.chapter, q.chapterLabel)
    })
    return [...seen]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deck, answers])

  const rating = ratingFor(score)
  const view = (key) => ({ 'data-on': viewKey === key, inert: viewKey === key ? undefined : '', 'aria-hidden': viewKey !== key })

  return (
    <section ref={ref} id="quiz" className="quiz" aria-label="Quiz" onKeyDown={onKeyDown}>
      <div className="quiz__wrap">
        <Helix states={states} current={phase === 'play' ? index : -1} />

        <div className="quiz__stack">
          {/* intro */}
          <div className="quiz__view" {...view('intro')}>
            <h2 className="quiz__title quiz__title--big" tabIndex={-1} ref={(el) => (headRefs.current.intro = el)}>
              {quiz.meta.title}
            </h2>
            <p className="quiz__lede">{quiz.meta.intro}</p>
            <div className="quiz__actions">
              <button type="button" className="story-btn story-btn--primary" onClick={start}>
                {quiz.meta.startLabel}
              </button>
            </div>
          </div>

          {/* one view per question */}
          {deck.map((q, qi) => {
            const key = `q${qi}`
            const chosen = answers[qi] ?? null
            const done = chosen !== null
            const right = chosen === q.answer
            const correctText = q.options.find((o) => o.id === q.answer)?.text
            return (
              <div className="quiz__view" key={q.id} {...view(key)}>
                <p className="quiz__count">
                  Question {qi + 1} of {n}
                </p>
                <h2 className="quiz__title" tabIndex={-1} ref={(el) => (headRefs.current[key] = el)}>
                  {q.question}
                </h2>

                <div className="quiz__options" role="group" aria-label="Answers">
                  {q.options.map((o, oi) => {
                    const base = BASES[oi]
                    const state = !done ? 'idle' : o.id === q.answer ? 'right' : o.id === chosen ? 'wrong' : 'rest'
                    return (
                      <button
                        key={o.id}
                        type="button"
                        className="opt"
                        data-state={state}
                        style={{ '--c': BASE_COLOUR[base] }}
                        aria-disabled={done}
                        onClick={() => pick(o.id)}
                      >
                        <span className="opt__base" aria-hidden="true">
                          {base}
                        </span>
                        <span className="opt__text">{o.text}</span>
                        {state === 'right' && <span className="opt__flag">Correct answer</span>}
                        {state === 'wrong' && <span className="opt__flag">Your answer</span>}
                      </button>
                    )
                  })}
                </div>

                <div className="quiz__feedback" data-shown={done} data-result={done ? (right ? 'match' : 'mismatch') : undefined} aria-live="polite">
                  {done && (
                    <>
                      <p className="quiz__verdict">{right ? 'Pair matched.' : `Mismatch. The answer is: ${correctText}`}</p>
                      <p className="quiz__why">{q.explanation}</p>
                      <div className="quiz__actions">
                        <button type="button" className="story-btn story-btn--primary" ref={qi === index ? nextRef : null} onClick={next}>
                          {qi + 1 < n ? quiz.meta.nextLabel : quiz.meta.finishLabel}
                        </button>
                        <button type="button" className="story-btn story-btn--secondary" onClick={() => onJump?.(q.chapter)}>
                          Revisit {q.chapterLabel}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )
          })}

          {/* results */}
          <div className="quiz__view" {...view('done')}>
            <p className="quiz__score" aria-label={`${score} of ${n} correct`}>
              <span className="quiz__score-num">{score}</span>
              <span className="quiz__score-of">of {n} pairs matched</span>
            </p>
            <h2 className="quiz__title quiz__title--big" tabIndex={-1} ref={(el) => (headRefs.current.done = el)}>
              {rating.title}
            </h2>
            <p className="quiz__lede">{rating.message}</p>

            {missed.length > 0 && (
              <div className="quiz__chips" role="group" aria-label="Chapters to revisit">
                {missed.map(([id, label]) => (
                  <button key={id} type="button" className="story-btn story-btn--secondary quiz__chip" onClick={() => onJump?.(id)}>
                    Revisit {label}
                  </button>
                ))}
              </div>
            )}

            <div className="quiz__actions">
              <button type="button" className="story-btn story-btn--primary" onClick={retry}>
                {quiz.meta.retryLabel}
              </button>
              <button type="button" className="story-btn story-btn--secondary" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
                {quiz.meta.topLabel}
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
})

export default Quiz
