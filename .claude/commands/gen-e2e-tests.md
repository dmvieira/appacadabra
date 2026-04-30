Generate a Maestro E2E test flow (.yaml) for the given user journey.

**User journey:** $ARGUMENTS

## Appacadabra Maestro conventions

- App ID: `ai.appacadabra.app`
- All UI labels are in Portuguese (the app's default language)
- Key accessibility labels: "Fazer Feitiço ✨", "Opções", "Voltar", "Cancelar", "Confirmar"
- Existing flows (for reference patterns): `.maestro/flows/01_home_sanity.yaml`, `02_report_bug.yaml`, `03_login_logout.yaml`
- Use `extendedWaitUntil` (timeout: 300000) for any screen that requires network/AI response
- Use `assertVisible` to verify state, not pixel checks
- Use `tapOn` with accessibility label strings, not IDs
- AI generation flows must use `extendedWaitUntil` — generation can take up to 3 minutes
- Follow naming: `NN_<flow_name>.yaml` where NN is the next sequence number after 03

## Flow structure template

```yaml
appId: ai.appacadabra.app
---
- launchApp:
    stopApp: false
- extendedWaitUntil:
    visible: "Fazer Feitiço ✨"
    timeout: 30000
# Your steps here
```

## Output

Generate the complete YAML file content for the described journey. Include:
- All setup steps (launch, wait for home)
- The core happy path steps
- At least one assertion after each major action
- A comment (`#`) before each logical section
- Suggested filename as a comment at the top

**Important**: Do NOT assert specific AI-generated text content — only assert that the output container is visible and in a "completed" or "ready" state.
