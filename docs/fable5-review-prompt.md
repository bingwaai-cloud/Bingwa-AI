# Fable 5 — Project Review Prompt (Bingwa / Gezi)

> HOW TO USE: Attach these files to the chat before sending this prompt:
> `CLAUDE.md` and every file in `.claude/rules/` (security, multi-tenant, nlp-parser,
> uganda-specific, api-design, error-handling, testing, scalability, deployment).
> Then paste everything below.

---

## ROLE
You are a principal-level technical and product reviewer (architecture, security, data modelling, NLP, and product/UX design). I am the founder. Review my project and return an **assessment with prioritised recommendations only**. Do **NOT** write code, build features, or produce implementation. Judgment and direction, not artifacts.

## EFFICIENCY CONSTRAINT (important)
Be concise and high-signal. No preamble, no restating my files back to me, no filler. Spend your effort on decisions and trade-offs, not description. Use short prose and tight bullets. If a section has nothing material to flag, say "No major issues" and move on. Target depth over length.

## CONTEXT (read the attached files for full detail)
The attached `CLAUDE.md` and `.claude/rules/*` define the project. Key facts and **fixed decisions** to treat as constraints (do not re-litigate the vendor choices, but flag risks):

- **Product:** A WhatsApp-first, AI-powered ERP for SMBs in Uganda / East Africa. Natural-language interface; users type as they speak (English + Luganda + Swahili, mixed, with slang and shorthand). Modules: Sales, Inventory, Purchases, Receipts, Suppliers, Customers, Reports, Subscriptions.
- **WhatsApp delivery — DECIDED:** via **360dialog Premium** (BSP, single shared bot number, multi-tenant resolved by sender phone). Assume this; assess implications, not alternatives.
- **Payments — DECIDED:** via **Flutterwave** (aggregator for MTN MoMo + Airtel Money). Starting on an **Individual account**, migrating to a **Business account** later. Assume this; flag the migration and compliance risks.
- **Roadmap expansion to assess:** a **world-class web application**, an in-app/web **POS**, and **URA EFRIS** (Uganda e-invoicing/fiscal receipting) integration.
- **Strategic arc — assess the architecture against this:** start with small businesses, but evolve into a **full, enterprise-grade ERP**. The system must be **web-first with WhatsApp as one channel/interface** — explicitly so that **business data is never trapped or lost inside WhatsApp chats**; WhatsApp is an input/output surface, the web platform and database are the system of record.
- **Naming:** The company is legally registered as **GEZI INTELLIGENT TECHNOLOGIES LIMITED** (the name "Bingwa" was unavailable in Uganda). The product is currently branded **Bingwa**. I'm undecided whether to rebrand the product to **Gezi AI** or keep Bingwa under the Gezi entity.

## WHAT TO ASSESS — return findings under these headings

1. **Architecture & system-of-record integrity.** Does the current design genuinely make the web platform + database the system of record with WhatsApp as a thin channel adapter, or is logic/state leaking into the WhatsApp layer? Channel-agnostic core, the `source` field, multi-channel (WhatsApp/web/mobile/Telegram) readiness. Identify the single biggest architectural risk to the "data never lost in chat" goal.

2. **Data model & multi-tenancy at ERP scale.** Schema-per-tenant vs row-level as it grows from SMB to enterprise ERP. Immutability/audit/soft-delete rules. Where the current model will strain when companies (not just shops) onboard — accounting, multi-user roles, branches/locations, double-entry needs.

3. **NLP / conversational quality — make this a priority section.** How robust is the parser at handling **Ugandan slang, heavily shortened words, typos, code-mixed English/Luganda/Swahili, and informal number/price shorthand** in real WhatsApp messages? Assess the price-normalization and ambiguity rules. Recommend concrete strategies (not code) to make understanding feel effortless to the user: handling abbreviations, fuzzy item matching, context/memory, confidence thresholds, when to ask vs assume, learning per-user vocabulary over time. Call out where it will frustrate a real shop owner.

4. **Web application — design & UX, treat as priority.** I want the webapp to be **world-class**. Give specific, opinionated direction on **visual design, graphics, and UX**: design language and aesthetic appropriate for African SMBs through to enterprise, information architecture, dashboard/data-visualization approach, component system, responsiveness, accessibility, onboarding flow, POS screen UX, and how the web experience should feel premium and trustworthy (this is financial data). Recommend a design system / UI stack direction and visual references to aim for. Be concrete about what "world-class" looks like here.

5. **POS + URA EFRIS.** Assess the plan to add POS and EFRIS fiscal invoicing. Compliance and integration risks, where EFRIS should sit in the architecture, offline/connectivity realities in Uganda, thermal receipt vs fiscal invoice distinction, and how POS data flows into the same system of record.

6. **Payments (Flutterwave) & WhatsApp (360dialog).** Given the fixed vendor choices: integration architecture, idempotency, reconciliation, the Individual→Business account migration path and its risks, subscription/billing handling, and the multi-tenant implications of a single shared 360dialog number.

7. **Security, reliability, scalability.** Stress-test the existing rules against enterprise expectations. Biggest gaps.

8. **Product & go-to-market strategy.** Honest read on the SMB→enterprise arc, sequencing, what to build first, what to defer, and the riskiest assumption in the whole plan.

9. **Naming recommendation.** Give a clear recommendation: keep **Bingwa** as product under the **Gezi** entity, rebrand to **Gezi AI**, or a house-of-brands. Weigh branding, domains, code/namespace impact, and East African market resonance. Pick one and justify briefly.

## OUTPUT FORMAT
- A 5-line executive summary (the most important things, ranked).
- Then the 9 sections above, each with: **what's good**, **what's at risk**, **specific recommendations**.
- End with a **prioritised action list** (P0/P1/P2) I can hand to my build team.
- No code. Recommendations and rationale only.
