# LLM Weaknesses Summary (from browser automation debugging)

## 1. Analysis Paralysis / Thinking Loops
- Narrates plans ("I'll do X, then Y") repeatedly without executing tool calls
- Spins on "Wait, I'll just do it" / "Actually, I'll just do it" / "One more check"
- 300s stuck on submit button despite knowing exactly what to do

## 2. Stale Context Dependency
- Re-reads old `browser_observe` output to find element IDs instead of calling fresh observe
- Assumes SOM IDs persist across observations (they reset every call)
- Tries to "figure everything out" before acting rather than act → observe → act

## 3. Missing Browser Fundamentals
- Doesn't know `browser_observe` only captures viewport (not full DOM)
- Doesn't scroll when element missing from observe but present in DOM
- Doesn't know pages have finite scroll height
- Doesn't use `browser_type` with `submit: true` for form submission (prefers button hunt)

## 4. No Spatial Awareness
- No concept of scroll position, viewport bounds, or "below the fold"
- Fixed by adding `meta` object (scroll, maxScroll, scrollPercent, atBottom)

## 5. No Session Hygiene
- Never calls `browser_terminate` on task completion
- Leaves browser sessions running

## 6. Present-Moment Execution Deficit
- Treats past observations as current truth
- Treats future plans as executed reality
- Only tool calls change state — but it thinks narrating = acting

---

## Root Cause
The model optimizes for **reasoning completeness** over **action completion**. It wants the full plan verified in its head before moving, but browser automation requires acting with partial info, then correcting.