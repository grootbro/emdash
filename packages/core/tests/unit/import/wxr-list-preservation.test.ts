import { describe, expect, it } from "vitest";

import { parseWxrString } from "../../../src/cli/wxr/parser.js";
import { portableTextToProsemirror } from "../../../src/content/converters/portable-text-to-prosemirror.js";
import { prosemirrorToPortableText } from "../../../src/content/converters/prosemirror-to-portable-text.js";
import type { PortableTextTextBlock } from "../../../src/content/converters/types.js";
import { wxrPostToNormalizedItem } from "../../../src/import/sources/wxr.js";

describe("WXR list preservation", () => {
	it("imports mixed lists once and retains numbered starts across an editor round trip", async () => {
		const content = `<!-- wp:list -->
<ul><li>A<ol start="3"><li>B<ul><li>C</li></ul></li><li>D</li></ol></li><li>E</li></ul>
<!-- /wp:list -->
<!-- wp:list {"ordered":true,"start":8} -->
<ol start="8"><li>F</li><li>G</li></ol>
<!-- /wp:list -->`;
		const wxr = `<?xml version="1.0"?><rss xmlns:wp="http://wordpress.org/export/1.2/" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Lists</title><link>https://example.com</link><item><title>Mixed</title><wp:post_id>1</wp:post_id><wp:post_name>mixed</wp:post_name><wp:post_type>post</wp:post_type><wp:status>draft</wp:status><content:encoded><![CDATA[${content}]]></content:encoded></item></channel></rss>`;
		const parsed = await parseWxrString(wxr);
		expect(parsed.posts).toHaveLength(1);
		const item = wxrPostToNormalizedItem(parsed.posts[0]!, new Map());
		const imported = item.content as PortableTextTextBlock[];
		const outline = (blocks: PortableTextTextBlock[]) =>
			blocks.map((block) => [
				block.children.map((span) => span.text).join(""),
				block.listItem,
				block.level,
			]);
		expect(outline(imported)).toEqual([
			["A", "bullet", 1],
			["B", "number", 2],
			["C", "bullet", 3],
			["D", "number", 2],
			["E", "bullet", 1],
			["F", "number", 1],
			["G", "number", 1],
		]);
		expect(imported[1]).toMatchObject({ listStart: 3, listId: expect.any(String) });
		expect(imported[3]).toMatchObject({ listStart: 3, listId: imported[1]!.listId });
		expect(imported[5]).toMatchObject({ listStart: 8, listId: expect.any(String) });
		expect(imported[6]).toMatchObject({ listStart: 8, listId: imported[5]!.listId });
		expect(imported[1]!.listId).not.toBe(imported[5]!.listId);
		const saved = prosemirrorToPortableText(
			portableTextToProsemirror(imported),
		) as PortableTextTextBlock[];
		expect(outline(saved)).toEqual(outline(imported));
		for (const index of [1, 3, 5, 6]) {
			expect(saved[index]).toMatchObject({
				listStart: imported[index]!.listStart,
				listId: imported[index]!.listId,
			});
		}
	});
});
