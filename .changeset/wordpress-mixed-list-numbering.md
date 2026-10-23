---
"@emdash-cms/gutenberg-to-portable-text": patch
---

Fixes WordPress Gutenberg imports duplicating items in mixed nested lists and losing the starting number of ordered lists. Nested items keep their original order and depth, and separate ordered lists retain their own numbering when opened and saved in the editor. Existing imported content is unchanged.
