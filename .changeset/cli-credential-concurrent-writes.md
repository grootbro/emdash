---
"emdash": patch
---

Fixes concurrent CLI sign-ins, token refreshes, and sign-outs overwriting each other's saved credentials. Credential updates are serialized across processes and readers see a complete file during each update.
