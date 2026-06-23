<!-- 
  SUBSTACK PUBLISH METADATA
  =========================
  Title: The Appacadabra Chronicles, Part 7: The Legal Department -- Navigating Compliance with Claude Opus
  Subtitle: How a privacy-first architecture shrinks the compliance surface, and why reading every AI-drafted legal line is non-negotiable.
  Source: docs/blog/blog_expanded_parts4_6.md
  Generated: 2026-06-22
-->

## Part 7: The Legal Department. Navigating Compliance with Claude Opus

The financial model was sound. The Mana system built in Part 6 had passed every scenario the model could generate. The product worked, had a price, and had been built for scale. What it didn't yet have was a legal foundation, and an app without one is a single Play Store policy review away from disappearing entirely.

Paul Graham, in his essay *"Do Things That Don't Scale,"* argues that early-stage founders should do uncomfortable, manual things precisely because they don't scale. The point: before you can automate something, you have to understand it well enough to know what you're automating.

Legal compliance is the domain where this lesson stings hardest. Most startup founders don't understand GDPR well enough to know what they're complying with. They outsource it entirely to attorneys, receive documents they barely read, and sign off, hoping the lawyer caught everything. It's expensive, and it's also a kind of epistemic surrender: you've created a legal foundation for your company without really understanding what it says.

I wanted to do this differently.

### The Regulatory Landscape for a Privacy-First AI App

Appacadabra was designed from the ground up with a deliberately local-first, privacy-first architecture. Understanding what that means in practice is essential to understanding what the Legal department actually needed to document:

