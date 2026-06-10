<!--
  SUBSTACK PUBLISH METADATA
  =========================
  Title: The Engineering & Localization Teams. A Polyglot Tech Stack
  Subtitle: Why no single AI model could ship Appacadabra -- and how Mixture-of-Experts routing made a polyglot stack tractable for a solo founder.
  Source: docs/blog/blog_expanded_parts4_6.md (Part 4)
  Generated: 2026-06-10
-->

Strategy had defined the product. Design had given it identity. UX had validated its flows in a browser, screen by screen, before a single line of native code was written. Three departments had produced documents, mockups, and constraints, but not a working app. That changes in Part 4.

In 1986, Frederick Brooks published an essay that would become one of the most cited texts in software engineering: *"No Silver Bullet: Essence and Accidents of Software Engineering."* His central thesis: there is no single technique, tool, or methodology that will dramatically improve programmer productivity across all dimensions. The essence of software (its complexity, changeability, invisibility, conformity) resists any single solution.

Nearly forty years later, I believe AI has changed the terms of this argument. But Brooks's deeper point still holds: **the dangerous trap is believing you've found the silver bullet.** The moment you start routing every engineering challenge through a single AI model, you've already lost.

### The Mixture of Experts Problem

In modern machine learning, there's an architectural pattern called **Mixture of Experts (MoE)**. The intuition is elegant: instead of training one massive model that must be good at everything, you train several specialized models and learn a routing mechanism that sends each input to the model best suited to handle it. Models like Google's Gemini are widely believed to use MoE architectures internally.

I applied this concept to my Engineering Department.

The codebase of Appacadabra is genuinely polyglot. Not in the "we use two languages" sense, but in the "each layer of the stack has meaningfully different complexity profiles" sense:

- **React Native / Expo** for the cross-platform app shell, where component composition and JavaScript async patterns dominate
- **Kotlin and Jetpack Compose** for the native Android modules, where the Android lifecycle, coroutine scopes, and hardware permission flows introduce platform-specific edge cases
- **Firebase Cloud Functions** in TypeScript for the backend, with its own async execution model, cold start constraints, and IAM permission matrix
- **Google Cloud infrastructure** for the production data pipeline, including Pub/Sub, Secret Manager, and Cloud Run

No single AI model navigates all of these with equal depth. I learned this through painful experience early in the project, and the solution was to route deliberately.

**Claude Opus** (accessed through Claude Code, which served as the development environment throughout the project) was the primary engine across the stack. Claude Code is the tool, the agentic coding interface that maintains full codebase context, proposes changes, and runs commands. Claude Opus is the model powering it, and its grasp of component patterns, TypeScript generics, Firebase architecture, and context propagation is, at time of writing, the strongest available for this kind of full-stack work. It was my senior engineer across the board.

**Gemini** was brought in for Android-native depth and broad research tasks, accessed directly from inside **VS Code** through the official Gemini extension rather than through Claude Code. When I needed to understand how Android's ViewModel lifecycle interacts with Jetpack Compose recomposition, or why a specific hardware permission was silently failing on API 34, Gemini's massive context window and Google's institutional knowledge of Android architecture allowed me to paste entire SDK documentation sections alongside the failing code and receive coherent, targeted analysis. Different IDE, different model, same project -- used for the slice of work where it had a real edge.

**GPT OSS 120B** had a specific and narrow role: bulk localization. It was reached through an **OpenRouter MCP server** wired into Claude Code, so the Engineering Agent could dispatch translation jobs to it without me ever leaving the harness. As an open-source model optimized for cost efficiency at scale, it was the right tool for running translation jobs across hundreds of UI strings -- tasks where correctness-by-pattern matters more than deep contextual reasoning, and where running thousands of inferences at low cost is the actual constraint. The MCP layer that made this possible is detailed later in the series; for now, the relevant point is that an external model became reachable as if it were just another internal tool.

The Engineering Agent's routing layer became one of the most valuable assets in the project: a configuration that would receive a task, classify it by domain, and route it to the appropriate model. Not as magic, but as deliberate architecture.

This is **harness engineering** in its clearest form: not writing prompts, not fine-tuning a model, but designing the configuration layer that makes a collection of AI models behave like a coherent engineering department.

**[INSERT IMAGE: engineering_moe_routing.png]**

### Building the Engineering Agent

