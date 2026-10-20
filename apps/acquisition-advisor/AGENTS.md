# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## Product-specific decisions

- Visual reference: `https://mkrkmbp7pg.coze.site` (single-screen immersive aesthetic advisor, desktop and 390×844 mobile states captured on 2026-08-10).
- Product identity: 时代之美「AI获客顾问·小美」；consumer-facing project knowledge explanation and lead consultation.
- Medical boundary: never diagnose, judge suitability, prescribe treatment or medication, or guarantee effects. Escalate those questions to human consultants/doctors.
- Runtime: local-only prototype. The browser calls `/api/public/acquisition-chat`; model credentials and knowledge retrieval stay in the existing local server and must never be embedded in client code.
- Conversation behavior: use progressive real-consultant pacing—answer first, 2–4 short sentences, at most one useful question, no fixed “可以的/好的呢/嗯呢” opening, and no repeated question for known project/doctor/budget/time preferences.
- Message presentation: one assistant turn must be delivered as separate short chat bubbles (normally 2–4), not one paragraph with line breaks. Only the first bubble shows the assistant label; citations, handover details, and lead capture belong to the final bubble.
- Citation media preview: a citation may open an in-page image/PDF preview only when its exact source is present in the approved public-media manifest. Never expose filesystem paths, customer cases, before/after material, chat records, or internal documents through a preview link.
- Conversion timing: do not show the lead-capture card after an initial knowledge question. Offer human assistance only for an explicit human/appointment/current-price-or-schedule verification request, a safety handoff, or a qualified multi-turn decision stage.
- Lead capture: validate only the 11-digit mainland China mobile format. After the customer grants service-contact consent, save the lead immediately, mark the phone as pending manual verification, and let the sales consultant verify it during the callback. Do not send or request an SMS OTP. The server may run the hospital repeat-record lookup after capture, but that lookup does not prove phone ownership.
- Tone boundary: default to respectful “您”; do not imitate typos or default to “宝宝/亲爱的/美女”, and do not copy remote diagnosis, outcome promises, unverified prices, or overconfident recovery claims from human chat samples.

- Composer continuity: sending must retain input focus and allow drafting the next message while a reply is pending; disable only submission during an in-flight request. Reply completion must not steal focus from other controls. Preserve Chinese IME composition.

- Composer attachments: uploaded images stay inside the same rounded composer as removable thumbnails above the text field; uploading alone never creates a chat message. The thumbnails move into the sent user bubble with the question, and up to three attachments are allowed to match the chat API limit.

- Reply reconciliation: a server-history reply and its local short presentation segments are the same assistant turn. During polling, replace the canonical row with the segments; never flash or retain both representations.

- Direct chat contact submission: when the visitor sends their mobile number (alone or introduced as their phone/contact), save after format validation without OTP or a second form. Show a receipt only after durable save; failures must say it was not saved. This is for the current service, never marketing permission. Do not treat examples, denied contact requests, or unrelated long numeric identifiers as contact submissions.
