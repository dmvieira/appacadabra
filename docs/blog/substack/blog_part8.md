<!--
  SUBSTACK PUBLISH METADATA
  =========================
  Title: The Appacadabra Chronicles, Part 8: Data Analytics & DevOps. Cloud Infrastructure Friction
  Subtitle: How a solo founder built an intelligence function from Firebase data -- and where one specific integration still needs human eyes.
  Source: docs/blog/blog_expanded_parts7_9.md (Part 8)
  Generated: 2026-07-10
-->

Seven departments. A company that existed on paper, in code, validated by automated tests, modeled financially, and grounded in legal documents. Appacadabra was real, but invisible to itself. No one was watching what was happening inside it. No one was measuring whether the decisions made in the first seven departments were actually working in practice. That was about to change.

There is a concept in reliability engineering called **observability**: the degree to which you can infer the internal state of a system from its external outputs. In traditional software operations, observability is achieved through three pillars: logs, metrics, and traces. Building this infrastructure -- the agents, dashboards, alerting pipelines, and on-call runbooks -- is itself a significant engineering discipline.

In the modern AI-first enterprise, observability has a fourth dimension: **the AI layer that interprets the first three.**

This is where Part 8 begins: not with code, but with data. Specifically, the question of how a solo founder, with no dedicated data analyst and no BI platform budget, could understand what was actually happening inside their product.

### The AIOps Revolution (and Why It Matters for Startups)

"AIOps" (using artificial intelligence to augment or automate IT operations) has been a Gartner-tracked trend since 2017. In enterprise contexts, it typically means AI parsing log streams to detect anomalies, correlating incidents across distributed services, and auto-remediating known failure patterns. Tools like **Datadog AI, Dynatrace Davis, and Google Cloud's Operations Suite** represent the mature end of this spectrum.

For a solo founder, the relevant insight is simpler: **AI can turn raw data into understanding in a way that used to require a dedicated analyst**.

Appacadabra's entire backend runs on **Firebase**: Firestore for the primary database, Firebase Authentication for user identity, Cloud Functions for server-side logic, and Firebase Analytics for behavioral data. This is an excellent, scalable stack. It is also a stack that generates enormous amounts of data that, without analysis, is just noise.

### Google Cloud MCP as My Data Analyst

I deployed **Google Cloud MCP (Model Context Protocol)** to give AI agents direct, contextual access to our Firebase data streams. The MCP layer is the key architectural piece here; it's not a query interface where you write SQL and get rows back. It's a semantic layer where you describe what you want to understand, and the AI decides what data to pull, how to aggregate it, and how to present the insight.

What this produced:

**Usage Pattern Analysis**: I could ask "Which features are driving the most mana consumption, and which user cohorts are consuming mana fastest?" and receive not a table, but a narrative with the relevant segments already identified.

**Retention Analysis**: "What is the Day-7 retention rate for users who completed the onboarding flow vs. users who skipped it?" A classic product analytics question that, in a traditional setup, requires a data engineer to write the cohort query, a BI analyst to build the chart, and a product manager to interpret it. With the MCP layer, one question produced one answer.

**Pitch Deck Material**: This one surprised me. I asked the Analytics Agent to summarize our growth trajectory for an investor context. It produced a crisp, data-backed narrative -- the kind of thing that typically takes a founder an afternoon to write -- in minutes, cross-referencing our Firebase metrics against publicly available benchmarks for comparable apps.

The Analytics Agent had become my intelligence function: always aware of what was happening in the product, always able to interpret it, always ready to translate data into decision. And critically, I was still the one asking the questions and judging the answers. The agent surfaced patterns; I decided which patterns mattered enough to change the product over.

**[INSERT IMAGE: analytics_pipeline_part8.png]**

### The Analytics Agent and Its Skills

The **Analytics Agent's Skills** included:

- A **Metrics Skill** (`/metrics`): query usage patterns and spend logs to produce a structured product metrics report -- active users, spell creation volume, failure rates, mana consumption breakdown, and revenue signals -- for any requested period
- A **Cohort Analysis Skill** (`/cohort-analysis`): segment users by behavior (power users, paying users, churned, new) and analyze engagement depth, mana consumption, and conversion timing per cohort using retention data pulled via MCP
- An **Anomaly Detection Skill** (`/anomaly-detect`): compare the last 24h of Firebase and Cloud Function data against a 7-day rolling baseline, flag deviations exceeding 2 standard deviations, and assign severity levels with root cause hypotheses
- An **Investor Summary Skill** (`/investor-summary`): pull current metrics and produce a structured investor-facing narrative -- growth trajectory, retention signals, unit economics, and market benchmarks -- ready for a pitch context

### Where the Constellation Frays: Crashlytics and the MCP Gap

Here is the honest part of this chapter, and I think it's the most important one to get right.

Most of the Analytics constellation worked. Firebase Analytics events, Cloud Function logs, Firestore queries -- all of it flows through the MCP layer cleanly. When I asked the Analytics Agent about usage patterns, retention curves, or anomalies in spell creation volume, I got answers. The intelligence function this department was supposed to build? It built it.

The gap was specific: **Crashlytics**. Not Crashlytics as a concept, and not crashes as events -- users generate crashes, the Crashlytics dashboard receives them, and the app has full crash reporting in production. The gap is operational: when a crash report needs investigation, I still open the Firebase Console myself. The Analytics Agent cannot pull Crashlytics data fluidly via MCP the way it pulls Firebase Analytics or Firestore. The loop stays open at exactly the moment you most want it closed -- when something broke and you need to understand why.

The reason is structural. Configuring Crashlytics in an Android release build involves a combinatorial environment problem: dependency conflicts between libraries can produce silent failures that only surface in production, with no error signal for the agent to reason from. I found the conflict; the agent explained it. That division of labor -- founder locates the problem, agent articulates the fix -- is the right mental model for this kind of issue.

In all of these cases, **my developer intuition was not just helpful; it was the only thing that could locate the problem**. The agent could explain what the error meant once I found it. It could not find the error.

There are integrations where the constellation still needs the founder's eyes. Crashlytics is one, and the pattern is worth naming: when a tool's data doesn't have a first-class MCP surface, the loop stays open. That isn't a failure of the department -- it's a boundary condition. Know where your specific stack has those gaps before you plan your monitoring strategy.

*The product was running, observable, and understood. But observed in production by whom? Part 9 addresses the final mile of getting an app into users' hands, and why it is an entirely separate discipline from building it.*