The **Engineering Agent** was the most complex agent in the system, and the most consequential.

Its **skills** included:

- A **code review skill** (`/code-review`) that evaluated generated code against our established architecture patterns (SOLID principles, our specific folder structure, our error handling conventions)
- A **dependency audit skill** (`/dependency-audit`) that cross-referenced any new package against our existing dependency tree to catch conflicts before they reached the build
- A **stack router skill** (`/stack-router`) that classified incoming engineering tasks and dispatched them to the appropriate AI model (Claude for full-stack TypeScript/React Native, Gemini for Android-native depth as human handoff, GPT OSS for bulk localization) with the right context injected for each
- A **test generation skill** (`/gen-tests`) that, given a new function or component, auto-generated Jest unit test scaffolding following the patterns in `lib/capabilities/__tests__/` and `lib/bridges/__tests__/`, with the mana-not-charged-on-failure path always exercised for any mana-related function
- A **schema validation skill** (`/validate-schema`) that validated Firestore document structures and SQLite schema migrations against our TypeScript type definitions

A design principle emerged here that would shape every subsequent agent: **skills must live inside agents, not float as standalone tools.** Early in the project, `/gen-tests` and `/code-review` existed as isolated commands I ran manually. The problem was me: I was the routing layer, remembering which tool to invoke, in what order, with what context. When those skills moved into the Engineering Agent, the agent could orchestrate them as a workflow: review the code, generate tests for the reviewed code, validate the schema the code touches. Skills composed into a pipeline; loose tools did not. The Conclusion returns to this principle, and its failure modes, in detail.

The cumulative effect: by the midpoint of the project, a significant portion of engineering scaffolding happened automatically. New features were generated already conforming to our architecture. Tests were generated alongside implementation. The Engineering Agent didn't just write code; it wrote code that *looked* like the rest of the codebase, because it had been trained on the codebase.

### The Localization Challenge: Democratizing the Enterprise Moat

Localization is one of the least discussed but most expensive engineering disciplines at scale. Netflix reportedly maintains localization infrastructure across 190+ countries and 30+ languages. Airbnb's localization team is a dedicated engineering function. The tooling, the translation management systems, the QA pipelines for verifying right-to-left layout behavior: it adds up to something that is genuinely inaccessible to a solo founder.

My **Localization Team** was staffed by **GPT OSS 120B**, an open-source model chosen specifically for its cost efficiency at scale. Running translation jobs across hundreds of strings in multiple languages simultaneously requires a model that can handle high-volume, repetitive inference cheaply, not one optimized for deep reasoning.

The workflow: extract all UI strings into a JSON key-value manifest, pass batches through the model with a system prompt that included Appacadabra's tone of voice guidelines, and regenerate the locale files. For languages I could partially evaluate (Spanish, Portuguese), I could spot-check directly. For languages I couldn't (Japanese, Korean, Arabic), I used a **reverse-prompting technique**: take the AI-translated string and ask a separate model to back-translate it into English, then evaluate whether the meaning and tone had survived the round trip.

**[INSERT IMAGE: localization_pipeline.png]**

This is not a perfect validation method. I want to be honest about that. Back-translation catches semantic errors but misses cultural connotation, humor register, and regional idiom. The honest acknowledgment: **this was a calculated acceptance of imperfect validation in exchange for global reach that would otherwise have been impossible.**

The **locale string skills** that emerged from this work are a pair of commands inside the Engineering Agent:

- **`/add-locale-string`** handles new keys. Given any UI string key added in English, it:
  - Generates translations across all 17 supported locales via a single OpenRouter API call, using a cheap multilingual model at fractions of a cent per run
  - Applies back-translation verification
  - Flags strings with confidence below a threshold
  - Inserts the translations into `lib/i18n.ts` with consistent formatting
- **`/update-locale-string`** handles updates. Given an existing key and a new English value, it:
  - Re-translates into all 17 locales
  - Replaces the values in both `lib/i18n.ts` and `website/js/translations.js`

What had been a multi-week project at a well-funded startup became a pipeline that ran in minutes, and changing a single word across 17 languages became a one-liner.

*The product could now be built, in any language, by a Mixture-of-Experts routing layer. What did not yet exist was any structured proof that the resulting code did what it was supposed to do. Code without tests is just hope written in TypeScript. In Part 5, we hand the engineering output to the only department whose job is to assume nothing: Quality Assurance.*