- **Spell descriptions** (the user's text prompts) are sent to the **Google Gemini API** for processing. That's the only external data transmission.
- **All generated content** (the spells, version history, preferences) is stored **exclusively on the user's device**. We do not maintain servers with personal user data.
- **Device permissions** (contacts, camera, microphone, location, health data via Health Connect) are accessed only when a generated spell explicitly requires them, with no transmission to our servers.
- **Anonymous analytics** may be used to understand aggregate usage patterns, but no personally identifiable data is collected or stored by Appacadabra.

This architecture was a deliberate choice, not just for user trust, but because it dramatically simplifies the compliance surface. When you don't collect data, you don't have most of the GDPR problems. When everything runs locally, you don't have a breach surface.

That said, the legal obligations that *do* exist are non-trivial:

**GDPR** still applies to the spell description data transmitted to the Gemini API; that transmission constitutes processing, and disclosure is required.

**LGPD** requires equivalent disclosures for Brazilian users, with specific provisions around the legal basis for the Gemini API processing.

**COPPA** mandates that we do not knowingly serve users under 13, a requirement that applies even without data collection.

And then there are the AI-specific questions that existing regulatory frameworks are still catching up to: who owns AI-generated content produced from a user's prompt? What obligations arise from the transmission of user descriptions to a third-party model API?

The legal document set I needed was precise, not generic.

### Claude Opus as Legal Counsel

I turned to **Claude Opus** (via Claude Code) as my primary legal drafting tool. The LegalTech industry has produced compelling evidence that LLMs can navigate dense legal text with high fidelity. Companies like Harvey AI (backed by Sequoia and General Catalyst) and Ironclad have built enterprise-grade products on exactly this capability.

A key advantage of using Claude Opus through Claude Code for legal work: the agent already had full context of the codebase (every data flow, every third-party integration, every permission request). I didn't need to manually describe what the app does. The agent *already knew*, because it had been working alongside me building it.

My approach was structured and specific. I did not ask the AI to "write a privacy policy." I provided:

1. A precise technical description of every data flow: what leaves the device (only spell descriptions, to the Gemini API), what stays local (all generated content, preferences, version history), and what permissions are requested and under what conditions
2. The list of third-party services: Google Gemini API, Google Play Billing, Google Health Connect, Firebase (anonymous analytics only), Expo push notifications
3. The target jurisdictions (EU, Brazil, US, and global)
4. The specific legal bases for the one external processing operation: the Gemini API transmission

Claude Opus produced draft documents that mapped precisely to the product's actual architecture. Not a generic privacy policy template, but one that accurately reflected the local-first model. GDPR Article 13 disclosures scoped specifically to the Gemini API processing. LGPD-aligned basis declarations. COPPA age-restriction acknowledgments.

I read every single line.

### The Validation Protocol

This is not a detail to skim over. Reading a legal document you didn't write, in a domain you don't formally understand, is an uncomfortable exercise. It is the same situation the Strategy Department first taught me to recognize in Part 1: the **Validation Gap**. *What is the largest decision in this choice that I cannot evaluate myself?* For a Privacy Policy, the answer is "almost everything beyond the first paragraph." The protocol below is what I built to operate inside that gap without surrendering judgment.

1. **Factual Accuracy**: Every clause describing what Appacadabra does must match the actual technical reality of the product. If the document says "we do not share your data with third parties for marketing purposes," I need to verify that is actually true in every data flow.
2. **Reference Checking**: Any specific regulatory citation (Article 13, LGPD Article 7, COPPA Section 312) should be cross-referenced against the actual legislative text to ensure it's cited accurately.
3. **Omission Hunting**: What is the document *not* saying? Gaps in a Privacy Policy are often more legally dangerous than incorrect statements. I would explicitly ask the AI: *"What disclosures might be missing from this document given the technical description I provided?"*
4. **Contradiction Detection**: Legal documents often contain internal tensions. I would ask the AI to evaluate the document for internal consistency.

This protocol doesn't replace a qualified attorney. But it transforms the engagement with legal documents from passive acceptance to active evaluation, and it makes a qualified attorney's time dramatically more efficient if you do eventually engage one.

**[INSERT IMAGE: compliance_flow_part7.png]**

### The Legal Agent and Its Skills

The **Legal Agent** became the compliance backbone of the company.

Its Skills included:

- A **Feature Compliance Audit Skill** (`/compliance-check`): given a description of a new product feature, generate a compliance checklist. What new data processing does this introduce? What disclosures might need updating? What consent mechanisms are required? Evaluated against GDPR, LGPD, and COPPA obligations specific to Appacadabra's privacy-first architecture
- A **Policy Diff Skill** (`/policy-diff`): given a proposed change to the Privacy Policy or Terms of Service, generate a plain-language summary of what changed, flag whether user re-consent is required, and identify any internal contradictions introduced by the change

The human role in this department is the most consequential of any in the series. Claude Opus surfaced the draft, identified the regulatory scope, and flagged potential omissions when asked. I set the technical inputs, ran the four-step Validation Protocol against every clause, and signed off. No part of that sign-off was delegable. The Validation Gap from Part 1 is at its sharpest in legal work: the AI can draft with precision, but the founder holds the liability.

The Legal Agent meant that as Appacadabra evolved -- as new AI models were integrated, as new features were built -- the compliance layer evolved with it, not months later when a lawyer finally reviewed it.

### A Note on Departments Not Yet Built

At this point in the series, it's worth acknowledging something explicitly: not every company department needed to exist yet.

Customer Service, Sales, PR, Investor Relations, HR, Accounting: none of these departments were created. Not because they're unimportant, but because **the app is only now going to production**. The principle I applied was the same one that drove the entire project: build what the company actually needs at this stage, not what a fully mature company would need at scale.

The agent-and-plugin architecture means that when these departments do become necessary -- when the first user emails with a support question, when the first partnership opportunity emerges -- I will build the agent for that department the same way I built the others: starting with the specific context of Appacadabra and encoding the first manual interactions as Skills. The pattern scales.

*With strategy, design, UX, engineering, QA, finance, and legal in place, Appacadabra existed: on paper, in code, validated, financed, and in compliance. But a company that exists only in code is not a company. It's a repository. In Part 8, we turn to making the company legible: Data Analytics and DevOps.*
