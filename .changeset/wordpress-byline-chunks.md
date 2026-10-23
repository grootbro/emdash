---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes WordPress imports creating duplicate guest authors across content batches and when restarting a partial import after an interruption. Restart with the same source and author mappings to reuse authors from skipped posts. Guest-author recovery verifies the recorded source site and exact WordPress login, so a skipped slug collision cannot assign new posts to another author. Imports started before this update have no recorded source identity and may create a new guest author on restart. Existing duplicates are unchanged.
