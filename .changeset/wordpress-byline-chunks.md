---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes WordPress imports creating duplicate guest authors across content batches and when restarting a partial import after an interruption. Restart with the same content and author mappings to reuse authors from skipped posts. Existing duplicates are unchanged.
